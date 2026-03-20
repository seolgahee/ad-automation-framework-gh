import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from './logger.js';

const DB_PATH = process.env.DB_PATH || './data/ads.db';

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Initialize all tables */
export function initDatabase() {
  db.exec(`
    -- Campaign master data (unified across platforms)
    CREATE TABLE IF NOT EXISTS campaigns (
      id               TEXT PRIMARY KEY,
      platform         TEXT NOT NULL CHECK(platform IN ('meta', 'google')),
      platform_id      TEXT NOT NULL,
      name             TEXT NOT NULL,
      status           TEXT DEFAULT 'ACTIVE',
      objective        TEXT,
      daily_budget     REAL,
      lifetime_budget  REAL,
      currency         TEXT DEFAULT 'KRW',
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, platform_id)
    );

    -- Ad set / Ad group level
    CREATE TABLE IF NOT EXISTS ad_groups (
      id               TEXT PRIMARY KEY,
      campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
      platform_id      TEXT NOT NULL,
      name             TEXT NOT NULL,
      status           TEXT DEFAULT 'ACTIVE',
      targeting_json   TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    -- Individual ads
    CREATE TABLE IF NOT EXISTS ads (
      id               TEXT PRIMARY KEY,
      ad_group_id      TEXT NOT NULL REFERENCES ad_groups(id),
      platform_id      TEXT NOT NULL,
      name             TEXT NOT NULL,
      status           TEXT DEFAULT 'ACTIVE',
      creative_json    TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    -- Performance snapshots (collected periodically)
    CREATE TABLE IF NOT EXISTS performance (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
      ad_group_id      TEXT,
      ad_id            TEXT,
      platform         TEXT NOT NULL,
      date_start       TEXT NOT NULL,
      date_stop        TEXT NOT NULL,
      impressions      INTEGER DEFAULT 0,
      clicks           INTEGER DEFAULT 0,
      spend            REAL DEFAULT 0,
      conversions      INTEGER DEFAULT 0,
      conversion_value REAL DEFAULT 0,
      ctr              REAL DEFAULT 0,
      cpc              REAL DEFAULT 0,
      cpm              REAL DEFAULT 0,
      roas             REAL DEFAULT 0,
      cpa              REAL DEFAULT 0,
      collected_at     TEXT DEFAULT (datetime('now'))
    );

    -- Alerts & notifications log
    CREATE TABLE IF NOT EXISTS alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id      TEXT,
      alert_type       TEXT NOT NULL,
      severity         TEXT DEFAULT 'info',
      message          TEXT NOT NULL,
      channel          TEXT,
      acknowledged     INTEGER DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    -- Budget change history (audit trail)
    CREATE TABLE IF NOT EXISTS budget_history (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
      old_budget       REAL,
      new_budget       REAL,
      reason           TEXT,
      triggered_by     TEXT DEFAULT 'manual',
      created_at       TEXT DEFAULT (datetime('now'))
    );

    -- Ad-level performance snapshots
    CREATE TABLE IF NOT EXISTS ad_performance (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id            TEXT NOT NULL,
      ad_name          TEXT,
      adset_id         TEXT,
      adset_name       TEXT,
      campaign_id      TEXT NOT NULL,
      campaign_name    TEXT,
      platform         TEXT NOT NULL,
      date_start       TEXT NOT NULL,
      impressions      INTEGER DEFAULT 0,
      clicks           INTEGER DEFAULT 0,
      spend            REAL DEFAULT 0,
      conversions      INTEGER DEFAULT 0,
      conversion_value REAL DEFAULT 0,
      ctr              REAL DEFAULT 0,
      cpc              REAL DEFAULT 0,
      cpm              REAL DEFAULT 0,
      roas             REAL DEFAULT 0,
      cpa              REAL DEFAULT 0,
      collected_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(ad_id, date_start)
    );

    -- Indexes for query performance
    CREATE INDEX IF NOT EXISTS idx_perf_campaign   ON performance(campaign_id, date_start);
    CREATE INDEX IF NOT EXISTS idx_perf_platform   ON performance(platform, date_start);
    CREATE INDEX IF NOT EXISTS idx_alerts_created  ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_adperf_campaign ON ad_performance(campaign_id, date_start);
    CREATE INDEX IF NOT EXISTS idx_adperf_ad       ON ad_performance(ad_id, date_start);

    -- Unique constraint for dedup in collector (prevents duplicate rows per collection cycle)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_dedup ON performance(campaign_id, platform, date_start);
  `);

  logger.info('Database initialized', { path: DB_PATH });
}

export default db;
