/**
 * Data Collector — Periodically fetches performance data from
 * Meta, Google, and TikTok, normalizes it, stores in SQLite, and triggers alerts.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import db, { initDatabase } from '../utils/db.js';
import logger from '../utils/logger.js';
import notifier from '../utils/notifier.js';
import { getMetaClient, getGoogleClient, getTikTokClient } from '../utils/clients.js';
import { krwFmt } from '../utils/format.js';

const CREATIVE_IMAGE_DIR = path.join(process.cwd(), 'data', 'creative-images');

export class DataCollector extends EventEmitter {
  constructor() {
    super();
    this.meta = getMetaClient();
    this.google = getGoogleClient();
    this.tiktok = getTikTokClient();
    this.thresholds = {
      roasMin: parseFloat(process.env.ALERT_ROAS_THRESHOLD || '1.5'),
      cpaMax: parseFloat(process.env.ALERT_CPA_THRESHOLD || '50000'),
      budgetBurnRate: parseFloat(process.env.ALERT_BUDGET_BURN_RATE || '0.85'),
    };
  }

  /** Initialize DB and start scheduled collection */
  start(intervalMinutes = 15) {
    initDatabase();
    const interval = parseInt(process.env.COLLECT_INTERVAL_MINUTES || intervalMinutes);

    // Run immediately on start
    this.collectAll().catch(err => logger.error('Initial collection failed', { error: err.message }));

    this._scheduleTask(interval);
    logger.info(`Data collector started — every ${interval} minutes`);
  }

  _scheduleTask(interval) {
    if (this.cronTask) this.cronTask.stop();
    this.cronTask = cron.schedule(`*/${interval} * * * *`, () => {
      this.collectAll().catch(err => logger.error('Scheduled collection failed', { error: err.message }));
    });
    this.intervalMinutes = interval;
  }

  reschedule(newIntervalMinutes) {
    const interval = Math.max(1, Math.min(parseInt(newIntervalMinutes) || 15, 1440));
    process.env.COLLECT_INTERVAL_MINUTES = String(interval);
    this._scheduleTask(interval);
    logger.info(`Data collector rescheduled — every ${interval} minutes`);
  }

  /** Collect from all platforms */
  async collectAll() {
    const timestamp = new Date().toISOString();
    logger.info('Starting data collection cycle', { timestamp });

    const results = await Promise.allSettled([
      this._collectMeta(),
      this._collectGoogle(),
      this._collectTikTok(),
    ]);

    const platformNames = ['Meta', 'Google', 'TikTok'];
    results.forEach((r, i) => {
      const platform = platformNames[i];
      if (r.status === 'rejected') {
        logger.error(`${platform} collection failed`, { error: r.reason?.message });
      }
    });

    // Run analysis after collection (disabled: SLACK_ALERTS_PAUSED=true)
    if (process.env.SLACK_ALERTS_PAUSED !== 'true') {
      await this._analyzeAndAlert();
    } else {
      logger.info('Alerts paused (SLACK_ALERTS_PAUSED=true)');
    }

    logger.info('Data collection cycle complete');
    this.emit('collected');
  }

  /**
   * Unified platform collection — replaces _collectMeta / _collectGoogle
   *
   * @param {string} platform - 'meta' | 'google'
   * @param {Function} fetchCampaigns - async () => Campaign[]
   * @param {Function} fetchPerformance - async () => PerfRow[]
   * @param {Function} mapCampaign - (raw) => { uid, platformId, name, status, budget, extra? }
   */
  async _collectPlatform(platform, fetchCampaigns, fetchPerformance, mapCampaign) {
    const [rawCampaigns, rawPerf] = await Promise.all([fetchCampaigns(), fetchPerformance()]);

    const upsertCampaign = db.prepare(`
      INSERT INTO campaigns (id, platform, platform_id, name, status, daily_budget, stop_time, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'KRW', datetime('now'))
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        name=excluded.name, status=excluded.status, daily_budget=excluded.daily_budget,
        stop_time=excluded.stop_time, updated_at=datetime('now')
    `);

    const upsertPerf = db.prepare(`
      INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend,
        conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET
        impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
        conversions=excluded.conversions, conversion_value=excluded.conversion_value,
        ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
        collected_at=datetime('now')
    `);

    const transaction = db.transaction(() => {
      for (const c of rawCampaigns) {
        const m = mapCampaign(c);
        upsertCampaign.run(m.uid, platform, m.platformId, m.name, m.status, m.budget, m.stopTime || null);
      }

      const today = new Date().toISOString().split('T')[0];
      for (const row of rawPerf) {
        const uid = `${platform}_${row.campaignId}`;
        const roas = row.spend > 0 ? row.conversionValue / row.spend : 0;
        const cpa = row.conversions > 0 ? row.spend / row.conversions : 0;
        upsertPerf.run(uid, platform, today, today, row.impressions, row.clicks, row.spend,
          row.conversions, row.conversionValue, row.ctr, row.cpc, row.cpm, roas, cpa);
      }
    });

    transaction();
    logger.info(`${platform}: synced ${rawCampaigns.length} campaigns, ${rawPerf.length} perf rows`);
  }

  /** Collect Meta insights and upsert */
  async _collectMeta() {
    await this._collectPlatform(
      'meta',
      () => this.meta.getCampaigns(),
      () => this.meta.getInsights({ datePreset: 'today' }),
      (c) => ({
        uid: `meta_${c.id}`,
        platformId: c.id,
        name: c.name,
        status: c.effective_status || c.status,
        budget: c.daily_budget / 100,
        stopTime: c.stop_time || null,
      })
    );
    await this._collectMetaAdLevel();
  }

  /** Collect Meta ad-level insights */
  async _collectMetaAdLevel() {
    const rows = await this.meta.getAdInsights({ datePreset: 'today' });
    const today = new Date().toISOString().split('T')[0];

    // Resolve creative image URLs for all ads
    const adIds = rows.map(r => r.adId);
    let imageMap = new Map();
    try {
      imageMap = await this.meta.getAdCreativeImages(adIds);
    } catch (err) {
      logger.warn('Failed to fetch creative images, continuing without', { error: err.message });
    }

    const upsert = db.prepare(`
      INSERT INTO ad_performance
        (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, platform, date_start,
         impressions, clicks, spend, conversions, conversion_value, ctr, cpc, cpm, roas, cpa, image_url)
      VALUES (?, ?, ?, ?, ?, ?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ad_id, platform, date_start) DO UPDATE SET
        impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
        conversions=excluded.conversions, conversion_value=excluded.conversion_value,
        ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
        image_url=COALESCE(excluded.image_url, ad_performance.image_url),
        collected_at=datetime('now')
    `);

    const transaction = db.transaction(() => {
      for (const r of rows) {
        upsert.run(
          r.adId, r.adName, r.adsetId, r.adsetName,
          `meta_${r.campaignId}`, r.campaignName, today,
          r.impressions, r.clicks, r.spend, r.conversions, r.conversionValue,
          r.ctr, r.cpc, r.cpm, r.roas, r.cpa,
          imageMap.get(r.adId) || null
        );
      }
    });
    transaction();
    logger.info(`meta ad-level: synced ${rows.length} ad rows (${imageMap.size} with images)`);

    // 이미지 로컬 캐시 (비동기 백그라운드 — 수집 사이클 블로킹 없음)
    if (imageMap.size > 0) {
      this._cacheCreativeImages(imageMap).catch(err =>
        logger.warn('Creative image caching failed', { error: err.message })
      );
    }
  }

  /**
   * Meta 소재 이미지를 로컬 파일로 저장
   * 이미 존재하는 파일은 건너뜀 (CDN URL 만료 대비)
   */
  async _cacheCreativeImages(imageMap) {
    fs.mkdirSync(CREATIVE_IMAGE_DIR, { recursive: true });
    let saved = 0;

    const downloads = [...imageMap.entries()].map(async ([adId, imgUrl]) => {
      const localPath = path.join(CREATIVE_IMAGE_DIR, `${adId}.jpg`);
      if (fs.existsSync(localPath)) return; // 이미 캐시됨
      try {
        const res = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buffer);
        saved++;
      } catch (e) {
        logger.warn(`Image cache failed: ${adId}`, { error: e.message });
      }
    });

    await Promise.allSettled(downloads);
    if (saved > 0) logger.info(`Creative images cached locally: ${saved}개 신규`);
  }

  /** Collect Google performance and upsert */
  async _collectGoogle() {
    await this._collectPlatform(
      'google',
      () => this.google.getCampaigns(),
      () => this.google.getPerformance(),
      (c) => ({
        uid: `google_${c.id}`,
        platformId: String(c.id),
        name: c.name,
        status: c.status === 'ENABLED' ? 'ACTIVE' : c.status,
        budget: c.dailyBudget,
      })
    );
    await this._collectGooglePmaxAdLevel();
    await this._collectGoogleAssetGrades();
  }

  /** Collect Google asset performance grades (RSA/RDA) */
  async _collectGoogleAssetGrades() {
    // PMAX 캠페인은 asset_group을 사용하므로 제외, DG/Display 캠페인만
    const activeCampaigns = db.prepare(`
      SELECT platform_id FROM campaigns
      WHERE platform = 'google' AND status = 'ACTIVE'
        AND name NOT LIKE '%PMAX%'
    `).all();

    if (activeCampaigns.length === 0) {
      logger.info('google asset grades: no active non-PMAX campaigns, skipping');
      return;
    }

    const campaignIds = activeCampaigns.map(c => c.platform_id);
    logger.info(`google asset grades: querying ${campaignIds.length} campaigns`);

    const rows = await this.google.getAssetGrades(campaignIds);

    // 매 수집마다 전체 교체 (오래된 캠페인 데이터 제거)
    db.prepare(`DELETE FROM google_asset_grades`).run();
    if (!rows.length) return;

    const upsert = db.prepare(`
      INSERT INTO google_asset_grades
        (asset_id, asset_name, asset_text, image_url, youtube_id, field_type,
         performance_label, campaign_id, campaign_name, ad_group_id, ad_group_name, ad_id, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id, ad_group_id, field_type) DO UPDATE SET
        performance_label=excluded.performance_label,
        asset_name=excluded.asset_name,
        asset_text=excluded.asset_text,
        image_url=excluded.image_url,
        collected_at=datetime('now')
    `);

    const transaction = db.transaction(() => {
      for (const r of rows) {
        upsert.run(
          r.assetId, r.assetName, r.assetText, r.imageUrl, r.youtubeId,
          r.fieldType, r.performanceLabel,
          `google_${r.campaignId}`, r.campaignName,
          r.adGroupId, r.adGroupName, r.adId
        );
      }
    });
    transaction();
    logger.info(`google asset grades: synced ${rows.length} rows`);
  }

  /** Collect Google PMAX asset group performance */
  async _collectGooglePmaxAdLevel() {
    const rows = await this.google.getPmaxAssetInsights();
    if (!rows.length) return;

    const today = new Date().toISOString().split('T')[0];
    const upsert = db.prepare(`
      INSERT INTO ad_performance
        (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, platform, date_start,
         impressions, clicks, spend, conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
      VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ad_id, platform, date_start) DO UPDATE SET
        impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
        conversions=excluded.conversions, conversion_value=excluded.conversion_value,
        ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
        collected_at=datetime('now')
    `);

    const transaction = db.transaction(() => {
      for (const r of rows) {
        const roas = r.spend > 0 ? r.conversionValue / r.spend : 0;
        const cpa = r.conversions > 0 ? r.spend / r.conversions : 0;
        upsert.run(
          r.adId, r.adName, r.adGroupId, r.adGroupName,
          `google_${r.campaignId}`, r.campaignName, today,
          r.impressions, r.clicks, r.spend, r.conversions, r.conversionValue,
          r.ctr, r.cpc, r.cpm, roas, cpa
        );
      }
    });
    transaction();
    logger.info(`google PMAX: synced ${rows.length} asset group rows`);
  }

  /** Collect Google ad-level insights */
  async _collectGoogleAdLevel() {
    const rows = await this.google.getAdInsights();
    const today = new Date().toISOString().split('T')[0];

    const upsert = db.prepare(`
      INSERT INTO ad_performance
        (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, platform, date_start,
         impressions, clicks, spend, conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
      VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ad_id, platform, date_start) DO UPDATE SET
        impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
        conversions=excluded.conversions, conversion_value=excluded.conversion_value,
        ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
        collected_at=datetime('now')
    `);

    const transaction = db.transaction(() => {
      for (const r of rows) {
        const roas = r.spend > 0 ? r.conversionValue / r.spend : 0;
        const cpa = r.conversions > 0 ? r.spend / r.conversions : 0;
        upsert.run(
          r.adId, r.adName, r.adGroupId, r.adGroupName,
          `google_${r.campaignId}`, r.campaignName, today,
          r.impressions, r.clicks, r.spend, r.conversions, r.conversionValue,
          r.ctr, r.cpc, r.cpm, roas, cpa
        );
      }
    });
    transaction();
    logger.info(`google ad-level: synced ${rows.length} ad rows`);
  }

  /** Collect TikTok performance and upsert */
  async _collectTikTok() {
    await this._collectPlatform(
      'tiktok',
      () => this.tiktok.getCampaigns(),
      () => this.tiktok.getPerformance(),
      (c) => ({
        uid: `tiktok_${c.id}`,
        platformId: String(c.id),
        name: c.name,
        status: c.status === 'CAMPAIGN_STATUS_ENABLE' ? 'ACTIVE'
          : c.status === 'CAMPAIGN_STATUS_DISABLE' ? 'PAUSED' : c.status,
        budget: c.dailyBudget,
      })
    );
  }

  /** Analyze latest data and fire alerts */
  async _analyzeAndAlert() {
    const latestPerf = db.prepare(`
      SELECT p.*, c.name as campaign_name, c.daily_budget
      FROM performance p
      JOIN campaigns c ON p.campaign_id = c.id
      WHERE p.collected_at >= datetime('now', '-30 minutes')
      ORDER BY p.collected_at DESC
    `).all();

    const insertAlert = db.prepare(`
      INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?, ?, ?, ?)
    `);

    // Collect deferred broadcast functions (not yet executed)
    const broadcastQueue = [];

    for (const row of latestPerf) {
      // Low ROAS alert
      if (row.spend > 0 && row.roas > 0 && row.roas < this.thresholds.roasMin) {
        const msg = `[${row.campaign_name}] ROAS ${row.roas.toFixed(2)} — 목표(${this.thresholds.roasMin}) 미달`;
        insertAlert.run(row.campaign_id, 'low_roas', 'warning', msg);
        broadcastQueue.push(() => notifier.broadcast(msg, {
          severity: 'warning',
          data: { Campaign: row.campaign_name, ROAS: row.roas.toFixed(2), Spend: `₩${krwFmt.format(row.spend)}` },
        }));
      }

      // High CPA alert
      if (row.cpa > 0 && row.cpa > this.thresholds.cpaMax) {
        const msg = `[${row.campaign_name}] CPA ₩${row.cpa.toFixed(0)} — 임계값(₩${this.thresholds.cpaMax}) 초과`;
        insertAlert.run(row.campaign_id, 'high_cpa', 'warning', msg);
        broadcastQueue.push(() => notifier.broadcast(msg, { severity: 'warning' }));
      }

      // Budget burn rate alert
      if (row.daily_budget && row.daily_budget > 0) {
        const burnRate = row.spend / row.daily_budget;
        const hoursElapsed = new Date().getHours();
        const expectedBurn = hoursElapsed / 24;

        if (burnRate > this.thresholds.budgetBurnRate && burnRate > expectedBurn * 1.3) {
          const msg = `[${row.campaign_name}] 예산 소진률 ${(burnRate * 100).toFixed(1)}% — 조기 소진 우려`;
          insertAlert.run(row.campaign_id, 'budget_burn', 'critical', msg);
          broadcastQueue.push(() => notifier.broadcast(msg, { severity: 'critical' }));
        }
      }
    }

    // Fire all notifications in parallel (deferred until all DB inserts complete)
    if (broadcastQueue.length > 0) {
      const results = await Promise.allSettled(broadcastQueue.map(fn => fn()));
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        logger.warn(`${failed.length}/${results.length} broadcast(s) failed`);
      }
    }
  }
}

export default DataCollector;
