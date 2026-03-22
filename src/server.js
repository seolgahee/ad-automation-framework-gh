/**
 * API Server + WebSocket hub for real-time dashboard updates
 *
 * REST endpoints for the React dashboard
 * WebSocket for live performance push
 *
 * Security: Bearer token auth, rate limiting, parameterized queries
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import db, { initDatabase } from './utils/db.js';
import logger from './utils/logger.js';
import DataCollector from './analytics/collector.js';
import { getOptimizer, getPipeline, getTemplateEngine, getABTestEngine, getAudienceManager } from './utils/services.js';
import { getAdapter } from './utils/platform-adapter.js';

// ─── Startup Environment Validation ─────────────────────────────
function validateEnv() {
  const warnings = [];
  const metaVars = ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'];
  const googleVars = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];

  const missingMeta = metaVars.filter(v => !process.env[v]);
  const missingGoogle = googleVars.filter(v => !process.env[v]);

  if (missingMeta.length > 0) warnings.push(`Meta API disabled — missing: ${missingMeta.join(', ')}`);
  if (missingGoogle.length > 0) warnings.push(`Google API disabled — missing: ${missingGoogle.join(', ')}`);
  if (!process.env.DB_PATH) warnings.push('DB_PATH not set — using default ./data/ads.db');

  warnings.forEach(w => logger.warn(w));
  return { metaReady: missingMeta.length === 0, googleReady: missingGoogle.length === 0 };
}
const envStatus = validateEnv();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.API_PORT || 3099;
const API_TOKEN = process.env.API_AUTH_TOKEN || '';
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── CRITICAL #2: Authentication Middleware ─────────────────────
function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next(); // Skip auth if no token configured (dev mode)

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || header.slice(7) !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — provide valid Bearer token' });
  }
  next();
}
app.use('/api', authMiddleware);

// ─── HIGH #5: Rate Limiting ─────────────────────────────────────
const rateLimitStore = new Map();
function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.start > windowMs) {
      rateLimitStore.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — try again later' });
    }
    next();
  };
}
// Periodic cleanup of expired rate limit entries (prevents memory leak)
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > 300000) rateLimitStore.delete(key); // 5 min expiry
  }
}, 60000);

// Stricter rate limit on mutation endpoints
const mutationLimiter = rateLimit({ windowMs: 60000, max: 20 });
const readLimiter = rateLimit({ windowMs: 60000, max: 120 });
app.get('/api/*', readLimiter);
app.post('/api/*', mutationLimiter);

// ─── HIGH #9: Input Validation Helpers ──────────────────────────
const ALLOWED_PLATFORMS = ['meta', 'google', 'tiktok'];
const ALLOWED_STATUSES = ['ACTIVE', 'PAUSED', 'ENABLED', 'DRAFT', 'UPLOADED'];

function validatePlatform(platform) {
  return platform && ALLOWED_PLATFORMS.includes(platform);
}

function validateDays(raw, fallback = 7) {
  const days = parseInt(raw);
  return isNaN(days) ? fallback : Math.max(1, Math.min(days, 365));
}

function validateRequired(body, fields) {
  const missing = fields.filter(f => !body[f] && body[f] !== 0);
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  return null;
}

// ─── Safe Error Response Helper ─────────────────────────────────
function safeError(res, err, context = 'operation') {
  logger.error(`${context} failed`, { error: err.message, stack: err.stack });
  res.status(500).json({ error: `${context} 처리 중 오류가 발생했습니다.` });
}

// ─── WebSocket: broadcast + heartbeat (#13 WS cleanup) ──────────
function broadcastToClients(type, data) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(message);
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  logger.info('Dashboard client connected');
  ws.send(JSON.stringify({ type: 'connected', data: { message: 'Ad Automation Dashboard' } }));
});

// Heartbeat: detect and clean up dead connections every 30s
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Shared module singletons via registry ──────────────────────
const optimizer = getOptimizer();

// ─── REST API: Dashboard Endpoints ───────────────────────────────

/** GET /api/overview — High-level KPIs */
app.get('/api/overview', (req, res) => {
  const { since, until, platform } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform — use "meta", "google", or "tiktok"' });
  }

  const summary = optimizer.getSummary(days, since || null, until || null);
  const filtered = platform ? summary.filter(c => c.platform === platform) : summary;

  const totals = filtered.reduce((acc, c) => ({
    spend: acc.spend + (c.total_spend || 0),
    conversions: acc.conversions + (c.total_conversions || 0),
    value: acc.value + (c.total_value || 0),
    impressions: acc.impressions + (c.total_impressions || 0),
    clicks: acc.clicks + (c.total_clicks || 0),
  }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });

  res.json({
    days,
    totalSpend: totals.spend,
    totalConversions: totals.conversions,
    totalValue: totals.value,
    roas: totals.spend > 0 ? totals.value / totals.spend : 0,
    cpa: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    activeCampaigns: filtered.filter(c => c.total_spend > 0).length,
    byPlatform: {
      meta: summary.filter(c => c.platform === 'meta'),
      google: summary.filter(c => c.platform === 'google'),
      tiktok: summary.filter(c => c.platform === 'tiktok'),
    },
  });
});

/** GET /api/campaigns — All campaigns with latest performance */
app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT SUM(p.spend) FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-1 day')) as today_spend,
      (SELECT SUM(p.conversions) FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-1 day')) as today_conversions,
      (SELECT AVG(p.roas) FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-7 days')) as week_roas
    FROM campaigns c
    WHERE c.status = 'ACTIVE'
    ORDER BY c.platform, c.name
  `).all();
  res.json(campaigns);
});

/** GET /api/performance/timeline — Time series data for charts (CRITICAL #1 FIX) */
app.get('/api/performance/timeline', (req, res) => {
  const { since, until } = req.query;
  const days = validateDays(req.query.days, 14);
  const platform = req.query.platform;

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform — use "meta", "google", or "tiktok"' });
  }

  let query = `
    SELECT
      date_start as date,
      platform,
      SUM(impressions) as impressions,
      SUM(clicks) as clicks,
      SUM(spend) as spend,
      SUM(conversions) as conversions,
      SUM(conversion_value) as value,
      AVG(ctr) as ctr,
      CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE 0 END as cpc,
      CASE WHEN SUM(spend) > 0 THEN SUM(conversion_value) / SUM(spend) ELSE 0 END as roas
    FROM performance
    WHERE ${since && until ? `date_start >= ? AND date_start <= ?` : `date_start >= date('now', ? || ' days')`}
  `;
  const params = since && until ? [since, until] : [`-${days}`];

  if (platform) {
    query += ` AND platform = ?`;
    params.push(platform);
  }
  query += ` GROUP BY date_start, platform ORDER BY date_start`;

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

/** GET /api/alerts — Recent alerts */
app.get('/api/alerts', (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
  const alerts = db.prepare(`
    SELECT a.*, c.name as campaign_name, c.platform
    FROM alerts a
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(alerts);
});

/** POST /api/alerts/:id/acknowledge */
app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid alert ID' });
  db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`).run(id);
  res.json({ success: true });
});

/** GET /api/optimization — Budget optimization suggestions */
app.get('/api/optimization', (req, res) => {
  const totalBudget = parseInt(req.query.budget) || undefined;
  const plan = optimizer.getReallocationPlan(totalBudget);
  const trends = optimizer.getTrends();
  res.json({ plan, trends });
});

/** POST /api/campaigns/:id/budget — Change budget (uses singleton clients) */
app.post('/api/campaigns/:id/budget', async (req, res) => {
  const { newBudget } = req.body;
  if (!newBudget || typeof newBudget !== 'number' || newBudget <= 0) {
    return res.status(400).json({ error: 'newBudget must be a positive number' });
  }

  const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  try {
    await getAdapter(campaign.platform).updateBudget(campaign.platform_id, newBudget);

    db.prepare(`INSERT INTO budget_history (campaign_id, old_budget, new_budget, reason, triggered_by)
      VALUES (?, ?, ?, 'dashboard', 'user')`).run(campaign.id, campaign.daily_budget, newBudget);
    db.prepare(`UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?`).run(newBudget, campaign.id);

    broadcastToClients('budget_changed', { campaignId: campaign.id, newBudget });
    res.json({ success: true });
  } catch (err) {
    safeError(res, err, 'Budget update');
  }
});

/** POST /api/campaigns/:id/status — Pause/Enable */
app.post('/api/campaigns/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!status || !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status — use one of: ${ALLOWED_STATUSES.join(', ')}` });
  }

  const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  try {
    await getAdapter(campaign.platform).setStatus(campaign.platform_id, status);

    db.prepare(`UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, campaign.id);
    broadcastToClients('status_changed', { campaignId: campaign.id, status });
    res.json({ success: true });
  } catch (err) {
    safeError(res, err, 'Status change');
  }
});

/** GET /api/budget-history/:campaignId */
app.get('/api/budget-history/:campaignId', (req, res) => {
  const history = db.prepare(
    `SELECT * FROM budget_history WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(req.params.campaignId);
  res.json(history);
});

// ─── Content API: Creatives, Templates, A/B Tests, Audiences ─────

const creativePipeline = getPipeline();
const templateEngine = getTemplateEngine();
const abTestEngine = getABTestEngine();
const audienceManager = getAudienceManager();

// --- Templates ---

/** GET /api/templates — List all copy templates */
app.get('/api/templates', (req, res) => {
  const platform = req.query.platform;
  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  res.json(templateEngine.listTemplates(platform));
});

/** GET /api/templates/:id/preview — Preview template with example data */
app.get('/api/templates/:id/preview', (req, res) => {
  const preview = templateEngine.preview(req.params.id);
  if (!preview) return res.status(404).json({ error: 'Template not found' });
  res.json(preview);
});

/** POST /api/templates — Create a custom template */
app.post('/api/templates', (req, res) => {
  const err = validateRequired(req.body, ['id', 'platform', 'name', 'headline']);
  if (err) return res.status(400).json({ error: err });
  if (!validatePlatform(req.body.platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    const result = templateEngine.createTemplate(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Creatives ---

/** GET /api/creatives — List creatives with optional filters */
app.get('/api/creatives', (req, res) => {
  const { platform, status, campaignId, abGroup } = req.query;
  res.json(creativePipeline.getCreatives({ platform, status, campaignId, abGroup }));
});

/** GET /api/creatives/:id — Single creative detail */
app.get('/api/creatives/:id', (req, res) => {
  const creative = creativePipeline.getCreativeById(req.params.id);
  if (!creative) return res.status(404).json({ error: 'Creative not found' });
  res.json(creative);
});

/** POST /api/creatives/assemble — Assemble a creative from template (DRAFT) */
app.post('/api/creatives/assemble', async (req, res) => {
  const err = validateRequired(req.body, ['templateId', 'variables', 'platform', 'landingUrl']);
  if (err) return res.status(400).json({ error: err });
  if (!validatePlatform(req.body.platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    const result = await creativePipeline.assembleCreative(req.body);
    broadcastToClients('creative_assembled', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Creative assemble');
  }
});

/** POST /api/creatives/:id/register — Register a DRAFT creative to platform */
app.post('/api/creatives/:id/register', async (req, res) => {
  const { platform, campaignId, adSetId, pageId } = req.body;
  const err = validateRequired(req.body, ['platform', 'campaignId', 'adSetId']);
  if (err) return res.status(400).json({ error: err });
  if (!validatePlatform(platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    if (platform === 'meta' && !pageId) {
      return res.status(400).json({ error: 'pageId is required for Meta' });
    }
    const registrationMap = {
      meta: () => creativePipeline.registerToMeta({ creativeId: req.params.id, campaignId, adSetId, pageId }),
      google: () => creativePipeline.registerToGoogle({ creativeId: req.params.id, campaignId, adGroupId: adSetId }),
      tiktok: () => creativePipeline.registerToTikTok({ creativeId: req.params.id, campaignId, adGroupId: adSetId }),
    };
    const result = await registrationMap[platform]();
    broadcastToClients('creative_registered', { creativeId: req.params.id, ...result });
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Creative register');
  }
});

/** POST /api/creatives/pipeline — Full pipeline: template → assemble → register */
app.post('/api/creatives/pipeline', async (req, res) => {
  const err = validateRequired(req.body, ['platform', 'templateId', 'variables', 'campaignId', 'adSetId', 'landingUrl']);
  if (err) return res.status(400).json({ error: err });
  if (!validatePlatform(req.body.platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    const result = await creativePipeline.runFullPipeline(req.body);
    broadcastToClients('pipeline_complete', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Creative pipeline');
  }
});

/** GET /api/creatives/diversity — P.D.A semantic diversity check for a campaign */
app.get('/api/creatives/diversity', (req, res) => {
  const creatives = creativePipeline.getCreatives({ campaignId: req.query.campaignId });
  res.json(creativePipeline.checkSemanticDiversity(creatives));
});

// --- A/B Tests ---

/** GET /api/ab-tests — List all A/B tests */
app.get('/api/ab-tests', (req, res) => {
  const status = req.query.status;
  res.json(abTestEngine.getTests(status));
});

/** GET /api/ab-tests/:id — Single test detail */
app.get('/api/ab-tests/:id', (req, res) => {
  const test = abTestEngine.getTestById(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found' });
  res.json(test);
});

/** POST /api/ab-tests — Create a new A/B test */
app.post('/api/ab-tests', async (req, res) => {
  const err = validateRequired(req.body, ['name', 'platform', 'templateId', 'baseVariables', 'variations', 'campaignId', 'adSetId', 'landingUrl']);
  if (err) return res.status(400).json({ error: err });
  if (!validatePlatform(req.body.platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    const result = await abTestEngine.createTest(req.body);
    broadcastToClients('ab_test_created', { testId: result.testId, name: result.name });
    res.json(result);
  } catch (e) {
    safeError(res, e, 'A/B test create');
  }
});

/** POST /api/ab-tests/:id/evaluate — Evaluate running test */
app.post('/api/ab-tests/:id/evaluate', async (req, res) => {
  try {
    const evaluation = await abTestEngine.evaluateTest(req.params.id);
    if (!evaluation) return res.status(404).json({ error: 'Test not found or not running' });
    broadcastToClients('ab_test_evaluated', evaluation);
    res.json(evaluation);
  } catch (err) {
    safeError(res, err, 'A/B test evaluate');
  }
});

// --- Audiences ---

/** GET /api/audiences — List all audiences */
app.get('/api/audiences', (req, res) => {
  const platform = req.query.platform;
  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  res.json(audienceManager.getAudiences(platform));
});

/** GET /api/audiences/presets — Get targeting presets */
app.get('/api/audiences/presets', (req, res) => {
  res.json(audienceManager.getTargetingPresets());
});

/** POST /api/audiences/meta/pixel — Create Meta pixel audience */
app.post('/api/audiences/meta/pixel', async (req, res) => {
  const err = validateRequired(req.body, ['name']);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await audienceManager.createMetaPixelAudience(req.body);
    broadcastToClients('audience_created', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Meta pixel audience');
  }
});

/** POST /api/audiences/meta/customer-list — Create Meta customer list audience */
app.post('/api/audiences/meta/customer-list', async (req, res) => {
  const err = validateRequired(req.body, ['name']);
  if (err) return res.status(400).json({ error: err });
  if (!req.body.emails?.length && !req.body.phones?.length) {
    return res.status(400).json({ error: 'Provide at least one of: emails, phones' });
  }
  try {
    const result = await audienceManager.createMetaCustomerListAudience(req.body);
    broadcastToClients('audience_created', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Meta customer list audience');
  }
});

/** POST /api/audiences/meta/lookalike — Create Meta lookalike audience */
app.post('/api/audiences/meta/lookalike', async (req, res) => {
  const err = validateRequired(req.body, ['name', 'sourceAudienceId']);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await audienceManager.createMetaLookalikeAudience(req.body);
    broadcastToClients('audience_created', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Meta lookalike audience');
  }
});

/** POST /api/audiences/google/remarketing — Create Google remarketing list */
app.post('/api/audiences/google/remarketing', async (req, res) => {
  const err = validateRequired(req.body, ['name', 'visitedUrls']);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await audienceManager.createGoogleRemarketingList(req.body);
    broadcastToClients('audience_created', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Google remarketing list');
  }
});

/** POST /api/audiences/google/customer-match — Create Google customer match list */
app.post('/api/audiences/google/customer-match', async (req, res) => {
  const err = validateRequired(req.body, ['name', 'emails']);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await audienceManager.createGoogleCustomerMatchList(req.body);
    broadcastToClients('audience_created', result);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Google customer match');
  }
});

/** POST /api/audiences/apply — Apply targeting preset + audiences to ad set */
app.post('/api/audiences/apply', async (req, res) => {
  const err = validateRequired(req.body, ['adSetId', 'platform', 'presetId']);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await audienceManager.applyTargetingToAdSet(req.body);
    res.json(result);
  } catch (e) {
    safeError(res, e, 'Apply targeting');
  }
});

// ─── Ad Performance (Creative-level) ─────────────────────────────

/** GET /api/ad-performance — Ad-level performance data for Creatives gallery */
app.get('/api/ad-performance', (req, res) => {
  const { platform, sort, order, since, until } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const allowedSorts = ['spend', 'roas', 'ctr', 'impressions', 'clicks', 'cpa', 'cpc', 'conversions', 'date_start'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'spend';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

  let query = `
    SELECT
      ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
      platform, date_start,
      SUM(impressions) as impressions,
      SUM(clicks) as clicks,
      SUM(spend) as spend,
      SUM(conversions) as conversions,
      SUM(conversion_value) as conversion_value,
      CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) * 100 ELSE 0 END as ctr,
      CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE 0 END as cpc,
      CASE WHEN SUM(impressions) > 0 THEN SUM(spend) / SUM(impressions) * 1000 ELSE 0 END as cpm,
      CASE WHEN SUM(spend) > 0 THEN SUM(conversion_value) / SUM(spend) ELSE 0 END as roas,
      CASE WHEN SUM(conversions) > 0 THEN SUM(spend) / SUM(conversions) ELSE 0 END as cpa,
      MAX(collected_at) as collected_at
    FROM ad_performance
    WHERE ${since && until ? 'date_start >= ? AND date_start <= ?' : "date_start >= date('now', ? || ' days')"}
  `;
  const params = since && until ? [since, until] : [`-${days}`];

  if (platform) {
    query += ' AND platform = ?';
    params.push(platform);
  }
  if (req.query.campaign_id) {
    query += ' AND campaign_id = ?';
    params.push(req.query.campaign_id);
  }
  if (req.query.adset_id) {
    query += ' AND adset_id = ?';
    params.push(req.query.adset_id);
  }

  query += ` GROUP BY ad_id, platform ORDER BY ${sortCol} ${sortOrder}`;

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

/** GET /api/ad-performance/summary — Aggregate stats for the Creatives header */
app.get('/api/ad-performance/summary', (req, res) => {
  const { platform, since, until } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  let query = `
    SELECT
      COUNT(DISTINCT ad_id) as total_ads,
      SUM(spend) as total_spend,
      SUM(impressions) as total_impressions,
      SUM(clicks) as total_clicks,
      SUM(conversions) as total_conversions,
      SUM(conversion_value) as total_value,
      CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) * 100 ELSE 0 END as avg_ctr,
      CASE WHEN SUM(spend) > 0 THEN SUM(conversion_value) / SUM(spend) ELSE 0 END as avg_roas,
      CASE WHEN SUM(conversions) > 0 THEN SUM(spend) / SUM(conversions) ELSE 0 END as avg_cpa
    FROM ad_performance
    WHERE ${since && until ? 'date_start >= ? AND date_start <= ?' : "date_start >= date('now', ? || ' days')"}
  `;
  const params = since && until ? [since, until] : [`-${days}`];

  if (platform) {
    query += ' AND platform = ?';
    params.push(platform);
  }
  if (req.query.campaign_id) {
    query += ' AND campaign_id = ?';
    params.push(req.query.campaign_id);
  }
  if (req.query.adset_id) {
    query += ' AND adset_id = ?';
    params.push(req.query.adset_id);
  }

  const row = db.prepare(query).get(...params);
  res.json(row);
});

/** GET /api/ad-performance/filters — Campaign/Adset filter options */
app.get('/api/ad-performance/filters', (req, res) => {
  const { platform, campaign_id } = req.query;

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  let campaignQuery = 'SELECT DISTINCT campaign_id, campaign_name FROM ad_performance WHERE 1=1';
  const campaignParams = [];
  if (platform) {
    campaignQuery += ' AND platform = ?';
    campaignParams.push(platform);
  }
  campaignQuery += ' ORDER BY campaign_name';
  const campaigns = db.prepare(campaignQuery).all(...campaignParams);

  let adsetQuery = 'SELECT DISTINCT adset_id, adset_name, campaign_id FROM ad_performance WHERE 1=1';
  const adsetParams = [];
  if (platform) {
    adsetQuery += ' AND platform = ?';
    adsetParams.push(platform);
  }
  if (campaign_id) {
    adsetQuery += ' AND campaign_id = ?';
    adsetParams.push(campaign_id);
  }
  adsetQuery += ' ORDER BY adset_name';
  const adsets = db.prepare(adsetQuery).all(...adsetParams);

  res.json({ campaigns, adsets });
});

// ─── LOW #11: Chat Endpoint (connects dashboard to AdManagerSkill) ──
import { AdManagerSkill } from './openclaw-skills/ad-manager.skill.js';
const chatSkill = new AdManagerSkill();

app.post('/api/chat', rateLimit({ max: 30 }), async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) is required' });
  }
  try {
    const reply = await chatSkill.handleMessage(message.slice(0, 1000), {});
    res.json({ reply });
  } catch (e) {
    logger.error('Chat handler error', { error: e.message });
    res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
});

// ─── Start ───────────────────────────────────────────────────────

initDatabase();

// Start data collector
const collector = new DataCollector();
collector.start();

// Push fresh data to dashboard clients after each collection cycle (event-driven)
collector.on('collected', () => {
  broadcastToClients('performance_update', optimizer.getSummary(1));
});

server.listen(PORT, () => {
  logger.info(`API server running on http://localhost:${PORT}`);
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  if (!API_TOKEN) logger.warn('API_AUTH_TOKEN not set — running without authentication (dev mode)');
});

// ─── LOW #19: Graceful Shutdown ──────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  clearInterval(heartbeatInterval);
  clearInterval(rateLimitCleanupInterval);

  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));

  server.close(() => {
    db.close();
    logger.info('Server stopped');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
