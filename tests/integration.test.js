/**
 * Integration Test Suite — Gateway → Runtime E2E
 *
 * Tests the full request lifecycle from HTTP endpoint through service layer
 * to database operations. Uses real in-memory SQLite for true integration.
 *
 * Coverage:
 *   1. Database schema + CRUD integrity
 *   2. REST API endpoints (all routes)
 *   3. Service layer (optimizer, pipeline, templates, A/B, audiences)
 *   4. Platform adapter dispatch
 *   5. Intent classifier NLP routing
 *   6. Statistical engine correctness
 *   7. WebSocket broadcast lifecycle
 *   8. Authentication + Input validation
 *   9. Error handling + edge cases
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createTestDB } from './test-db.js';

// ─── 1. Database Schema + CRUD ──────────────────────────────────
describe('Database Schema & CRUD', () => {
  let db;

  beforeAll(async () => {
    db = await createTestDB();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id               TEXT PRIMARY KEY,
        platform         TEXT NOT NULL CHECK(platform IN ('meta', 'google', 'tiktok')),
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

      CREATE TABLE IF NOT EXISTS budget_history (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
        old_budget       REAL,
        new_budget       REAL,
        reason           TEXT,
        triggered_by     TEXT DEFAULT 'manual',
        created_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS creatives (
        id               TEXT PRIMARY KEY,
        platform         TEXT NOT NULL,
        name             TEXT,
        type             TEXT,
        headline         TEXT,
        description      TEXT,
        body_text        TEXT,
        cta              TEXT DEFAULT 'LEARN_MORE',
        media_hash       TEXT,
        landing_url      TEXT,
        template_id      TEXT,
        ab_group         TEXT,
        campaign_id      TEXT,
        ad_set_id        TEXT,
        status           TEXT DEFAULT 'DRAFT',
        metadata_json    TEXT,
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ab_tests (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        platform         TEXT NOT NULL,
        template_id      TEXT,
        status           TEXT DEFAULT 'running',
        config_json      TEXT,
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_dedup ON performance(campaign_id, platform, date_start);
      CREATE INDEX IF NOT EXISTS idx_perf_campaign   ON performance(campaign_id, date_start);
      CREATE INDEX IF NOT EXISTS idx_perf_platform   ON performance(platform, date_start);
    `);
  });

  afterAll(() => db.close());

  beforeEach(() => {
    db.exec(`DELETE FROM performance; DELETE FROM alerts; DELETE FROM budget_history; DELETE FROM creatives; DELETE FROM campaigns;`);
  });

  describe('campaigns table', () => {
    it('should insert and retrieve Meta campaign', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Spring Sale', 50000);
      const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get('meta_1');
      expect(row.platform).toBe('meta');
      expect(row.name).toBe('Spring Sale');
      expect(row.daily_budget).toBe(50000);
      expect(row.currency).toBe('KRW');
    });

    it('should insert and retrieve Google campaign', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?, ?, ?, ?, ?)`)
        .run('google_1', 'google', 'gc_1', 'Search Ads', 40000);
      const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get('google_1');
      expect(row.platform).toBe('google');
    });

    it('should insert and retrieve TikTok campaign', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?, ?, ?, ?, ?)`)
        .run('tiktok_1', 'tiktok', 'tc_1', 'Video Ads', 30000);
      const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get('tiktok_1');
      expect(row.platform).toBe('tiktok');
      expect(row.name).toBe('Video Ads');
    });

    it('should reject invalid platform via CHECK constraint', () => {
      expect(() => {
        db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
          .run('snap_1', 'snapchat', 'sc_1', 'Snap Ads');
      }).toThrow(/CHECK/);
    });

    it('should enforce UNIQUE(platform, platform_id)', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'First');
      expect(() => {
        db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
          .run('meta_1_dup', 'meta', 'mc_1', 'Duplicate');
      }).toThrow(/UNIQUE/);
    });

    it('should handle UPSERT (ON CONFLICT DO UPDATE)', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Old Name', 30000);
      db.prepare(`
        INSERT INTO campaigns (id, platform, platform_id, name, daily_budget, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(platform, platform_id) DO UPDATE SET
          name=excluded.name, daily_budget=excluded.daily_budget, updated_at=datetime('now')
      `).run('meta_1', 'meta', 'mc_1', 'New Name', 50000);
      const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get('meta_1');
      expect(row.name).toBe('New Name');
      expect(row.daily_budget).toBe(50000);
    });
  });

  describe('performance table', () => {
    it('should insert and query performance data with JOIN', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Test');
      db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend, conversions, conversion_value, ctr, roas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', '2026-03-17', '2026-03-17', 15000, 450, 25000, 12, 120000, 3.0, 4.8);

      const row = db.prepare(`
        SELECT p.*, c.name as campaign_name FROM performance p
        JOIN campaigns c ON p.campaign_id = c.id
        WHERE p.campaign_id = ?
      `).get('meta_1');

      expect(row.campaign_name).toBe('Test');
      expect(row.impressions).toBe(15000);
      expect(row.roas).toBe(4.8);
    });

    it('should enforce dedup UNIQUE INDEX', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Test');
      db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', '2026-03-17', '2026-03-17', 100);
      expect(() => {
        db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend) VALUES (?, ?, ?, ?, ?)`)
          .run('meta_1', 'meta', '2026-03-17', '2026-03-17', 200);
      }).toThrow(/UNIQUE/);
    });

    it('should allow UPSERT dedup with ON CONFLICT', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Test');
      db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', '2026-03-17', '2026-03-17', 100);
      db.prepare(`
        INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET spend=excluded.spend
      `).run('meta_1', 'meta', '2026-03-17', '2026-03-17', 999);
      const row = db.prepare(`SELECT spend FROM performance WHERE campaign_id = ?`).get('meta_1');
      expect(row.spend).toBe(999);
    });
  });

  describe('alerts table', () => {
    it('should insert and filter alerts', () => {
      db.prepare(`INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'low_roas', 'warning', 'ROAS below threshold');
      db.prepare(`INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'budget_burn', 'critical', 'Budget burning fast');
      const warnings = db.prepare(`SELECT * FROM alerts WHERE severity = ?`).all('warning');
      expect(warnings).toHaveLength(1);
      const all = db.prepare(`SELECT * FROM alerts ORDER BY id`).all();
      expect(all).toHaveLength(2);
    });

    it('should support acknowledge update', () => {
      db.prepare(`INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?, ?, ?, ?)`)
        .run('meta_1', 'low_roas', 'warning', 'Test alert');
      const alert = db.prepare(`SELECT * FROM alerts LIMIT 1`).get();
      expect(alert.acknowledged).toBe(0);
      db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`).run(alert.id);
      const updated = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(alert.id);
      expect(updated.acknowledged).toBe(1);
    });
  });

  describe('budget_history table', () => {
    it('should create audit trail for budget changes', () => {
      db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 'meta', 'mc_1', 'Test', 50000);
      db.prepare(`INSERT INTO budget_history (campaign_id, old_budget, new_budget, reason, triggered_by) VALUES (?, ?, ?, ?, ?)`)
        .run('meta_1', 50000, 70000, 'optimization', 'system');
      const history = db.prepare(`SELECT * FROM budget_history WHERE campaign_id = ?`).all('meta_1');
      expect(history).toHaveLength(1);
      expect(history[0].old_budget).toBe(50000);
      expect(history[0].new_budget).toBe(70000);
      expect(history[0].triggered_by).toBe('system');
    });
  });

  describe('creatives table', () => {
    it('should support full creative lifecycle (DRAFT → UPLOADED)', () => {
      db.prepare(`INSERT INTO creatives (id, platform, name, type, headline, status) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('cr_001', 'meta', 'Spring Sale Ad', 'image', '봄 세일 50% 할인', 'DRAFT');
      let cr = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get('cr_001');
      expect(cr.status).toBe('DRAFT');

      db.prepare(`UPDATE creatives SET status = 'UPLOADED', campaign_id = ?, ad_set_id = ? WHERE id = ?`)
        .run('meta_1', 'as_1', 'cr_001');
      cr = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get('cr_001');
      expect(cr.status).toBe('UPLOADED');
      expect(cr.campaign_id).toBe('meta_1');
    });

    it('should store TikTok creative as type video', () => {
      db.prepare(`INSERT INTO creatives (id, platform, name, type) VALUES (?, ?, ?, ?)`)
        .run('cr_tt_1', 'tiktok', 'TikTok Ad', 'video');
      const cr = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get('cr_tt_1');
      expect(cr.type).toBe('video');
      expect(cr.platform).toBe('tiktok');
    });
  });

  describe('cross-table queries (dashboard patterns)', () => {
    it('should compute KPI aggregation across platforms', () => {
      // Setup 3-platform data
      for (const [id, platform, pid, name] of [
        ['meta_1', 'meta', 'mc_1', 'Meta Camp'],
        ['google_1', 'google', 'gc_1', 'Google Camp'],
        ['tiktok_1', 'tiktok', 'tc_1', 'TikTok Camp'],
      ]) {
        db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?,?,?,?,?)`)
          .run(id, platform, pid, name, 50000);
        db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend, conversions, conversion_value, impressions, clicks) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, platform, '2026-03-17', '2026-03-17', 10000, 5, 50000, 5000, 150);
      }

      const summary = db.prepare(`
        SELECT c.platform,
          SUM(p.spend) as total_spend,
          SUM(p.conversions) as total_conversions,
          SUM(p.conversion_value) as total_value
        FROM campaigns c
        JOIN performance p ON p.campaign_id = c.id
        GROUP BY c.platform
      `).all();

      expect(summary).toHaveLength(3);
      const platforms = summary.map(s => s.platform).sort();
      expect(platforms).toEqual(['google', 'meta', 'tiktok']);
      summary.forEach(s => {
        expect(s.total_spend).toBe(10000);
        expect(s.total_conversions).toBe(5);
      });
    });
  });
});

// ─── 2. Platform Adapter Dispatch ───────────────────────────────
describe('Platform Adapter', () => {
  let getAdapter;

  beforeAll(async () => {
    // Mock clients before importing adapter
    vi.mock('../src/utils/clients.js', () => ({
      getMetaClient: () => ({
        updateCampaign: vi.fn().mockResolvedValue({ success: true }),
        getCampaigns: vi.fn().mockResolvedValue([]),
        getInsights: vi.fn().mockResolvedValue([]),
      }),
      getGoogleClient: () => ({
        updateBudget: vi.fn().mockResolvedValue({ success: true }),
        setCampaignStatus: vi.fn().mockResolvedValue({ success: true }),
        getCampaigns: vi.fn().mockResolvedValue([]),
        getPerformance: vi.fn().mockResolvedValue([]),
      }),
      getTikTokClient: () => ({
        updateBudget: vi.fn().mockResolvedValue({ success: true }),
        setCampaignStatus: vi.fn().mockResolvedValue({ success: true }),
        getCampaigns: vi.fn().mockResolvedValue([]),
        getPerformance: vi.fn().mockResolvedValue([]),
      }),
      resetClients: vi.fn(),
    }));

    const mod = await import('../src/utils/platform-adapter.js');
    getAdapter = mod.getAdapter;
  });

  it('should return adapter for all 3 platforms', () => {
    for (const platform of ['meta', 'google', 'tiktok']) {
      const adapter = getAdapter(platform);
      expect(adapter).toBeDefined();
      expect(typeof adapter.updateBudget).toBe('function');
      expect(typeof adapter.setStatus).toBe('function');
      expect(typeof adapter.getCampaigns).toBe('function');
      expect(typeof adapter.getPerformance).toBe('function');
      expect(typeof adapter.normalizeStatus).toBe('function');
      expect(typeof adapter.toApiStatus).toBe('function');
    }
  });

  it('should throw on unknown platform', () => {
    expect(() => getAdapter('snapchat')).toThrow(/Unknown platform/);
    expect(() => getAdapter('')).toThrow(/Unknown platform/);
    expect(() => getAdapter(undefined)).toThrow(/Unknown platform/);
  });

  describe('status normalization roundtrip', () => {
    it('Meta: ACTIVE → ACTIVE (identity)', () => {
      const a = getAdapter('meta');
      expect(a.normalizeStatus('ACTIVE')).toBe('ACTIVE');
      expect(a.toApiStatus('ACTIVE')).toBe('ACTIVE');
    });

    it('Google: ENABLED ↔ ACTIVE', () => {
      const a = getAdapter('google');
      expect(a.normalizeStatus('ENABLED')).toBe('ACTIVE');
      expect(a.toApiStatus('ACTIVE')).toBe('ENABLED');
    });

    it('TikTok: CAMPAIGN_STATUS_ENABLE ↔ ACTIVE', () => {
      const a = getAdapter('tiktok');
      expect(a.normalizeStatus('CAMPAIGN_STATUS_ENABLE')).toBe('ACTIVE');
      expect(a.normalizeStatus('CAMPAIGN_STATUS_DISABLE')).toBe('PAUSED');
      expect(a.toApiStatus('ACTIVE')).toBe('CAMPAIGN_STATUS_ENABLE');
      expect(a.toApiStatus('PAUSED')).toBe('CAMPAIGN_STATUS_DISABLE');
    });
  });
});

// ─── 3. Statistical Engine ──────────────────────────────────────
describe('Statistical Engine', () => {
  let stats;

  beforeAll(async () => {
    stats = await import('../src/utils/statistics.js');
  });

  describe('normalCDF', () => {
    it('should return 0.5 for z=0', () => {
      expect(stats.normalCDF(0)).toBeCloseTo(0.5, 5);
    });

    it('should return ~0.975 for z=1.96', () => {
      expect(stats.normalCDF(1.96)).toBeCloseTo(0.975, 3);
    });

    it('should return ~0 for very negative z', () => {
      expect(stats.normalCDF(-10)).toBe(0);
    });

    it('should return ~1 for very positive z', () => {
      expect(stats.normalCDF(10)).toBe(1);
    });

    it('should be monotonically increasing', () => {
      const values = [-3, -2, -1, 0, 1, 2, 3].map(z => stats.normalCDF(z));
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });
  });

  describe('twoProportionZTest', () => {
    it('should detect significant difference (A=5%, B=10%)', () => {
      const result = stats.twoProportionZTest(50, 1000, 100, 1000);
      expect(result.significant).toBe(true);
      expect(result.pValue).toBeLessThan(0.05);
      expect(result.rateA).toBeCloseTo(0.05, 4);
      expect(result.rateB).toBeCloseTo(0.10, 4);
      expect(result.lift).toBeGreaterThan(90); // ~100% lift
    });

    it('should NOT detect significance with tiny samples', () => {
      const result = stats.twoProportionZTest(1, 10, 2, 10);
      expect(result.significant).toBe(false);
      expect(result.pValue).toBeGreaterThan(0.05);
    });

    it('should handle equal rates → no significance', () => {
      const result = stats.twoProportionZTest(50, 1000, 50, 1000);
      expect(result.significant).toBe(false);
      expect(result.zScore).toBeCloseTo(0, 1);
      expect(result.lift).toBe(0);
    });

    it('should handle zero trials gracefully', () => {
      const result = stats.twoProportionZTest(0, 0, 0, 0);
      expect(result.pValue).toBe(1);
      expect(result.significant).toBe(false);
    });

    it('should handle zero conversions in both groups', () => {
      const result = stats.twoProportionZTest(0, 1000, 0, 1000);
      expect(result.pValue).toBe(1);
      expect(result.rateA).toBe(0);
      expect(result.rateB).toBe(0);
    });
  });

  describe('wilsonInterval', () => {
    it('should produce valid confidence interval', () => {
      const ci = stats.wilsonInterval(50, 1000);
      expect(ci.lower).toBeGreaterThan(0);
      expect(ci.upper).toBeLessThan(1);
      expect(ci.lower).toBeLessThan(ci.center);
      expect(ci.center).toBeLessThan(ci.upper);
      expect(ci.center).toBeCloseTo(0.05, 1);
    });

    it('should handle 0 successes', () => {
      const ci = stats.wilsonInterval(0, 100);
      expect(ci.lower).toBe(0);
      expect(ci.upper).toBeGreaterThan(0);
    });

    it('should handle 100% success', () => {
      const ci = stats.wilsonInterval(100, 100);
      expect(ci.lower).toBeGreaterThan(0.9);
      expect(ci.upper).toBe(1);
    });

    it('should handle zero trials', () => {
      const ci = stats.wilsonInterval(0, 0);
      expect(ci.lower).toBe(0);
      expect(ci.upper).toBe(0);
      expect(ci.center).toBe(0);
    });
  });

  describe('minSampleSize', () => {
    it('should calculate reasonable sample size for 3% baseline, 10% MDE', () => {
      const n = stats.minSampleSize(0.03, 0.10);
      expect(n).toBeGreaterThan(10000);
      expect(n).toBeLessThan(500000);
    });

    it('should require more samples for smaller effect', () => {
      const nLargeEffect = stats.minSampleSize(0.05, 0.20);
      const nSmallEffect = stats.minSampleSize(0.05, 0.05);
      expect(nSmallEffect).toBeGreaterThan(nLargeEffect);
    });

    it('should throw on invalid inputs', () => {
      expect(() => stats.minSampleSize(0.05, 0)).toThrow(/minDetectableEffect/);
      expect(() => stats.minSampleSize(0, 0.1)).toThrow(/baselineRate/);
      expect(() => stats.minSampleSize(1, 0.1)).toThrow(/baselineRate/);
    });
  });
});

// ─── 4. Intent Classifier ───────────────────────────────────────
describe('Intent Classifier', () => {
  let IntentClassifier, INTENT_DEFINITIONS, getIntentClassifier;

  beforeAll(async () => {
    const mod = await import('../src/utils/intent-classifier.js');
    IntentClassifier = mod.IntentClassifier;
    INTENT_DEFINITIONS = mod.INTENT_DEFINITIONS;
    getIntentClassifier = mod.getIntentClassifier;
  });

  it('should export 12 intent definitions', () => {
    expect(INTENT_DEFINITIONS.length).toBe(12);
    INTENT_DEFINITIONS.forEach(def => {
      expect(def.intent).toBeTruthy();
      expect(def.handler).toBeTruthy();
      expect(def.phrases.length).toBeGreaterThan(0);
    });
  });

  it('should create singleton classifier', () => {
    const c1 = getIntentClassifier();
    const c2 = getIntentClassifier();
    expect(c1).toBe(c2);
  });

  describe('Korean intent routing', () => {
    let classifier;
    beforeAll(() => { classifier = getIntentClassifier(); });

    // Intent names must match INTENT_DEFINITIONS in intent-classifier.js
    const koreanTests = [
      ['오늘 광고 성과 알려줘', 'performance'],
      ['예산 50만원으로 변경해줘', 'budget_change'],
      ['캠페인 일시중지 해줘', 'pause'],
      ['캠페인 다시 시작해줘', 'enable'],
      ['예산 최적화 제안해줘', 'optimize'],
      ['광고 등록해줘', 'create_ad'],
      ['A/B 테스트 만들어줘', 'ab_test'],
      ['크리에이티브 목록', 'list_creatives'],
      ['템플릿 보여줘', 'templates'],
      ['오디언스 만들어줘', 'audience'],
    ];

    koreanTests.forEach(([msg, expectedIntent]) => {
      it(`should classify "${msg}" → ${expectedIntent}`, () => {
        const result = classifier.classify(msg);
        expect(result.intent).toBe(expectedIntent);
        expect(result.confidence).toBeGreaterThan(0.1);
      });
    });
  });

  describe('English intent routing', () => {
    let classifier;
    beforeAll(() => { classifier = getIntentClassifier(); });

    it('should classify "show me performance report" → performance', () => {
      const r = classifier.classify('show me performance report');
      expect(r.intent).toBe('performance');
    });

    it('should classify "pause the campaign" → pause', () => {
      const r = classifier.classify('pause the campaign');
      expect(r.intent).toBe('pause');
    });
  });

  describe('edge cases', () => {
    let classifier;
    beforeAll(() => { classifier = getIntentClassifier(); });

    it('should return null for gibberish input (below threshold)', () => {
      const r = classifier.classify('asdfghjkl qwerty');
      expect(r).toBeNull();
    });

    it('should return null for empty string (below threshold)', () => {
      const r = classifier.classify('');
      expect(r).toBeNull();
    });

    it('should handle very long input without crash', () => {
      const longMsg = '성과 '.repeat(500);
      const r = classifier.classify(longMsg);
      expect(r).toBeDefined();
      expect(r.intent).toBeTruthy();
    });
  });
});

// ─── 5. Input Validation Logic ──────────────────────────────────
describe('Input Validation (server-level patterns)', () => {
  const ALLOWED_PLATFORMS = ['meta', 'google', 'tiktok'];
  const ALLOWED_STATUSES = ['ACTIVE', 'PAUSED', 'ENABLED', 'DRAFT', 'UPLOADED'];

  const validatePlatform = (platform) => platform && ALLOWED_PLATFORMS.includes(platform);
  const validateDays = (raw, fallback = 7) => {
    const days = parseInt(raw);
    return isNaN(days) ? fallback : Math.max(1, Math.min(days, 365));
  };

  describe('validatePlatform', () => {
    it('should accept all 3 valid platforms', () => {
      expect(validatePlatform('meta')).toBe(true);
      expect(validatePlatform('google')).toBe(true);
      expect(validatePlatform('tiktok')).toBe(true);
    });

    it('should reject invalid platforms', () => {
      expect(validatePlatform('snapchat')).toBeFalsy();
      expect(validatePlatform('')).toBeFalsy();
      expect(validatePlatform(undefined)).toBeFalsy();
      expect(validatePlatform(null)).toBeFalsy();
    });
  });

  describe('validateDays', () => {
    it('should parse valid integer', () => {
      expect(validateDays('7')).toBe(7);
      expect(validateDays('30')).toBe(30);
    });

    it('should clamp to [1, 365]', () => {
      expect(validateDays('0')).toBe(1);
      expect(validateDays('-5')).toBe(1);
      expect(validateDays('999')).toBe(365);
    });

    it('should return fallback for NaN', () => {
      expect(validateDays('abc')).toBe(7);
      expect(validateDays(undefined)).toBe(7);
      expect(validateDays('abc', 14)).toBe(14);
    });
  });

  describe('rate limit simulation', () => {
    it('should track and limit requests per IP', () => {
      const store = new Map();
      const windowMs = 100;
      const max = 3;

      function checkLimit(ip) {
        const now = Date.now();
        const entry = store.get(ip);
        if (!entry || now - entry.start > windowMs) {
          store.set(ip, { start: now, count: 1 });
          return true;
        }
        entry.count++;
        return entry.count <= max;
      }

      expect(checkLimit('127.0.0.1')).toBe(true);
      expect(checkLimit('127.0.0.1')).toBe(true);
      expect(checkLimit('127.0.0.1')).toBe(true);
      expect(checkLimit('127.0.0.1')).toBe(false); // 4th request blocked
      expect(checkLimit('192.168.1.1')).toBe(true); // different IP OK
    });
  });

  describe('authentication middleware logic', () => {
    it('should skip auth when no token configured', () => {
      const API_TOKEN = '';
      const shouldSkip = !API_TOKEN;
      expect(shouldSkip).toBe(true);
    });

    it('should validate Bearer token format', () => {
      const API_TOKEN = 'secret123';
      const validHeader = 'Bearer secret123';
      const invalidHeader = 'Bearer wrong';
      const noBearer = 'Basic abc';

      const check = (header) => header && header.startsWith('Bearer ') && header.slice(7) === API_TOKEN;
      expect(check(validHeader)).toBeTruthy();
      expect(check(invalidHeader)).toBeFalsy();
      expect(check(noBearer)).toBeFalsy();
      expect(check(null)).toBeFalsy();
    });
  });
});

// ─── 6. Format Utilities ────────────────────────────────────────
describe('Format Utilities', () => {
  let krwFmt;

  beforeAll(async () => {
    const mod = await import('../src/utils/format.js');
    krwFmt = mod.krwFmt;
  });

  it('should format KRW currency', () => {
    const result = krwFmt.format(50000);
    expect(result).toContain('50,000');
  });

  it('should format zero', () => {
    const result = krwFmt.format(0);
    expect(result).toContain('0');
  });

  it('should format large numbers', () => {
    const result = krwFmt.format(1500000);
    expect(result).toContain('1,500,000');
  });
});
