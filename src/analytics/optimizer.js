/**
 * Budget & Strategy Optimizer
 *
 * Analyzes historical performance data and provides:
 * - Auto budget reallocation suggestions
 * - Campaign pause/enable recommendations
 * - Trend detection (improving / declining)
 * - Cross-platform comparison
 */
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import notifier from '../utils/notifier.js';
import { krwFmt } from '../utils/format.js';

export class Optimizer {
  /**
   * Get a unified performance summary across both platforms
   * @param {number} days - lookback period
   */
  getSummary(days = 7, since = null, until = null) {
    let whereClause;
    let params;

    if (since && until) {
      whereClause = `AND p.date_start >= ? AND p.date_start <= ?`;
      params = [since, until];
    } else {
      const safeDays = Math.max(1, Math.min(parseInt(days) || 7, 365));
      whereClause = `AND p.date_start >= date('now', ? || ' days')`;
      params = [`-${safeDays}`];
    }

    const rows = db.prepare(`
      SELECT
        c.id,
        c.platform,
        c.name,
        c.daily_budget,
        SUM(p.impressions) as total_impressions,
        SUM(p.clicks) as total_clicks,
        SUM(p.spend) as total_spend,
        SUM(p.conversions) as total_conversions,
        SUM(p.conversion_value) as total_value,
        CASE WHEN SUM(p.impressions) > 0 THEN CAST(SUM(p.clicks) AS REAL) / SUM(p.impressions) ELSE 0 END as avg_ctr,
        CASE WHEN SUM(p.clicks) > 0 THEN SUM(p.spend) / SUM(p.clicks) ELSE 0 END as avg_cpc,
        CASE WHEN SUM(p.spend) > 0 THEN SUM(p.conversion_value) / SUM(p.spend) ELSE 0 END as roas,
        CASE WHEN SUM(p.conversions) > 0 THEN SUM(p.spend) / SUM(p.conversions) ELSE 0 END as cpa
      FROM campaigns c
      LEFT JOIN performance p ON c.id = p.campaign_id
        ${whereClause}
      WHERE c.status = 'ACTIVE'
      GROUP BY c.id
      ORDER BY total_spend DESC
    `).all(...params);

    return rows;
  }

  /**
   * Generate budget reallocation recommendations
   * Shifts budget from underperformers to top performers
   */
  getReallocationPlan(totalBudget, days = 7) {
    const summary = this.getSummary(days);
    if (summary.length === 0) return { campaigns: [], message: 'No active campaigns' };

    // Fallback to sum of current budgets if totalBudget is missing/NaN
    if (!totalBudget || isNaN(totalBudget)) {
      totalBudget = summary.reduce((s, c) => s + (c.daily_budget || 0), 0) || 1000000;
    }

    // Score each campaign (weighted: ROAS 40%, CTR 30%, CPA 30%)
    const scored = summary.map(c => {
      const roasScore = Math.min(c.roas / 3, 1);       // Cap at ROAS 3
      const ctrScore = Math.min(c.avg_ctr / 5, 1);     // Cap at 5% CTR
      const cpaScore = c.cpa > 0 ? Math.max(1 - c.cpa / 100, 0) : 0.5;

      return {
        ...c,
        score: roasScore * 0.4 + ctrScore * 0.3 + cpaScore * 0.3,
      };
    });

    const totalScore = scored.reduce((s, c) => s + c.score, 0);

    const plan = scored.map(c => {
      const allocation = totalScore > 0 ? (c.score / totalScore) * totalBudget : totalBudget / scored.length;
      const change = allocation - (c.daily_budget || 0);

      return {
        campaignId: c.id,
        name: c.name,
        platform: c.platform,
        currentBudget: c.daily_budget || 0,
        recommendedBudget: Math.round(allocation),
        change: Math.round(change),
        score: c.score.toFixed(3),
        roas: c.roas.toFixed(2),
        cpa: c.cpa.toFixed(0),
      };
    });

    plan.sort((a, b) => b.score - a.score);
    return { campaigns: plan, totalBudget };
  }

  /**
   * Detect performance trends over time
   * Compares recent period vs. prior period
   */
  getTrends(recentDays = 3, compareDays = 7) {
    const safeRecent = Math.max(1, Math.min(parseInt(recentDays) || 3, 365));
    const safeCompare = Math.max(1, Math.min(parseInt(compareDays) || 7, 365));

    const getAvg = (startOffset, endOffset) => db.prepare(`
      SELECT
        campaign_id,
        AVG(roas) as avg_roas,
        AVG(ctr) as avg_ctr,
        AVG(cpa) as avg_cpa,
        AVG(spend) as avg_spend
      FROM performance
      WHERE date_start >= date('now', ? || ' days')
        AND date_start < date('now', ? || ' days')
      GROUP BY campaign_id
    `).all(`-${startOffset}`, endOffset === 0 ? '0' : `-${endOffset}`);

    const recent = getAvg(safeRecent, 0);
    const prior = getAvg(safeCompare, safeRecent);

    const priorMap = Object.fromEntries(prior.map(r => [r.campaign_id, r]));

    return recent.map(r => {
      const p = priorMap[r.campaign_id];
      if (!p) return { campaignId: r.campaign_id, trend: 'new', ...r };

      const roasChange = p.avg_roas > 0 ? (r.avg_roas - p.avg_roas) / p.avg_roas : 0;
      const ctrChange = p.avg_ctr > 0 ? (r.avg_ctr - p.avg_ctr) / p.avg_ctr : 0;
      const cpaChange = p.avg_cpa > 0 ? (r.avg_cpa - p.avg_cpa) / p.avg_cpa : 0;

      let trend = 'stable';
      if (roasChange > 0.1 && ctrChange > 0.05) trend = 'improving';
      if (roasChange < -0.1 || cpaChange > 0.15) trend = 'declining';

      return {
        campaignId: r.campaign_id,
        trend,
        recentROAS: r.avg_roas,
        priorROAS: p.avg_roas,
        roasChange: (roasChange * 100).toFixed(1) + '%',
        ctrChange: (ctrChange * 100).toFixed(1) + '%',
        cpaChange: (cpaChange * 100).toFixed(1) + '%',
      };
    });
  }

  /**
   * Generate a text-based strategy report for Slack/Telegram
   */
  async generateReport(days = 7) {
    const summary = this.getSummary(days);
    const trends = this.getTrends();

    // Only include campaigns with spend > 0
    const activeSummary = summary.filter(c => c.total_spend > 0);
    const totalSpend = activeSummary.reduce((s, c) => s + c.total_spend, 0);
    const totalConversions = activeSummary.reduce((s, c) => s + c.total_conversions, 0);
    const totalValue = activeSummary.reduce((s, c) => s + c.total_value, 0);
    const overallROAS = totalSpend > 0 ? totalValue / totalSpend : 0;
    const overallCPA = totalConversions > 0 ? totalSpend / totalConversions : 0;
    const roasTarget = parseFloat(process.env.ALERT_ROAS_THRESHOLD || '1.5');

    const trendMap = Object.fromEntries(trends.map(t => [t.campaignId, t]));

    let report = `📊 최근 ${days}일 성과 요약\n\n`;
    report += `• 총 지출: ₩${krwFmt.format(Math.round(totalSpend))}\n`;
    report += `• 전환수: ${Math.round(totalConversions)}건\n`;
    report += `• ROAS: ${overallROAS.toFixed(2)} (목표 ${roasTarget} 대비 ${overallROAS >= roasTarget ? '+' : ''}${((overallROAS / roasTarget - 1) * 100).toFixed(0)}%)\n`;
    report += `• CPA: ₩${krwFmt.format(Math.round(overallCPA))}\n`;
    report += `• 구매전환값: ₩${krwFmt.format(Math.round(totalValue))}\n\n`;

    const byPlatform = { meta: [], google: [], tiktok: [] };
    activeSummary.forEach(c => byPlatform[c.platform]?.push(c));

    // Platform comparison
    const platformLabels = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' };
    const platformROAS = {};
    for (const [platform, campaigns] of Object.entries(byPlatform)) {
      if (campaigns.length === 0) continue;
      const pSpend = campaigns.reduce((s, c) => s + c.total_spend, 0);
      const pValue = campaigns.reduce((s, c) => s + c.total_value, 0);
      platformROAS[platform] = pSpend > 0 ? pValue / pSpend : 0;

      report += `[${platformLabels[platform]}] ROAS ${platformROAS[platform].toFixed(2)} | ₩${krwFmt.format(Math.round(pSpend))} 지출\n`;
      for (const c of campaigns) {
        const t = trendMap[c.id];
        const arrow = t?.trend === 'improving' ? '📈' : t?.trend === 'declining' ? '📉' : '➡️';
        report += `  ${arrow} ${c.name}\n     ROAS ${c.roas.toFixed(2)} | CPA ₩${krwFmt.format(Math.round(c.cpa))} | ₩${krwFmt.format(Math.round(c.total_spend))}\n`;
      }
      report += '\n';
    }

    // Cross-platform insight
    const platforms = Object.entries(platformROAS).filter(([, r]) => r > 0);
    if (platforms.length >= 2) {
      platforms.sort((a, b) => b[1] - a[1]);
      const best = platforms[0], worst = platforms[platforms.length - 1];
      if (best[1] > worst[1] && worst[1] > 0) {
        const diff = ((best[1] / worst[1] - 1) * 100).toFixed(0);
        report += `${platformLabels[best[0]]} 캠페인 ROAS가 ${platformLabels[worst[0]]} 대비 ${diff}% 높습니다.`;
      }
    }

    return report;
  }
}

export default Optimizer;
