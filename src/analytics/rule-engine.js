/**
 * Ad Automation Rule Engine
 *
 * 캠페인별 광고소재 ROAS 기준으로 자동 ON/OFF 실행.
 *
 * 규칙 평가 흐름:
 *  1. ad_automation_rules에서 활성 규칙 로드
 *  2. ad_performance에서 lookback_days 기간의 광고 소재별 ROAS 집계
 *  3. roas < roas_off → Meta API 통해 pause
 *     roas > roas_on  → Meta API 통해 enable (roas_on 설정 시)
 *  4. 실행 결과 ad_rule_log 저장 + Slack 알림
 */
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import notifier from '../utils/notifier.js';
import { krwFmt } from '../utils/format.js';
import { fetchStockInfo } from '../snowflake/client.js';

// 광고명에서 품번 추출 (예: DXSH5336N, DMTS71063)
const PART_CD_RE = /(?:^|_)([A-Z]{4}[A-Z0-9]{4,6})(?:_|$)/;

export class RuleEngine {
  constructor(metaClient) {
    this.meta = metaClient;
  }

  /** 모든 활성 규칙 실행 */
  async runAll() {
    const rules = db.prepare(
      `SELECT * FROM ad_automation_rules WHERE enabled = 1`
    ).all();

    if (rules.length === 0) {
      logger.info('RuleEngine: no active rules');
      return { executed: 0, actions: [] };
    }

    logger.info(`RuleEngine: evaluating ${rules.length} rules`);
    const allActions = [];

    for (const rule of rules) {
      try {
        const actions = await this._runRule(rule);
        allActions.push(...actions);
      } catch (err) {
        logger.error(`RuleEngine: rule ${rule.id} (${rule.name}) failed`, { error: err.message });
      }
    }

    return { executed: rules.length, actions: allActions };
  }

  /** 특정 규칙 단건 실행 */
  async runOne(ruleId) {
    const rule = db.prepare(`SELECT * FROM ad_automation_rules WHERE id = ?`).get(ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);
    return this._runRule(rule);
  }

  /** 규칙 평가 및 실행 */
  async _runRule(rule) {
    const lookback = Math.max(1, Math.min(rule.lookback_days || 7, 90));

    // ad_performance에서 캠페인의 광고별 집계 ROAS 조회
    const adStats = db.prepare(`
      SELECT
        ad_id,
        MAX(adset_id)         AS adset_id,
        ad_name,
        campaign_id,
        SUM(spend)            AS total_spend,
        SUM(conversion_value) AS total_value,
        CASE WHEN SUM(spend) > 0
          THEN SUM(conversion_value) / SUM(spend)
          ELSE 0
        END AS roas
      FROM ad_performance
      WHERE campaign_id = ?
        AND platform = ?
        AND date_start >= date('now', ? || ' days')
      GROUP BY ad_id
      HAVING total_spend >= ?
    `).all(rule.campaign_id, rule.platform, `-${lookback}`, rule.min_spend || 0);

    if (adStats.length === 0) {
      logger.info(`RuleEngine rule ${rule.id}: no ad data for campaign ${rule.campaign_id}`);
      this._updateLastRun(rule.id);
      return [];
    }

    // 재고 조건(소진 임박 or 예산 증액)이 설정된 경우 품번별 재고 일괄 조회
    const stockMap = {};
    const needsStock = rule.stock_days_off != null || (rule.roas_best != null && rule.daily_cap_increase_pct != null);
    if (needsStock) {
      const partCds = [...new Set(
        adStats.map(a => (a.ad_name?.match(PART_CD_RE) || [])[1]).filter(Boolean)
      )];
      await Promise.all(partCds.map(async (partCd) => {
        const info = await fetchStockInfo(partCd).catch(() => null);
        stockMap[partCd] = info;
      }));
    }

    const actions = [];
    const pausedAds = [];
    const enabledAds = [];
    const stockPausedAds = [];
    const budgetIncreasedAds = [];

    for (const ad of adStats) {
      let action = null;
      let reason = '';
      const partCd = (ad.ad_name?.match(PART_CD_RE) || [])[1];
      const stockInfo = partCd ? stockMap[partCd] : null;

      // 재고 소진 임박 체크 (ROAS보다 우선)
      if (rule.stock_days_off != null) {
        if (stockInfo && stockInfo.days_of_supply != null && stockInfo.days_of_supply <= rule.stock_days_off) {
          action = 'PAUSED';
          reason = `재고 소진 임박 — ${stockInfo.days_of_supply}일치 (기준: ${rule.stock_days_off}일, 일평균 판매 ${stockInfo.daily_avg}개)`;
        }
      }

      if (!action) {
        if (ad.roas < rule.roas_off) {
          action = 'PAUSED';
          reason = `ROAS ${ad.roas.toFixed(2)} < 기준 ${rule.roas_off} (지출 ₩${krwFmt.format(Math.round(ad.total_spend))})`;
        } else if (rule.roas_on != null && ad.roas >= rule.roas_on) {
          action = 'ENABLED';
          reason = `ROAS ${ad.roas.toFixed(2)} ≥ 복구기준 ${rule.roas_on} (지출 ₩${krwFmt.format(Math.round(ad.total_spend))})`;
        }
      }

      // 예산 증액: 재고 안전(≥15일) + 최우수 ROAS 조건 (다른 액션이 없을 때)
      if (!action && rule.roas_best != null && rule.daily_cap_increase_pct != null && ad.roas >= rule.roas_best) {
        const stockSafe = stockInfo == null || stockInfo.days_of_supply == null || stockInfo.days_of_supply >= 15;
        if (stockSafe && rule.platform === 'meta' && this.meta && ad.adset_id) {
          try {
            const adSets = await this.meta.getAdSets(rule.campaign_id);
            const adSet = adSets.find(s => s.id === ad.adset_id);
            if (adSet?.daily_budget) {
              const oldBudget = parseInt(adSet.daily_budget);
              const newBudget = Math.round(oldBudget * (1 + rule.daily_cap_increase_pct / 100));
              await this.meta.updateAdSetBudget(ad.adset_id, newBudget);
              action = 'BUDGET_INCREASED';
              const days = stockInfo?.days_of_supply ?? '?';
              reason = `재고 안전 ${days}일치 · ROAS ${ad.roas.toFixed(2)} ≥ 기준 ${rule.roas_best} → 일예산 +${rule.daily_cap_increase_pct}% (₩${krwFmt.format(oldBudget)} → ₩${krwFmt.format(newBudget)})`;
              budgetIncreasedAds.push({ ...ad, reason, oldBudget, newBudget });
            }
          } catch (budgetErr) {
            logger.error(`RuleEngine: budget update failed for adset ${ad.adset_id}`, { error: budgetErr.message });
          }
        }
      }

      if (!action) continue;

      // Meta API 호출 (ON/OFF 전환)
      if (action === 'PAUSED' || action === 'ENABLED') {
        try {
          const metaStatus = action === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
          if (rule.platform === 'meta' && this.meta) {
            await this.meta.updateAdStatus(ad.ad_id, metaStatus);
          }
        } catch (apiErr) {
          logger.error(`RuleEngine: API call failed for ad ${ad.ad_id}`, { error: apiErr.message });
          this._logAction(rule.id, ad, 'ERROR', ad.roas, ad.total_spend, apiErr.message);
          continue;
        }
      }

      this._logAction(rule.id, ad, action, ad.roas, ad.total_spend, reason);
      actions.push({ adId: ad.ad_id, adName: ad.ad_name, action, roas: ad.roas, reason });

      if (action === 'PAUSED') {
        if (reason.startsWith('재고')) stockPausedAds.push({ ...ad, reason });
        else pausedAds.push(ad);
      }
      if (action === 'ENABLED') enabledAds.push(ad);
    }

    this._updateLastRun(rule.id);

    // Slack 알림 (변경된 소재가 있을 때만)
    if (pausedAds.length + enabledAds.length + stockPausedAds.length + budgetIncreasedAds.length > 0) {
      await this._notify(rule, pausedAds, enabledAds, stockPausedAds, budgetIncreasedAds);
    }

    logger.info(`RuleEngine rule ${rule.id} done`, {
      evaluated: adStats.length,
      paused: pausedAds.length,
      stock_paused: stockPausedAds.length,
      enabled: enabledAds.length,
      budget_increased: budgetIncreasedAds.length,
    });

    return actions;
  }

  _logAction(ruleId, ad, action, roas, spend, reason) {
    db.prepare(`
      INSERT INTO ad_rule_log (rule_id, ad_id, ad_name, campaign_id, action, roas, spend, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ruleId, ad.ad_id, ad.ad_name, ad.campaign_id, action, roas, spend, reason);
  }

  _updateLastRun(ruleId) {
    db.prepare(
      `UPDATE ad_automation_rules SET last_run_at = datetime('now') WHERE id = ?`
    ).run(ruleId);
  }

  async _notify(rule, pausedAds, enabledAds, stockPausedAds = [], budgetIncreasedAds = []) {
    let msg = `🤖 *자동 규칙 실행 — ${rule.name}*\n`;
    msg += `캠페인: ${rule.campaign_name || rule.campaign_id} | 기준 ROAS: ${rule.roas_off}\n\n`;

    if (stockPausedAds.length > 0) {
      msg += `*📦 재고 소진 임박 중지 (${stockPausedAds.length}개)*\n`;
      for (const ad of stockPausedAds) {
        msg += `• ${ad.ad_name} — ${ad.reason}\n`;
      }
      msg += '\n';
    }

    if (pausedAds.length > 0) {
      msg += `*⏸ ROAS 기준 일시중지 (${pausedAds.length}개)*\n`;
      for (const ad of pausedAds) {
        msg += `• ${ad.ad_name} — ROAS ${ad.roas.toFixed(2)}\n`;
      }
    }

    if (enabledAds.length > 0) {
      msg += `\n*▶️ 재개 (${enabledAds.length}개)*\n`;
      for (const ad of enabledAds) {
        msg += `• ${ad.ad_name} — ROAS ${ad.roas.toFixed(2)}\n`;
      }
    }

    if (budgetIncreasedAds.length > 0) {
      msg += `\n*💰 예산 자동 증액 — 재고 안전 + 최우수 성과 (${budgetIncreasedAds.length}개)*\n`;
      for (const ad of budgetIncreasedAds) {
        msg += `• ${ad.ad_name} — ${ad.reason}\n`;
      }
    }

    await notifier.broadcast(msg, {
      severity: stockPausedAds.length > 0 || pausedAds.length > 0 ? 'warning' : 'info',
    }).catch(e => logger.warn('RuleEngine notify failed', { error: e.message }));
  }
}

export default RuleEngine;
