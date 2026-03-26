#!/usr/bin/env node
/**
 * Historical data collection (daily breakdown)
 * Usage:
 *   node scripts/collect-historical.js 2026-03-01 2026-03-20           # Meta + Google 모두
 *   node scripts/collect-historical.js 2026-03-01 2026-03-20 meta      # Meta만
 *   node scripts/collect-historical.js 2026-03-01 2026-03-20 google    # Google만
 */
import 'dotenv/config';
import db, { initDatabase } from '../src/utils/db.js';
import { getMetaClient, getGoogleClient } from '../src/utils/clients.js';

const [since, until, platformArg] = process.argv.slice(2);
if (!since || !until) {
  console.error('Usage: node scripts/collect-historical.js <since> <until> [meta|google]');
  console.error('Example: node scripts/collect-historical.js 2026-03-01 2026-03-20');
  console.error('Example: node scripts/collect-historical.js 2026-03-01 2026-03-20 google');
  process.exit(1);
}

const platform = platformArg?.toLowerCase();
if (platform && !['meta', 'google'].includes(platform)) {
  console.error('Invalid platform. Use: meta, google, or omit for both.');
  process.exit(1);
}

initDatabase();

// ─── Prepared Statements ────────────────────────────────────

const upsertCampaign = (p) => db.prepare(`
  INSERT INTO campaigns (id, platform, platform_id, name, status, updated_at)
  VALUES (?, '${p}', ?, ?, ?, datetime('now'))
  ON CONFLICT(platform, platform_id) DO UPDATE SET
    name=excluded.name, status=excluded.status, updated_at=datetime('now')
`);

const upsertPerf = (p) => db.prepare(`
  INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend,
    conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
  VALUES (?, '${p}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET
    impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
    conversions=excluded.conversions, conversion_value=excluded.conversion_value,
    ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
    collected_at=datetime('now')
`);

const upsertAdPerf = db.prepare(`
  INSERT INTO ad_performance
    (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
     platform, date_start, impressions, clicks, spend, conversions,
     conversion_value, ctr, cpc, cpm, roas, cpa)
  VALUES (?, ?, ?, ?, ?, ?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ad_id, platform, date_start) DO UPDATE SET
    impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
    conversions=excluded.conversions, conversion_value=excluded.conversion_value,
    ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
    collected_at=datetime('now')
`);

const metaCampaignStmt = upsertCampaign('meta');
const metaPerfStmt = upsertPerf('meta');
const googleCampaignStmt = upsertCampaign('google');
const googlePerfStmt = upsertPerf('google');

// ─── 날짜 범위 생성 ──────────────────────────────────────────

const dates = [];
const cursor = new Date(since);
const end = new Date(until);
while (cursor <= end) {
  dates.push(cursor.toISOString().split('T')[0]);
  cursor.setDate(cursor.getDate() + 1);
}

// ─── Meta 백필 ──────────────────────────────────────────────

async function collectMeta() {
  const meta = getMetaClient();
  if (!meta._configured) {
    console.log('[Meta] Skipped — credentials not configured');
    return 0;
  }

  console.log(`\n=== Meta Historical Data (${since} ~ ${until}) ===`);

  // 캠페인 실제 status 사전 조회 (ACTIVE + PAUSED 모두)
  const campaignStatusMap = new Map();
  try {
    const liveCampaigns = await meta.getCampaigns(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED']);
    for (const c of liveCampaigns) {
      campaignStatusMap.set(String(c.id), c.effective_status || c.status || 'ACTIVE');
    }
    console.log(`[Meta] ${campaignStatusMap.size}개 캠페인 status 조회 완료`);
  } catch (err) {
    console.log(`[Meta] 캠페인 status 조회 실패 (${err.message}) — 기본값 ACTIVE 사용`);
  }

  let totalRows = 0;

  for (const date of dates) {
    process.stdout.write(`[Meta] ${date}... `);
    try {
      const insights = await meta.getInsights({
        level: 'campaign',
        timeRange: { since: date, until: date },
      });

      const tx = db.transaction(() => {
        for (const row of insights) {
          const uid = `meta_${row.campaignId}`;
          const status = campaignStatusMap.get(String(row.campaignId)) || 'ACTIVE';
          metaCampaignStmt.run(uid, row.campaignId, row.campaignName || uid, status);
          const roas = row.spend > 0 ? row.conversionValue / row.spend : 0;
          const cpa  = row.conversions > 0 ? row.spend / row.conversions : 0;
          metaPerfStmt.run(
            uid, date, date,
            row.impressions, row.clicks, row.spend,
            row.conversions, row.conversionValue,
            row.ctr, row.cpc, row.cpm, roas, cpa
          );
        }
      });
      tx();
      totalRows += insights.length;
      console.log(`${insights.length} rows`);
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
  }

  console.log(`[Meta] Total ${totalRows} rows saved`);
  return totalRows;
}

// ─── Meta 소재 레벨 백필 ─────────────────────────────────────

async function collectMetaAdLevel() {
  const meta = getMetaClient();
  if (!meta._configured) return 0;

  console.log(`\n=== Meta Ad-Level Historical Data (${since} ~ ${until}) ===`);
  let totalRows = 0;

  for (const date of dates) {
    process.stdout.write(`[Meta Ad] ${date}... `);
    try {
      const insights = await meta.getAdInsights({
        timeRange: { since: date, until: date },
      });

      const tx = db.transaction(() => {
        for (const row of insights) {
          upsertAdPerf.run(
            row.adId, row.adName, row.adsetId, row.adsetName,
            `meta_${row.campaignId}`, row.campaignName, date,
            row.impressions, row.clicks, row.spend,
            row.conversions, row.conversionValue,
            row.ctr, row.cpc, row.cpm, row.roas, row.cpa
          );
        }
      });
      tx();
      totalRows += insights.length;
      console.log(`${insights.length} rows`);
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
  }

  console.log(`[Meta Ad] Total ${totalRows} rows saved`);
  return totalRows;
}

// ─── Google 백필 ────────────────────────────────────────────

async function collectGoogle() {
  const google = getGoogleClient();
  if (!google._configured) {
    console.log('[Google] Skipped — credentials not configured');
    return 0;
  }

  console.log(`\n=== Google Historical Data (${since} ~ ${until}) ===`);

  // 캠페인 실제 status 사전 조회
  const googleStatusMap = new Map();
  try {
    const liveCampaigns = await google.getCampaigns(['ENABLED', 'PAUSED']);
    for (const c of liveCampaigns) {
      googleStatusMap.set(String(c.id), c.status || 'ACTIVE');
    }
    console.log(`[Google] ${googleStatusMap.size}개 캠페인 status 조회 완료`);
  } catch (err) {
    console.log(`[Google] 캠페인 status 조회 실패 (${err.message}) — 기본값 ACTIVE 사용`);
  }

  let totalRows = 0;

  for (const date of dates) {
    process.stdout.write(`[Google] ${date}... `);
    try {
      const rows = await google.getPerformance({
        dateFrom: date,
        dateTo: date,
        level: 'campaign',
      });

      const tx = db.transaction(() => {
        for (const row of rows) {
          const uid = `google_${row.campaignId}`;
          const status = googleStatusMap.get(String(row.campaignId)) || 'ACTIVE';
          googleCampaignStmt.run(uid, row.campaignId, row.campaignName || uid, status);
          const roas = row.spend > 0 ? row.conversionValue / row.spend : 0;
          const cpa  = row.conversions > 0 ? row.spend / row.conversions : 0;
          googlePerfStmt.run(
            uid, date, date,
            row.impressions, row.clicks, row.spend,
            row.conversions, row.conversionValue,
            row.ctr, row.cpc, row.cpm, roas, cpa
          );
        }
      });
      tx();
      totalRows += rows.length;
      console.log(`${rows.length} rows`);
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
  }

  console.log(`[Google] Total ${totalRows} rows saved`);
  return totalRows;
}

// ─── 실행 ───────────────────────────────────────────────────

let metaTotal = 0;
let metaAdTotal = 0;
let googleTotal = 0;

if (!platform || platform === 'meta') {
  metaTotal = await collectMeta();
  metaAdTotal = await collectMetaAdLevel();
}
if (!platform || platform === 'google') {
  googleTotal = await collectGoogle();
}

console.log(`\n✅ Complete. Meta: ${metaTotal} campaign rows, Meta Ad-level: ${metaAdTotal} rows, Google: ${googleTotal} rows (${since} ~ ${until})`);
process.exit(0);
