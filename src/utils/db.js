import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from './logger.js';

const DB_PATH = process.env.DB_PATH || './data/ads.db';

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { timeout: 30000 });
db.pragma('busy_timeout = 30000');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('wal_autocheckpoint = 100');
db.pragma('foreign_keys = ON');

try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}

/** Migrate ad_performance: add image_url column if missing */
function migrateAddImageUrl() {
  const colExists = db.prepare(
    `PRAGMA table_info(ad_performance)`
  ).all().some(col => col.name === 'image_url');

  if (colExists) return;

  // Table might not exist yet — that's fine, CREATE TABLE below will include the column
  const tableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='ad_performance'`
  ).get();
  if (!tableExists) return;

  logger.info('Adding image_url column to ad_performance');
  db.exec(`ALTER TABLE ad_performance ADD COLUMN image_url TEXT`);
}

/** Migrate ad_performance table to add platform CHECK & UNIQUE constraints */
function migrateAdPerformance() {
  const tableExists = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='ad_performance'`
  ).get();

  if (!tableExists) return; // will be created fresh below

  // Check if migration is needed (no CHECK constraint on platform yet)
  if (tableExists.sql.includes("CHECK(platform IN")) return;

  logger.info('Migrating ad_performance table (adding platform constraints)');

  const migrate = db.transaction(() => {
    db.exec(`ALTER TABLE ad_performance RENAME TO ad_performance_old`);

    db.exec(`
      CREATE TABLE ad_performance (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_id            TEXT NOT NULL,
        ad_name          TEXT,
        adset_id         TEXT,
        adset_name       TEXT,
        campaign_id      TEXT NOT NULL,
        campaign_name    TEXT,
        platform         TEXT NOT NULL CHECK(platform IN ('meta', 'google', 'tiktok')),
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
        image_url        TEXT,
        collected_at     TEXT DEFAULT (datetime('now')),
        UNIQUE(ad_id, platform, date_start)
      )
    `);

    db.exec(`
      INSERT INTO ad_performance
        (id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
         platform, date_start, impressions, clicks, spend, conversions,
         conversion_value, ctr, cpc, cpm, roas, cpa, collected_at)
      SELECT
        id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
        platform, date_start, impressions, clicks, spend, conversions,
        conversion_value, ctr, cpc, cpm, roas, cpa, collected_at
      FROM ad_performance_old
    `);

    db.exec(`DROP TABLE ad_performance_old`);

    // Recreate indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_adperf_campaign ON ad_performance(campaign_id, date_start)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_adperf_ad ON ad_performance(ad_id, platform, date_start)`);
  });

  migrate();
  logger.info('ad_performance migration complete');
}

/** Migrate creative_library: add image_data BLOB + ad_id columns if missing */
function migrateCreativeLibraryBlob() {
  const tableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_library'`
  ).get();
  if (!tableExists) return;

  const cols = db.prepare(`PRAGMA table_info(creative_library)`).all().map(c => c.name);

  if (!cols.includes('image_data')) {
    logger.info('Adding image_data BLOB column to creative_library');
    db.exec(`ALTER TABLE creative_library ADD COLUMN image_data BLOB`);
  }
  if (!cols.includes('ad_id')) {
    logger.info('Adding ad_id column to creative_library');
    db.exec(`ALTER TABLE creative_library ADD COLUMN ad_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_creative_library_adid ON creative_library(ad_id)`);
  }
  if (!cols.includes('persona')) {
    logger.info('Adding persona/desire/awareness columns to creative_library');
    db.exec(`ALTER TABLE creative_library ADD COLUMN persona TEXT`);
    db.exec(`ALTER TABLE creative_library ADD COLUMN desire TEXT`);
    db.exec(`ALTER TABLE creative_library ADD COLUMN awareness TEXT`);
  }
}

/** Migrate campaigns: add stop_time column if missing */
function migrateAddCampaignStopTime() {
  const tableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaigns'`
  ).get();
  if (!tableExists) return;

  const colExists = db.prepare(`PRAGMA table_info(campaigns)`).all().some(col => col.name === 'stop_time');
  if (colExists) return;

  logger.info('Adding stop_time column to campaigns');
  db.exec(`ALTER TABLE campaigns ADD COLUMN stop_time TEXT`);
}

/** Initialize all tables */
export function initDatabase() {
  // Run migrations before CREATE TABLE IF NOT EXISTS (which would be a no-op on existing tables)
  migrateAdPerformance();
  migrateAddImageUrl();
  migrateAddCampaignStopTime();
  migrateCreativeLibraryBlob();

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
      stop_time        TEXT,
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
      platform         TEXT NOT NULL CHECK(platform IN ('meta', 'google', 'tiktok')),
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
      image_url        TEXT,
      collected_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(ad_id, platform, date_start)
    );

    -- Indexes for query performance
    CREATE INDEX IF NOT EXISTS idx_perf_campaign   ON performance(campaign_id, date_start);
    CREATE INDEX IF NOT EXISTS idx_perf_platform   ON performance(platform, date_start);
    CREATE INDEX IF NOT EXISTS idx_alerts_created  ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_adperf_campaign ON ad_performance(campaign_id, date_start);
    CREATE INDEX IF NOT EXISTS idx_adperf_ad       ON ad_performance(ad_id, platform, date_start);

    -- Unique constraint for dedup in collector (prevents duplicate rows per collection cycle)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_dedup ON performance(campaign_id, platform, date_start);

    -- Creative assets (registered via Meta API or templates)
    CREATE TABLE IF NOT EXISTS creatives (
      id               TEXT PRIMARY KEY,
      platform         TEXT NOT NULL,
      platform_id      TEXT,
      campaign_id      TEXT,
      ad_set_id        TEXT,
      name             TEXT NOT NULL,
      type             TEXT DEFAULT 'image',
      status           TEXT DEFAULT 'DRAFT',
      headline         TEXT,
      description      TEXT,
      body_text        TEXT,
      cta              TEXT,
      media_url        TEXT,
      landing_url      TEXT,
      ab_group         TEXT,
      metadata_json    TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_creatives_platform ON creatives(platform, created_at);
    CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON creatives(campaign_id);

    CREATE TABLE IF NOT EXISTS meta_pages (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      memo      TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS google_asset_grades (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id          TEXT NOT NULL,
      asset_name        TEXT,
      asset_text        TEXT,
      image_url         TEXT,
      youtube_id        TEXT,
      field_type        TEXT,
      performance_label TEXT,
      campaign_id       TEXT NOT NULL,
      campaign_name     TEXT,
      ad_group_id       TEXT,
      ad_group_name     TEXT,
      ad_id             TEXT,
      collected_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(asset_id, ad_group_id, field_type)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_grades_campaign ON google_asset_grades(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_asset_grades_label ON google_asset_grades(performance_label);

    -- 소재 라이브러리 (배너 이미지 BLOB 영구 저장)
    CREATE TABLE IF NOT EXISTS creative_library (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      original_name     TEXT NOT NULL,
      width             INTEGER,
      height            INTEGER,
      file_size         INTEGER,
      mime_type         TEXT DEFAULT 'image/jpeg',
      image_data        BLOB,
      ad_id             TEXT,
      persona           TEXT,
      desire            TEXT,
      awareness         TEXT,
      checksum          TEXT,
      processing_status TEXT DEFAULT 'new',
      meta_uploaded     INTEGER DEFAULT 0,
      google_uploaded   INTEGER DEFAULT 0,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_creative_library_created ON creative_library(created_at);

    -- 크리에이티브 파이프라인: 플랫폼별 업로드 매핑
    CREATE TABLE IF NOT EXISTS platform_asset_map (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id       TEXT NOT NULL REFERENCES creative_library(id),
      platform         TEXT NOT NULL,
      external_asset_id TEXT NOT NULL,
      asset_type       TEXT,
      status           TEXT NOT NULL DEFAULT 'success',
      uploaded_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, external_asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_map_library ON platform_asset_map(library_id);
    CREATE INDEX IF NOT EXISTS idx_asset_map_platform ON platform_asset_map(platform);

    -- 크리에이티브 파이프라인: 작업 로그
    CREATE TABLE IF NOT EXISTS job_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type   TEXT NOT NULL,
      library_id TEXT REFERENCES creative_library(id),
      status     TEXT NOT NULL,
      message    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_log_library ON job_log(library_id);
    CREATE INDEX IF NOT EXISTS idx_job_log_type ON job_log(job_type);
  `);

  logger.info('Database initialized', { path: DB_PATH });
}

export default db;
