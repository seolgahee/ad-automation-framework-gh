#!/usr/bin/env node
/**
 * Historical data collection (daily breakdown)
 * Usage: node scripts/collect-historical.js 2026-03-01 2026-03-18
 */
import 'dotenv/config';
import db, { initDatabase } from '../src/utils/db.js';
import { getMetaClient } from '../src/utils/clients.js';

const [since, until] = process.argv.slice(2);
if (!since || !until) {
  console.error('Usage: node scripts/collect-historical.js <since> <until>');
  console.error('Example: node scripts/collect-historical.js 2026-03-01 2026-03-18');
  process.exit(1);
}

initDatabase();
const meta = getMetaClient();

const upsertCampaign = db.prepare(`
  INSERT INTO campaigns (id, platform, platform_id, name, status, updated_at)
  VALUES (?, 'meta', ?, ?, 'ACTIVE', datetime('now'))
  ON CONFLICT(platform, platform_id) DO UPDATE SET updated_at=datetime('now')
`);

const upsertPerf = db.prepare(`
  INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend,
    conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
  VALUES (?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET
    impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend,
    conversions=excluded.conversions, conversion_value=excluded.conversion_value,
    ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, roas=excluded.roas, cpa=excluded.cpa,
    collected_at=datetime('now')
`);

// 날짜 범위를 하루씩 순회
const dates = [];
const cursor = new Date(since);
const end = new Date(until);
while (cursor <= end) {
  dates.push(cursor.toISOString().split('T')[0]);
  cursor.setDate(cursor.getDate() + 1);
}

let totalRows = 0;

for (const date of dates) {
  process.stdout.write(`Fetching ${date}... `);
  try {
    const insights = await meta.getInsights({
      level: 'campaign',
      timeRange: { since: date, until: date },
    });

    const tx = db.transaction(() => {
      for (const row of insights) {
        const uid = `meta_${row.campaignId}`;
        upsertCampaign.run(uid, row.campaignId, row.campaignName || uid);
        const roas = row.spend > 0 ? row.conversionValue / row.spend : 0;
        const cpa  = row.conversions > 0 ? row.spend / row.conversions : 0;
        upsertPerf.run(
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

console.log(`\nComplete. Total ${totalRows} rows saved (${since} ~ ${until})`);
process.exit(0);
