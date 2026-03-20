#!/usr/bin/env node
/**
 * Sync campaigns from Meta & Google into the local SQLite DB
 * Usage: node scripts/sync-campaigns.js
 */
import 'dotenv/config';
import { initDatabase } from '../src/utils/db.js';
import { getMetaClient, getGoogleClient } from '../src/utils/clients.js';
import db from '../src/utils/db.js';

initDatabase();

const upsertCampaign = db.prepare(`
  INSERT INTO campaigns (id, platform, platform_id, name, status, objective, daily_budget, currency, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'KRW', datetime('now'))
  ON CONFLICT(platform, platform_id) DO UPDATE SET
    name=excluded.name, status=excluded.status, daily_budget=excluded.daily_budget, updated_at=datetime('now')
`);

async function syncMeta() {
  try {
    const meta = getMetaClient();
    const campaigns = await meta.getCampaigns();
    for (const c of campaigns) {
      upsertCampaign.run(`meta_${c.id}`, 'meta', c.id, c.name, c.status, c.objective, c.daily_budget / 100);
    }
    console.log(`Meta: synced ${campaigns.length} campaigns`);
  } catch (err) {
    console.error('Meta sync failed:', err.message);
  }
}

async function syncGoogle() {
  try {
    const google = getGoogleClient();
    const campaigns = await google.getCampaigns();
    for (const c of campaigns) {
      const status = c.status === 'ENABLED' ? 'ACTIVE' : c.status;
      upsertCampaign.run(`google_${c.id}`, 'google', String(c.id), c.name, status, null, c.dailyBudget);
    }
    console.log(`Google: synced ${campaigns.length} campaigns`);
  } catch (err) {
    console.error('Google sync failed:', err.message);
  }
}

await Promise.allSettled([syncMeta(), syncGoogle()]);
console.log('Campaign sync complete.');
process.exit(0);
