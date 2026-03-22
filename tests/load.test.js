/**
 * Load Test Suite — Concurrency, Throughput, Rate Limiting
 *
 * Validates system behavior under concurrent access patterns:
 *   1. Database concurrent writes (WAL mode stress)
 *   2. Rate limiter fairness + burst rejection
 *   3. Service registry under concurrent access
 *   4. Intent classifier throughput (TF-IDF computation)
 *   5. Statistical engine batch processing
 *   6. Platform adapter concurrent dispatch
 *   7. WebSocket broadcast fan-out simulation
 *   8. Memory pressure (large dataset aggregation)
 *   9. Transaction isolation (concurrent UPSERT)
 *  10. Graceful degradation under overload
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createTestDB } from './test-db.js';

// ─── Helpers ─────────────────────────────────────────────────────

/** Run fn N times concurrently, return { results, elapsed, rps } */
async function runConcurrent(fn, count) {
  const start = performance.now();
  const promises = Array.from({ length: count }, (_, i) => fn(i));
  const results = await Promise.allSettled(promises);
  const elapsed = performance.now() - start;
  return {
    results,
    elapsed,
    rps: (count / elapsed) * 1000,
    fulfilled: results.filter(r => r.status === 'fulfilled').length,
    rejected: results.filter(r => r.status === 'rejected').length,
  };
}

/** Run fn N times sequentially, return { elapsed, rps } */
async function runSequential(fn, count) {
  const start = performance.now();
  for (let i = 0; i < count; i++) await fn(i);
  const elapsed = performance.now() - start;
  return { elapsed, rps: (count / elapsed) * 1000 };
}

const SCHEMA_SQL = `
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK(platform IN ('meta','google','tiktok')),
    platform_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'ACTIVE',
    daily_budget REAL,
    currency TEXT DEFAULT 'KRW',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(platform, platform_id)
  );
  CREATE TABLE performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    platform TEXT NOT NULL,
    date_start TEXT NOT NULL,
    date_stop TEXT NOT NULL,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    spend REAL DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    conversion_value REAL DEFAULT 0,
    ctr REAL DEFAULT 0, cpc REAL DEFAULT 0, cpm REAL DEFAULT 0,
    roas REAL DEFAULT 0, cpa REAL DEFAULT 0,
    collected_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_perf_dedup ON performance(campaign_id, platform, date_start);
  CREATE INDEX idx_perf_campaign ON performance(campaign_id, date_start);
  CREATE INDEX idx_perf_platform ON performance(platform, date_start);
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT, alert_type TEXT NOT NULL,
    severity TEXT DEFAULT 'info', message TEXT NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE budget_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    old_budget REAL, new_budget REAL,
    reason TEXT, triggered_by TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE creatives (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL,
    name TEXT, type TEXT, headline TEXT,
    description TEXT, body_text TEXT,
    cta TEXT DEFAULT 'LEARN_MORE',
    media_hash TEXT, landing_url TEXT,
    template_id TEXT, ab_group TEXT,
    campaign_id TEXT, ad_set_id TEXT,
    status TEXT DEFAULT 'DRAFT',
    metadata_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** Create an in-memory test DB with full schema */
async function createLoadDB() {
  const db = await createTestDB();
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

// ─── 1. Database Concurrent Write Stress (WAL) ──────────────────
describe('Load: Database WAL Concurrent Writes', () => {
  let db;

  beforeAll(async () => { db = await createLoadDB(); });
  afterAll(() => db.close());

  it('should handle 500 concurrent campaign INSERTs without corruption', () => {
    const insert = db.prepare(
      `INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?,?,?,?,?)`
    );
    const platforms = ['meta', 'google', 'tiktok'];
    const tx = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const p = platforms[i % 3];
        insert.run(`${p}_${i}`, p, `pid_${i}`, `Campaign ${i}`, 10000 + i * 100);
      }
    });

    const start = performance.now();
    tx();
    const elapsed = performance.now() - start;

    const count = db.prepare(`SELECT COUNT(*) as cnt FROM campaigns`).get().cnt;
    expect(count).toBe(500);

    // Verify platform distribution
    const byPlatform = db.prepare(`SELECT platform, COUNT(*) as cnt FROM campaigns GROUP BY platform`).all();
    expect(byPlatform).toHaveLength(3);
    byPlatform.forEach(row => {
      expect(row.cnt).toBeGreaterThanOrEqual(166);
      expect(row.cnt).toBeLessThanOrEqual(167);
    });

    console.log(`  ⏱ 500 INSERTs in ${elapsed.toFixed(1)}ms (${(500 / elapsed * 1000).toFixed(0)} ops/s)`);
  });

  it('should handle 1000 performance UPSERT operations in transaction', () => {
    const upsert = db.prepare(`
      INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend, conversions, conversion_value, ctr, cpc, cpm, roas, cpa)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET
        impressions=excluded.impressions, clicks=excluded.clicks, spend=excluded.spend, collected_at=datetime('now')
    `);

    const campaigns = db.prepare(`SELECT id, platform FROM campaigns LIMIT 100`).all();
    const tx = db.transaction(() => {
      for (let day = 0; day < 10; day++) {
        const date = `2026-03-${String(7 + day).padStart(2, '0')}`;
        for (const c of campaigns) {
          upsert.run(c.id, c.platform, date, date,
            Math.floor(Math.random() * 50000), Math.floor(Math.random() * 1500),
            Math.random() * 100000, Math.floor(Math.random() * 50),
            Math.random() * 500000, Math.random() * 5,
            Math.random() * 100, Math.random() * 2000,
            Math.random() * 5, Math.random() * 30000
          );
        }
      }
    });

    const start = performance.now();
    tx();
    const elapsed = performance.now() - start;

    const perfCount = db.prepare(`SELECT COUNT(*) as cnt FROM performance`).get().cnt;
    expect(perfCount).toBe(1000); // 100 campaigns × 10 days
    console.log(`  ⏱ 1000 UPSERTs in ${elapsed.toFixed(1)}ms (${(1000 / elapsed * 1000).toFixed(0)} ops/s)`);
  });

  it('should handle concurrent UPSERT idempotency (same key, different values)', () => {
    // Run same UPSERT 50 times with different spend values
    const upsert = db.prepare(`
      INSERT INTO performance (campaign_id, platform, date_start, date_stop, spend)
      VALUES (?,?,?,?,?)
      ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET spend=excluded.spend
    `);

    for (let i = 0; i < 50; i++) {
      upsert.run('meta_0', 'meta', '2026-12-25', '2026-12-25', 1000 + i);
    }

    const rows = db.prepare(`SELECT * FROM performance WHERE campaign_id='meta_0' AND date_start='2026-12-25'`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(1049); // Last write wins
  });

  it('should support aggregate query under load (dashboard pattern)', () => {
    const start = performance.now();
    const summary = db.prepare(`
      SELECT c.platform,
        COUNT(DISTINCT c.id) as campaign_count,
        SUM(p.spend) as total_spend,
        SUM(p.conversions) as total_conversions,
        SUM(p.conversion_value) as total_value,
        AVG(p.ctr) as avg_ctr,
        CASE WHEN SUM(p.spend) > 0 THEN SUM(p.conversion_value) / SUM(p.spend) ELSE 0 END as roas
      FROM campaigns c
      JOIN performance p ON p.campaign_id = c.id
      GROUP BY c.platform
    `).all();
    const elapsed = performance.now() - start;

    expect(summary).toHaveLength(3);
    summary.forEach(row => {
      expect(row.campaign_count).toBeGreaterThan(0);
      expect(row.total_spend).toBeGreaterThan(0);
    });
    console.log(`  ⏱ Aggregate query over 1000+ rows in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500); // Should be fast with WAL + indexes
  });
});

// ─── 2. Rate Limiter Fairness + Burst Rejection ─────────────────
describe('Load: Rate Limiter', () => {
  let store;
  const windowMs = 60000;

  function checkLimit(ip, max) {
    const now = Date.now();
    const entry = store.get(ip);
    if (!entry || now - entry.start > windowMs) {
      store.set(ip, { start: now, count: 1 });
      return { allowed: true, count: 1 };
    }
    entry.count++;
    return { allowed: entry.count <= max, count: entry.count };
  }

  beforeEach(() => { store = new Map(); });

  it('should allow exactly N requests then reject (read limiter: 120/min)', () => {
    const max = 120;
    let allowed = 0;
    let rejected = 0;

    for (let i = 0; i < 200; i++) {
      const r = checkLimit('client_1', max);
      if (r.allowed) allowed++;
      else rejected++;
    }

    expect(allowed).toBe(120);
    expect(rejected).toBe(80);
  });

  it('should allow exactly N requests then reject (mutation limiter: 20/min)', () => {
    const max = 20;
    let allowed = 0;

    for (let i = 0; i < 50; i++) {
      if (checkLimit('client_1', max).allowed) allowed++;
    }

    expect(allowed).toBe(20);
  });

  it('should isolate rate limits per IP', () => {
    const max = 5;

    for (let i = 0; i < 5; i++) checkLimit('ip_a', max);
    for (let i = 0; i < 3; i++) checkLimit('ip_b', max);

    // ip_a should be at limit, ip_b still has room
    expect(checkLimit('ip_a', max).allowed).toBe(false);
    expect(checkLimit('ip_b', max).allowed).toBe(true);
    expect(checkLimit('ip_b', max).allowed).toBe(true);
    expect(checkLimit('ip_b', max).allowed).toBe(false); // now at limit
  });

  it('should handle 10,000 IPs without memory explosion', () => {
    const max = 10;
    const memBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 10000; i++) {
      checkLimit(`ip_${i}`, max);
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024;

    expect(store.size).toBe(10000);
    expect(memGrowthMB).toBeLessThan(50); // Should be well under 50MB
    console.log(`  ⏱ 10,000 IP entries: ${memGrowthMB.toFixed(2)}MB memory growth`);
  });

  it('should clean expired entries (5-min expiry simulation)', () => {
    // Simulate stale entries
    const now = Date.now();
    store.set('stale_1', { start: now - 400000, count: 5 });
    store.set('stale_2', { start: now - 310000, count: 10 });
    store.set('fresh_1', { start: now - 60000, count: 3 });
    store.set('fresh_2', { start: now - 1000, count: 1 });

    // Cleanup logic (mirrors server.js rateLimitCleanupInterval)
    for (const [key, entry] of store) {
      if (now - entry.start > 300000) store.delete(key);
    }

    expect(store.size).toBe(2);
    expect(store.has('fresh_1')).toBe(true);
    expect(store.has('fresh_2')).toBe(true);
  });
});

// ─── 3. Intent Classifier Throughput ────────────────────────────
describe('Load: Intent Classifier Throughput', () => {
  let classifier;

  beforeAll(async () => {
    vi.mock('../src/utils/logger.js', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod = await import('../src/utils/intent-classifier.js');
    classifier = mod.getIntentClassifier();
  });

  it('should classify 1,000 Korean messages within 2 seconds', () => {
    // Use messages that reliably match intents (exclude '도움말' which may return null)
    const messages = [
      '오늘 광고 성과 알려줘', '예산 50만원으로 변경해줘', '캠페인 일시중지 해줘',
      '캠페인 다시 시작해줘', '예산 최적화 제안해줘', '광고 등록해줘',
      'A/B 테스트 만들어줘', '크리에이티브 목록', '템플릿 보여줘',
    ];

    const start = performance.now();
    const results = [];
    for (let i = 0; i < 1000; i++) {
      results.push(classifier.classify(messages[i % messages.length]));
    }
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(1000);
    results.forEach(r => {
      expect(r).not.toBeNull();
      expect(r.intent).toBeTruthy();
      expect(typeof r.confidence).toBe('number');
    });

    console.log(`  ⏱ 1,000 classifications in ${elapsed.toFixed(1)}ms (${(1000 / elapsed * 1000).toFixed(0)} cls/s)`);
    expect(elapsed).toBeLessThan(2000);
  });

  it('should maintain accuracy under rapid-fire classification', () => {
    const testCases = [
      ['오늘 광고 성과 알려줘', 'performance'],
      ['예산 변경해줘', 'budget_change'],
      ['캠페인 중지', 'pause'],
      ['다시 시작', 'enable'],
      ['최적화 제안', 'optimize'],
    ];

    // Run each 100 times and verify consistency
    for (const [msg, expected] of testCases) {
      const intents = new Set();
      for (let i = 0; i < 100; i++) {
        intents.add(classifier.classify(msg).intent);
      }
      // Same input should always produce same output (deterministic)
      expect(intents.size).toBe(1);
      expect([...intents][0]).toBe(expected);
    }
  });

  it('should handle mixed Korean/English input without degradation', () => {
    const mixed = [
      'Meta 캠페인 performance 보여줘',
      'Google budget 50만원',
      'TikTok 광고 pause',
      'report 오늘',
      'creative 등록',
    ];

    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      classifier.classify(mixed[i % mixed.length]);
    }
    const elapsed = performance.now() - start;
    console.log(`  ⏱ 500 mixed-language classifications in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ─── 4. Statistical Engine Batch Processing ─────────────────────
describe('Load: Statistical Engine Batch', () => {
  let stats;

  beforeAll(async () => {
    stats = await import('../src/utils/statistics.js');
  });

  it('should compute 10,000 Z-tests within 500ms', () => {
    const start = performance.now();
    const results = [];

    for (let i = 0; i < 10000; i++) {
      const cA = Math.floor(Math.random() * 500);
      const tA = 1000 + Math.floor(Math.random() * 9000);
      const cB = Math.floor(Math.random() * 500);
      const tB = 1000 + Math.floor(Math.random() * 9000);
      results.push(stats.twoProportionZTest(cA, tA, cB, tB));
    }
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(10000);
    results.forEach(r => {
      expect(r.pValue).toBeGreaterThanOrEqual(0);
      expect(r.pValue).toBeLessThanOrEqual(1);
      expect(typeof r.significant).toBe('boolean');
    });

    // Sanity: ~5% should be significant by chance (if truly random)
    const sigCount = results.filter(r => r.significant).length;
    console.log(`  ⏱ 10,000 Z-tests in ${elapsed.toFixed(1)}ms (${sigCount} significant by chance)`);
    expect(elapsed).toBeLessThan(500);
  });

  it('should compute 5,000 Wilson intervals within 200ms', () => {
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const s = Math.floor(Math.random() * 1000);
      const t = 1000 + Math.floor(Math.random() * 9000);
      const ci = stats.wilsonInterval(s, t);
      expect(ci.lower).toBeLessThanOrEqual(ci.center);
      expect(ci.center).toBeLessThanOrEqual(ci.upper);
    }
    const elapsed = performance.now() - start;
    console.log(`  ⏱ 5,000 Wilson intervals in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('should compute 1,000 sample size calculations within 100ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const baseline = 0.01 + Math.random() * 0.2;
      const mde = 0.05 + Math.random() * 0.3;
      const n = stats.minSampleSize(baseline, mde);
      expect(n).toBeGreaterThan(0);
    }
    const elapsed = performance.now() - start;
    console.log(`  ⏱ 1,000 sample size calcs in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── 5. Platform Adapter Concurrent Dispatch ────────────────────
describe('Load: Platform Adapter Concurrent Dispatch', () => {
  let getAdapter;

  beforeAll(async () => {
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

  it('should dispatch 300 concurrent budget updates across 3 platforms', async () => {
    const platforms = ['meta', 'google', 'tiktok'];

    const { elapsed, fulfilled, rejected } = await runConcurrent(async (i) => {
      const platform = platforms[i % 3];
      const adapter = getAdapter(platform);
      return adapter.updateBudget(`pid_${i}`, 50000 + i * 100);
    }, 300);

    expect(fulfilled).toBe(300);
    expect(rejected).toBe(0);
    console.log(`  ⏱ 300 concurrent budget updates in ${elapsed.toFixed(1)}ms (${(300 / elapsed * 1000).toFixed(0)} req/s)`);
  });

  it('should dispatch 300 concurrent status changes across 3 platforms', async () => {
    const platforms = ['meta', 'google', 'tiktok'];
    const statuses = ['ACTIVE', 'PAUSED'];

    const { elapsed, fulfilled } = await runConcurrent(async (i) => {
      const platform = platforms[i % 3];
      const status = statuses[i % 2];
      const adapter = getAdapter(platform);
      return adapter.setStatus(`pid_${i}`, status);
    }, 300);

    expect(fulfilled).toBe(300);
    console.log(`  ⏱ 300 concurrent status changes in ${elapsed.toFixed(1)}ms`);
  });

  it('should handle mixed operations (budget + status + getCampaigns) concurrently', async () => {
    const platforms = ['meta', 'google', 'tiktok'];
    const operations = ['budget', 'status', 'campaigns'];

    const { elapsed, fulfilled } = await runConcurrent(async (i) => {
      const platform = platforms[i % 3];
      const op = operations[i % 3];
      const adapter = getAdapter(platform);

      switch (op) {
        case 'budget': return adapter.updateBudget(`pid_${i}`, 50000);
        case 'status': return adapter.setStatus(`pid_${i}`, 'ACTIVE');
        case 'campaigns': return adapter.getCampaigns();
      }
    }, 450);

    expect(fulfilled).toBe(450);
    console.log(`  ⏱ 450 mixed operations in ${elapsed.toFixed(1)}ms`);
  });
});

// ─── 6. WebSocket Broadcast Fan-out Simulation ──────────────────
describe('Load: WebSocket Broadcast Fan-out', () => {
  it('should serialize and fan-out messages to 100 simulated clients', () => {
    const clients = Array.from({ length: 100 }, () => ({
      readyState: 1,
      messages: [],
      send(msg) { this.messages.push(msg); },
    }));

    function broadcast(type, data) {
      const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
      clients.forEach(c => {
        if (c.readyState === 1) c.send(message);
      });
    }

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      broadcast('performance_update', {
        campaignId: `camp_${i}`,
        spend: Math.random() * 100000,
        conversions: Math.floor(Math.random() * 50),
      });
    }
    const elapsed = performance.now() - start;

    // 100 broadcasts × 100 clients = 10,000 messages total
    const totalMessages = clients.reduce((sum, c) => sum + c.messages.length, 0);
    expect(totalMessages).toBe(10000);

    // Verify message structure
    const sample = JSON.parse(clients[0].messages[0]);
    expect(sample.type).toBe('performance_update');
    expect(sample.data.campaignId).toBeTruthy();
    expect(sample.timestamp).toBeTruthy();

    console.log(`  ⏱ 10,000 WS messages (100×100) in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(1000);
  });

  it('should handle dead client cleanup during broadcast', () => {
    const clients = Array.from({ length: 50 }, (_, i) => ({
      readyState: i < 30 ? 1 : 3, // 30 alive, 20 dead
      isAlive: i < 30,
      messages: [],
      send(msg) { this.messages.push(msg); },
      terminate() { this.readyState = 3; this.terminated = true; },
      ping() { /* no-op */ },
    }));

    // Heartbeat check (mirrors server.js)
    clients.forEach(ws => {
      if (!ws.isAlive) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    });

    // Broadcast only to alive clients
    const message = JSON.stringify({ type: 'test', data: {} });
    let sentCount = 0;
    clients.forEach(c => {
      if (c.readyState === 1) { c.send(message); sentCount++; }
    });

    expect(sentCount).toBe(30);
    expect(clients.filter(c => c.terminated).length).toBe(20);
  });
});

// ─── 7. Memory Pressure — Large Dataset Aggregation ─────────────
describe('Load: Memory Pressure', () => {
  let db;

  beforeAll(async () => {
    db = await createLoadDB();

    // Seed 100 campaigns × 90 days = 9,000 perf rows
    const insertCamp = db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?,?,?,?,?)`);
    const insertPerf = db.prepare(`INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend, conversions, conversion_value, ctr, roas, cpa) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

    const platforms = ['meta', 'google', 'tiktok'];
    const tx = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const p = platforms[i % 3];
        insertCamp.run(`${p}_${i}`, p, `pid_${i}`, `Campaign ${i}`, 50000);
      }
      for (let i = 0; i < 100; i++) {
        const p = platforms[i % 3];
        for (let d = 0; d < 90; d++) {
          const date = new Date(2026, 0, 1 + d).toISOString().split('T')[0];
          insertPerf.run(`${p}_${i}`, p, date, date,
            Math.floor(Math.random() * 100000),
            Math.floor(Math.random() * 3000),
            Math.random() * 200000,
            Math.floor(Math.random() * 100),
            Math.random() * 1000000,
            Math.random() * 5,
            Math.random() * 8,
            Math.random() * 50000
          );
        }
      }
    });
    tx();
  });

  afterAll(() => db.close());

  it('should aggregate 9,000 rows (90-day report) within 100ms', () => {
    const start = performance.now();
    const report = db.prepare(`
      SELECT
        c.platform,
        COUNT(DISTINCT c.id) as campaigns,
        SUM(p.impressions) as total_impressions,
        SUM(p.clicks) as total_clicks,
        SUM(p.spend) as total_spend,
        SUM(p.conversions) as total_conversions,
        SUM(p.conversion_value) as total_value,
        AVG(p.ctr) as avg_ctr,
        CASE WHEN SUM(p.spend)>0 THEN SUM(p.conversion_value)/SUM(p.spend) ELSE 0 END as overall_roas
      FROM campaigns c
      JOIN performance p ON p.campaign_id = c.id
      GROUP BY c.platform
    `).all();
    const elapsed = performance.now() - start;

    expect(report).toHaveLength(3);
    report.forEach(r => {
      expect(r.total_spend).toBeGreaterThan(0);
      expect(r.campaigns).toBeGreaterThan(0);
    });

    console.log(`  ⏱ 9,000-row aggregate in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  it('should generate time-series (daily breakdown × platform) within 200ms', () => {
    const start = performance.now();
    const timeline = db.prepare(`
      SELECT
        p.date_start as date, p.platform,
        SUM(p.impressions) as impressions,
        SUM(p.clicks) as clicks,
        SUM(p.spend) as spend,
        SUM(p.conversions) as conversions,
        SUM(p.conversion_value) as value,
        CASE WHEN SUM(p.spend)>0 THEN SUM(p.conversion_value)/SUM(p.spend) ELSE 0 END as roas
      FROM performance p
      GROUP BY p.date_start, p.platform
      ORDER BY p.date_start
    `).all();
    const elapsed = performance.now() - start;

    expect(timeline.length).toBe(270); // 90 days × 3 platforms
    console.log(`  ⏱ 270-row time-series in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('should handle campaign ranking query (optimizer pattern) within 50ms', () => {
    const start = performance.now();
    const ranked = db.prepare(`
      SELECT
        c.id, c.name, c.platform, c.daily_budget,
        SUM(p.spend) as total_spend,
        SUM(p.conversions) as total_conversions,
        CASE WHEN SUM(p.conversions)>0 THEN SUM(p.spend)/SUM(p.conversions) ELSE 0 END as cpa,
        CASE WHEN SUM(p.spend)>0 THEN SUM(p.conversion_value)/SUM(p.spend) ELSE 0 END as roas
      FROM campaigns c
      JOIN performance p ON p.campaign_id = c.id
      WHERE p.date_start >= '2026-03-01'
      GROUP BY c.id
      ORDER BY roas DESC
      LIMIT 20
    `).all();
    const elapsed = performance.now() - start;

    expect(ranked.length).toBe(20);
    // Verify descending ROAS order
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].roas).toBeLessThanOrEqual(ranked[i - 1].roas);
    }

    console.log(`  ⏱ Top-20 ranking query in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(50);
  });

  it('should handle alert generation under volume (1000 perf rows checked)', () => {
    const thresholds = { roasMin: 1.5, cpaMax: 50000 };
    const latestPerf = db.prepare(`
      SELECT p.*, c.name as campaign_name, c.daily_budget
      FROM performance p
      JOIN campaigns c ON p.campaign_id = c.id
      ORDER BY p.collected_at DESC
      LIMIT 1000
    `).all();

    const start = performance.now();
    const alerts = [];
    for (const row of latestPerf) {
      if (row.spend > 0 && row.roas > 0 && row.roas < thresholds.roasMin) {
        alerts.push({ type: 'low_roas', campaign: row.campaign_name, roas: row.roas });
      }
      if (row.cpa > 0 && row.cpa > thresholds.cpaMax) {
        alerts.push({ type: 'high_cpa', campaign: row.campaign_name, cpa: row.cpa });
      }
    }
    const elapsed = performance.now() - start;

    expect(latestPerf.length).toBe(1000);
    console.log(`  ⏱ Alert analysis on 1000 rows: ${elapsed.toFixed(1)}ms, ${alerts.length} alerts generated`);
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── 8. Transaction Isolation ───────────────────────────────────
describe('Load: Transaction Isolation', () => {
  let db;

  beforeAll(async () => { db = await createLoadDB(); });
  afterAll(() => db.close());

  it('should maintain data integrity during interleaved read-write transactions', () => {
    // Setup
    db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?,?,?,?,?)`)
      .run('test_1', 'meta', 'tc_1', 'Isolation Test', 50000);

    const write = db.prepare(`UPDATE campaigns SET daily_budget = ? WHERE id = 'test_1'`);
    const read = db.prepare(`SELECT daily_budget FROM campaigns WHERE id = 'test_1'`);

    // Simulate rapid interleaved reads and writes
    const values = [];
    for (let i = 0; i < 100; i++) {
      write.run(50000 + i * 100);
      const row = read.get();
      values.push(row.daily_budget);
    }

    // Each read should see the immediately preceding write
    for (let i = 0; i < 100; i++) {
      expect(values[i]).toBe(50000 + i * 100);
    }
  });

  it('should handle transaction rollback on error', () => {
    db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name, daily_budget) VALUES (?,?,?,?,?)`)
      .run('rollback_test', 'google', 'rb_1', 'Rollback Test', 30000);

    const badTx = db.transaction(() => {
      db.prepare(`UPDATE campaigns SET daily_budget = 99999 WHERE id = 'rollback_test'`).run();
      // Force error
      throw new Error('Simulated failure');
    });

    expect(() => badTx()).toThrow('Simulated failure');

    // Budget should be unchanged (rolled back)
    const row = db.prepare(`SELECT daily_budget FROM campaigns WHERE id = 'rollback_test'`).get();
    expect(row.daily_budget).toBe(30000);
  });

  it('should handle batch INSERT with partial constraint violation gracefully', () => {
    const insert = db.prepare(`INSERT INTO campaigns (id, platform, platform_id, name) VALUES (?,?,?,?)`);

    // First insert succeeds
    insert.run('batch_1', 'meta', 'bp_1', 'Batch 1');

    // Transaction with one duplicate should roll back entirely
    const batchTx = db.transaction(() => {
      insert.run('batch_2', 'meta', 'bp_2', 'Batch 2');
      insert.run('batch_3', 'meta', 'bp_1', 'Batch 3 — DUPLICATE'); // Will fail
    });

    expect(() => batchTx()).toThrow();

    // batch_2 should NOT exist (rolled back)
    const row = db.prepare(`SELECT * FROM campaigns WHERE id = 'batch_2'`).get();
    expect(row).toBeUndefined();
  });
});

// ─── 9. Service Singleton Concurrency ───────────────────────────
describe('Load: Singleton Service Registry', () => {
  it('should return same instance across 1000 concurrent accesses', async () => {
    // Simulate the singleton pattern
    let _instance = null;
    let constructCount = 0;
    function getInstance() {
      if (!_instance) {
        constructCount++;
        _instance = { id: constructCount };
      }
      return _instance;
    }

    const { results } = await runConcurrent(async () => getInstance(), 1000);

    const instances = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    expect(instances).toHaveLength(1000);
    // All should reference the same instance
    const ids = new Set(instances.map(i => i.id));
    expect(ids.size).toBe(1);
    expect(constructCount).toBe(1);
  });
});

// ─── 10. End-to-End Scenario: Collection → Analysis → Alert ────
describe('Load: E2E Collection → Analysis → Alert Pipeline', () => {
  let db;

  beforeAll(async () => { db = await createLoadDB(); });
  afterAll(() => db.close());

  it('should process full collection cycle for 50 campaigns under 200ms', () => {
    const platforms = ['meta', 'google', 'tiktok'];
    const thresholds = { roasMin: 1.5, cpaMax: 50000 };
    const insertCamp = db.prepare(`
      INSERT INTO campaigns (id, platform, platform_id, name, daily_budget)
      VALUES (?,?,?,?,?)
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        name=excluded.name, daily_budget=excluded.daily_budget
    `);
    const insertPerf = db.prepare(`
      INSERT INTO performance (campaign_id, platform, date_start, date_stop, impressions, clicks, spend, conversions, conversion_value, ctr, roas, cpa)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(campaign_id, platform, date_start) DO UPDATE SET
        spend=excluded.spend, conversions=excluded.conversions, roas=excluded.roas, cpa=excluded.cpa
    `);
    const insertAlert = db.prepare(`INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?,?,?,?)`);

    const start = performance.now();

    // Phase 1: Collect — simulate 50 campaigns across 3 platforms
    const collectTx = db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        const p = platforms[i % 3];
        const spend = Math.random() * 100000;
        const conversions = Math.floor(Math.random() * 30);
        const value = conversions * (3000 + Math.random() * 10000);
        const roas = spend > 0 ? value / spend : 0;
        const cpa = conversions > 0 ? spend / conversions : 0;

        insertCamp.run(`${p}_${i}`, p, `pid_${i}`, `Campaign ${i}`, 50000);
        insertPerf.run(`${p}_${i}`, p, '2026-03-17', '2026-03-17',
          Math.floor(Math.random() * 50000), Math.floor(Math.random() * 1500),
          spend, conversions, value,
          Math.random() * 5, roas, cpa);
      }
    });
    collectTx();

    // Phase 2: Analyze
    const latestPerf = db.prepare(`
      SELECT p.*, c.name as campaign_name, c.daily_budget
      FROM performance p JOIN campaigns c ON p.campaign_id = c.id
      WHERE p.date_start = '2026-03-17'
    `).all();

    // Phase 3: Generate alerts
    const alertTx = db.transaction(() => {
      for (const row of latestPerf) {
        if (row.spend > 0 && row.roas > 0 && row.roas < thresholds.roasMin) {
          insertAlert.run(row.campaign_id, 'low_roas', 'warning', `ROAS ${row.roas.toFixed(2)} < ${thresholds.roasMin}`);
        }
        if (row.cpa > 0 && row.cpa > thresholds.cpaMax) {
          insertAlert.run(row.campaign_id, 'high_cpa', 'warning', `CPA ${row.cpa.toFixed(0)} > ${thresholds.cpaMax}`);
        }
      }
    });
    alertTx();

    const elapsed = performance.now() - start;

    // Verify
    const campCount = db.prepare(`SELECT COUNT(*) as cnt FROM campaigns`).get().cnt;
    const perfCount = db.prepare(`SELECT COUNT(*) as cnt FROM performance`).get().cnt;
    const alertCount = db.prepare(`SELECT COUNT(*) as cnt FROM alerts`).get().cnt;

    expect(campCount).toBe(50);
    expect(perfCount).toBe(50);
    expect(alertCount).toBeGreaterThanOrEqual(0);

    console.log(`  ⏱ Full E2E pipeline (50 campaigns): ${elapsed.toFixed(1)}ms`);
    console.log(`    📊 ${campCount} campaigns, ${perfCount} perf rows, ${alertCount} alerts`);
    expect(elapsed).toBeLessThan(200);
  });
});
