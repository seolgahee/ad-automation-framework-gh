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
import { getMetaClient, getGoogleClient } from './utils/clients.js';
import crypto from 'crypto';
import path from 'path';
import { getAdapter } from './utils/platform-adapter.js';
import { startSlackBot } from './slack-bot.js';
import notifier from './utils/notifier.js';
import { krwFmt } from './utils/format.js';
import multer from 'multer';
import fs from 'fs';
import sharp from 'sharp';

const CREATIVE_IMAGE_DIR = path.join(process.cwd(), 'data', 'creative-images');

// Google PMAX 이미지 타입별 요구 사양
const PMAX_IMAGE_SPECS = {
  MARKETING_IMAGE:          { width: 1200, height: 628  },
  SQUARE_MARKETING_IMAGE:   { width: 1200, height: 1200 },
  PORTRAIT_MARKETING_IMAGE: { width: 960,  height: 1200 },
  LOGO:                     { width: 1200, height: 1200 },
};

/**
 * 이미지 버퍼를 PMAX 요구 사양에 맞게 리사이즈 (cover crop)
 * @param {Buffer} inputBuffer
 * @param {string} fieldType - PMAX field type
 * @returns {Promise<Buffer>}
 */
async function resizeForPmax(inputBuffer, fieldType) {
  const spec = PMAX_IMAGE_SPECS[fieldType];
  if (!spec) return inputBuffer;
  const meta = await sharp(inputBuffer).metadata();
  // 원본이 이미 규격과 일치하면 리사이즈 없이 그대로 반환
  if (meta.width === spec.width && meta.height === spec.height) {
    return inputBuffer;
  }
  return sharp(inputBuffer)
    .resize(spec.width, spec.height, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다'));
  },
});

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
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.API_PORT || 3099;
const API_TOKEN = process.env.API_AUTH_TOKEN || '';
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── 썸네일 전용 경로 (/api 외부 → 인증 불필요) ─────────────────
/** GET /thumbnails/library/:id — creative_library BLOB 이미지 서빙 */
app.get('/thumbnails/library/:id', (req, res) => {
  const row = db.prepare(`SELECT image_data, mime_type FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row?.image_data) return res.status(404).end();
  res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(row.image_data));
});

/** GET /thumbnails/meta/:adId — Meta 로컬 캐시 이미지 서빙 */
app.get('/thumbnails/meta/:adId', (req, res) => {
  const filePath = path.join(CREATIVE_IMAGE_DIR, `${req.params.adId}.jpg`);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

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

// Rate limit: GET은 제한 없음 (로컬 대시보드), POST/mutation만 제한
const mutationLimiter = rateLimit({ windowMs: 60000, max: 120 });
app.post('/api/*', (req, res, next) => {
  if (req.originalUrl.includes('/meta/upload-image')) return next(); // 이미지 업로드는 rate limit 제외
  mutationLimiter(req, res, next);
});

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
  // FacebookRequestError: err.response = parsed error body from Meta API
  const metaBody = err?.response && typeof err.response === 'object' ? err.response : {};
  // Google Ads API: err.errors is array of {error_code, message, location}
  const googleErrors = Array.isArray(err?.errors) ? err.errors : [];

  let detail;
  if (googleErrors.length > 0) {
    detail = googleErrors.map(e => {
      const errorType = e.error_code ? Object.entries(e.error_code).map(([k,v]) => `${k}:${v}`).join(',') : '';
      return errorType ? `[${errorType}] ${e.message}` : e.message;
    }).join('; ');
  } else {
    const raw = metaBody.message || err?.message || String(err);
    detail = typeof raw === 'object' ? JSON.stringify(raw) : raw;
  }

  const code = metaBody.code || metaBody.error_subcode || err?.status || null;
  const errorType = metaBody.type || null;
  const traceId = metaBody.fbtrace_id || null;

  logger.error(`${context} failed`, {
    error: detail, code, errorType, traceId,
    metaBody: JSON.stringify(metaBody),
    googleErrors: googleErrors.length ? JSON.stringify(googleErrors) : undefined,
    stack: err.stack,
  });

  let msg = detail;
  if (code) msg = `[code ${code}] ${msg}`;
  if (errorType) msg = `${msg} (${errorType})`;
  res.status(500).json({ error: msg });
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
      (SELECT SUM(p.spend) FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-7 days')) as today_spend,
      (SELECT SUM(p.conversions) FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-7 days')) as today_conversions,
      (SELECT CASE WHEN SUM(p.spend) > 0 THEN SUM(p.conversion_value) / SUM(p.spend) ELSE 0 END FROM performance p WHERE p.campaign_id = c.id AND p.date_start >= date('now', '-7 days')) as week_roas
    FROM campaigns c
    WHERE c.status = 'ACTIVE'
      AND (c.stop_time IS NULL OR c.stop_time > datetime('now'))
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
      CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) ELSE 0 END as ctr,
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

/**
 * POST /api/meta/upload-image
 * 이미지 파일을 받아 Meta Ad Account에 업로드하고 image_hash 반환
 */
app.post('/api/meta/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '이미지 파일이 없습니다' });
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });

    const result = await meta.account.createAdImage([], {
      bytes: req.file.buffer.toString('base64'),
    });
    const images = result._data?.images;
    const hash = images ? Object.values(images)[0]?.hash : null;
    const url  = images ? Object.values(images)[0]?.url  : null;
    if (!hash) throw new Error('Meta 이미지 업로드 실패');

    logger.info('Image uploaded to Meta via drag-drop', { hash, size: req.file.size });
    res.json({ hash, url, filename: req.file.originalname, size: req.file.size });
  } catch (e) {
    safeError(res, e, 'Meta upload-image');
  }
});

/** GET /api/meta/pixels — 광고 계정의 Meta 픽셀 목록 */
app.get('/api/meta/pixels', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });
    const pixels = await meta.getPixels();
    res.json(pixels);
  } catch (e) {
    safeError(res, e, 'Meta getPixels');
  }
});

/** GET /api/meta/instagram-accounts — 비즈니스에 연결된 Instagram 계정 목록 */
app.get('/api/meta/instagram-accounts', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });
    const accounts = await meta.getInstagramAccounts();
    res.json(accounts);
  } catch (e) {
    safeError(res, e, 'Meta getInstagramAccounts');
  }
});

/** GET /api/meta/pages — 비즈니스에 연결된 Facebook 페이지 목록 */
app.get('/api/meta/pages', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });
    const pages = await meta.getPages();
    res.json(pages);
  } catch (e) {
    safeError(res, e, 'Meta getPages');
  }
});

/** GET /api/meta/campaigns/:campaignId/adsets — Meta 캠페인의 광고 세트 목록 */
app.get('/api/meta/campaigns/:campaignId/adsets', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });

    // 내부 DB ID → Meta platform_id 변환
    const row = db.prepare('SELECT platform_id FROM campaigns WHERE id = ? OR platform_id = ?')
      .get(req.params.campaignId, req.params.campaignId);
    const platformId = row?.platform_id || req.params.campaignId;

    const adSets = await meta.getAdSets(platformId);
    res.json(adSets);
  } catch (e) {
    safeError(res, e, 'Meta getAdSets');
  }
});

/**
 * POST /api/meta/creative/direct
 * Meta API 직접 소재 등록 (템플릿 불필요)
 * Body: { name, pageId, adSetId, campaignId, message, headline, description,
 *         link, imageUrl, mediaPath, callToAction, adStatus,
 *         abGroup, persona_tag, desire_tag, awareness_stage }
 */
app.post('/api/meta/creative/direct', async (req, res) => {
  const err = validateRequired(req.body, ['name', 'pageId', 'adSetId', 'campaignId', 'message', 'link']);
  if (err) return res.status(400).json({ error: err });

  const {
    name, pageId, adSetId, campaignId,
    message, headline, description, link,
    imageUrl, mediaPath, callToAction = 'LEARN_MORE',
    adStatus = 'PAUSED', instagramAccountId, conversionEvent,
    abGroup, persona_tag, desire_tag, awareness_stage,
  } = req.body;

  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });

    // 이미지 처리 (로컬 파일 우선, 없으면 URL)
    let imageHash = null;
    let resolvedImageUrl = imageUrl || null;
    if (mediaPath) {
      const { imageHash: hash } = await creativePipeline.uploadImageToMeta(mediaPath);
      imageHash = hash;
      resolvedImageUrl = null;
    }

    logger.info('Creating Meta creative', {
      name, pageId, adSetId, instagramAccountId, callToAction,
      hasImageHash: !!imageHash, hasImageUrl: !!resolvedImageUrl,
    });

    // Meta AdCreative 생성
    const adCreative = await meta.createCreative({
      name, pageId, instagramAccountId: instagramAccountId || null,
      message, headline, description,
      link, imageHash, imageUrl: resolvedImageUrl, callToAction,
    });
    logger.info('Meta creative created OK', { creativeId: adCreative.id });

    // 전환 이벤트가 선택된 경우 픽셀 자동 조회
    let resolvedPixelId = null;
    if (conversionEvent) {
      const pixelList = await meta.getPixels().catch(() => []);
      resolvedPixelId = pixelList.length > 0 ? pixelList[0].id : null;
    }

    // Meta Ad 생성
    const ad = await meta.createAd({
      adSetId, creativeId: adCreative.id, name, status: adStatus,
      pixelId: resolvedPixelId, conversionEvent: conversionEvent || null,
    });

    // 내부 DB에도 기록
    const creativeId = `cr_${crypto.randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO creatives
        (id, platform, platform_id, campaign_id, ad_set_id, name, type,
         status, headline, description, body_text, cta, media_url, landing_url,
         ab_group, metadata_json)
      VALUES (?, 'meta', ?, ?, ?, ?, 'image', 'UPLOADED', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      creativeId, ad.id, campaignId, adSetId, name,
      headline || null, description || null, message,
      callToAction, resolvedImageUrl || null, link,
      abGroup || null,
      JSON.stringify({ metaCreativeId: adCreative.id, persona_tag, desire_tag, awareness_stage }),
    );

    broadcastToClients('creative_registered', { creativeId, adId: ad.id });
    res.json({ success: true, creativeId, adId: ad.id, metaCreativeId: adCreative.id });
  } catch (e) {
    safeError(res, e, 'Meta direct creative');
  }
});

// ─── Creative Library (BLOB 저장) ─────────────────────────────

const libraryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

/** GET /api/creative-library — 라이브러리 전체 목록 (lib_thumb base64 포함) */
app.get('/api/creative-library', async (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, original_name, width, height, file_size, mime_type, ad_id, persona, desire, awareness, image_data, created_at
     FROM creative_library ORDER BY created_at DESC`
  ).all();

  const enriched = await Promise.all(rows.map(async row => {
    const { image_data, ...rest } = row;
    if (!image_data) return rest;
    try {
      const buf = await sharp(Buffer.from(image_data))
        .resize(400, 400, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 75 })
        .toBuffer();
      return { ...rest, lib_thumb: `data:image/jpeg;base64,${buf.toString('base64')}` };
    } catch (_) {
      return rest;
    }
  }));

  res.json(enriched);
});

/** POST /api/creative-library/upload — 이미지 업로드 (여러 장, BLOB 저장) */
app.post('/api/creative-library/upload', libraryUpload.array('images', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: '이미지 파일이 없습니다' });

  // 1단계: sharp 처리 전부 완료 (async, DB 접근 없음)
  const processed = await Promise.allSettled(req.files.map(async file => {
    const id = `lib_${crypto.randomBytes(8).toString('hex')}`;
    const image = sharp(file.buffer);
    const meta = await image.metadata();
    const jpegBuffer = await image.jpeg({ quality: 90 }).toBuffer();
    return { id, file, meta, jpegBuffer };
  }));

  // 2단계: 단일 트랜잭션으로 DB 일괄 저장 (동시 쓰기 충돌 방지)
  const results = [];
  const insert = db.prepare(`
    INSERT INTO creative_library (id, name, original_name, width, height, file_size, mime_type, image_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(items => {
    for (const { id, file, meta, jpegBuffer } of items) {
      insert.run(id, file.originalname.replace(/\.[^/.]+$/, ''), file.originalname,
        meta.width, meta.height, jpegBuffer.length, 'image/jpeg', jpegBuffer);
      results.push({ id, name: file.originalname.replace(/\.[^/.]+$/, ''), width: meta.width, height: meta.height });
    }
  });

  const successItems = processed.filter(r => r.status === 'fulfilled').map(r => r.value);
  processed.filter(r => r.status === 'rejected').forEach(r =>
    logger.warn('Library sharp failed', { error: r.reason?.message })
  );

  try {
    insertAll(successItems);
  } catch (e) {
    logger.warn('Library DB insert failed', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
  res.json({ success: true, uploaded: results.length, results });
});

/** PATCH /api/creative-library/:id — 이름 변경 */
app.patch('/api/creative-library/:id', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const row = db.prepare(`SELECT id FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE creative_library SET name = ? WHERE id = ?`).run(name.trim(), req.params.id);
  res.json({ success: true });
});

/** PATCH /api/creative-library/:id/ad-mapping — Meta ad_id 연결 */
app.patch('/api/creative-library/:id/ad-mapping', (req, res) => {
  const { ad_id } = req.body;
  const row = db.prepare(`SELECT id FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE creative_library SET ad_id = ? WHERE id = ?`).run(ad_id || null, req.params.id);
  res.json({ success: true });
});

/** PATCH /api/creative-library/:id/pda — P.D.A 태그 저장 */
app.patch('/api/creative-library/:id/pda', (req, res) => {
  const { persona, desire, awareness } = req.body;
  const row = db.prepare(`SELECT id FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE creative_library SET persona = ?, desire = ?, awareness = ? WHERE id = ?`)
    .run(persona || null, desire || null, awareness || null, req.params.id);
  res.json({ success: true });
});

/** DELETE /api/creative-library/:id — 삭제 */
app.delete('/api/creative-library/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM creative_library WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

/** GET /api/creative-library/thumbnail/:id — 이미지 서빙 (<img src> 용, 인증 불필요) */
app.get('/api/creative-library/thumbnail/:id', (req, res) => {
  const row = db.prepare(`SELECT image_data, mime_type FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row?.image_data) return res.status(404).end();
  res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(row.image_data));
});

/** GET /api/creative-library/image/:id?fieldType=MARKETING_IMAGE — PMAX용 base64 (리사이즈 포함) */
app.get('/api/creative-library/image/:id', async (req, res) => {
  const row = db.prepare(`SELECT image_data FROM creative_library WHERE id = ?`).get(req.params.id);
  if (!row?.image_data) return res.status(404).json({ error: 'Not found' });
  try {
    const rawBuffer = Buffer.from(row.image_data);
    const { fieldType } = req.query;
    const outputBuffer = fieldType && PMAX_IMAGE_SPECS[fieldType]
      ? await resizeForPmax(rawBuffer, fieldType)
      : rawBuffer;
    res.json({ base64: outputBuffer.toString('base64'), contentType: 'image/jpeg' });
  } catch (e) {
    safeError(res, e, 'creative-library-image');
  }
});

/** GET /api/meta/ad-list — 라이브러리 매핑용 Meta 광고 목록 (ad_id + ad_name 중복제거) */
app.get('/api/meta/ad-list', (req, res) => {
  const rows = db.prepare(`
    SELECT ad_id, ad_name, campaign_name, adset_name,
           MAX(date_start) as last_date,
           SUM(spend) as total_spend
    FROM ad_performance
    WHERE platform = 'meta'
    GROUP BY ad_id
    ORDER BY total_spend DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

// ─── Meta Top Creatives (for PMAX reuse) ──────────────────────

/** GET /api/meta/top-creatives — ROAS 기준 Meta 성과 상위 소재 목록 */
app.get('/api/meta/top-creatives', async (req, res) => {
  const days = validateDays(req.query.days, 7);
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const minSpend = parseFloat(req.query.minSpend) || 0;

  const rows = db.prepare(`
    SELECT
      ap.ad_id, ap.ad_name, ap.adset_name, ap.campaign_name,
      SUM(ap.spend)       as spend,
      SUM(ap.impressions) as impressions,
      SUM(ap.clicks)      as clicks,
      SUM(ap.conversions) as conversions,
      CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END as roas,
      CASE WHEN SUM(ap.impressions) > 0 THEN CAST(SUM(ap.clicks) AS REAL) / SUM(ap.impressions) * 100 ELSE 0 END as ctr,
      MAX(ap.image_url) as image_url,
      (SELECT id FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as library_id,
      (SELECT persona FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as persona,
      (SELECT desire FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as desire,
      (SELECT awareness FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as awareness
    FROM ad_performance ap
    WHERE ap.platform = 'meta'
      AND ap.date_start >= date('now', ? || ' days')
    GROUP BY ap.ad_id
    HAVING SUM(ap.spend) >= ?
    ORDER BY roas DESC
    LIMIT ?
  `).all(`-${days}`, minSpend, limit);

  // 라이브러리 이미지 있는 행에 정방형(300×300) base64 썸네일 포함
  const enriched = await Promise.all(rows.map(async row => {
    if (!row.library_id) return row;
    try {
      const lib = db.prepare(`SELECT image_data FROM creative_library WHERE id = ?`).get(row.library_id);
      if (!lib?.image_data) return row;
      const thumb = await sharp(Buffer.from(lib.image_data))
        .resize(600, 600, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 70 })
        .toBuffer();
      return { ...row, library_thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` };
    } catch { return row; }
  }));

  res.json(enriched);
});

/**
 * GET /api/meta/creative-thumbnail/:adId
 * 로컬 캐시 이미지를 이진 파일로 직접 서빙 (인증 불필요 — <img src> 태그용)
 * 로컬 없으면 404 (CDN fallback 없음 — 보안상 외부 URL 미노출)
 */
app.get('/api/meta/creative-thumbnail/:adId', (req, res) => {
  const localPath = path.join(CREATIVE_IMAGE_DIR, `${req.params.adId}.jpg`);
  if (!fs.existsSync(localPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(localPath).pipe(res);
});

/**
 * GET /api/meta/creative-image/:adId?fieldType=MARKETING_IMAGE
 * 로컬 캐시 → Meta CDN URL 순으로 이미지를 가져온 뒤
 * fieldType이 지정된 경우 PMAX 요구 사양에 맞게 자동 리사이즈
 */
app.get('/api/meta/creative-image/:adId', async (req, res) => {
  const { adId } = req.params;
  const { fieldType } = req.query;
  const localPath = path.join(CREATIVE_IMAGE_DIR, `${adId}.jpg`);

  let rawBuffer = null;

  // 0) 소재 라이브러리 우선 — fieldType 규격과 일치하는 크기 우선 선택
  const spec = PMAX_IMAGE_SPECS[fieldType];
  const libRow = db.prepare(`
    SELECT image_data FROM creative_library
    WHERE ad_id = ? AND image_data IS NOT NULL
    ORDER BY CASE WHEN width = ? AND height = ? THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `).get(adId, spec?.width ?? 0, spec?.height ?? 0);
  if (libRow?.image_data) {
    rawBuffer = Buffer.from(libRow.image_data);
  }

  // 1) 로컬 캐시
  if (!rawBuffer && fs.existsSync(localPath)) {
    rawBuffer = fs.readFileSync(localPath);
  }

  if (!rawBuffer) {
    // 2) DB에서 URL 조회 후 다운로드 + 캐시
    const row = db.prepare(
      `SELECT image_url FROM ad_performance WHERE ad_id = ? AND image_url IS NOT NULL AND image_url != '' LIMIT 1`
    ).get(adId);

    if (!row?.image_url) {
      return res.status(404).json({ error: '이미지를 찾을 수 없습니다. 서버 수집 후 다시 시도하세요.' });
    }

    try {
      const response = await fetch(row.image_url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`이미지 다운로드 실패 (HTTP ${response.status})`);
      rawBuffer = Buffer.from(await response.arrayBuffer());

      // 로컬 캐시 저장
      try {
        fs.mkdirSync(CREATIVE_IMAGE_DIR, { recursive: true });
        fs.writeFileSync(localPath, rawBuffer);
      } catch (_) {}
    } catch (e) {
      return safeError(res, e, 'creative-image');
    }
  }

  try {
    // fieldType이 있으면 PMAX 사양에 맞게 리사이즈
    const outputBuffer = fieldType && PMAX_IMAGE_SPECS[fieldType]
      ? await resizeForPmax(rawBuffer, fieldType)
      : rawBuffer;

    const spec = PMAX_IMAGE_SPECS[fieldType];
    res.json({
      base64: outputBuffer.toString('base64'),
      contentType: 'image/jpeg',
      source: fs.existsSync(localPath) ? 'local' : 'proxy',
      resized: !!(fieldType && spec),
      dimensions: spec || null,
    });
  } catch (e) {
    safeError(res, e, 'creative-image-resize');
  }
});

/**
 * POST /api/meta/proxy-image
 * Meta CDN 이미지 URL을 서버에서 다운로드 → base64 반환
 * (Meta CDN URL은 브라우저에서 직접 fetch 불가 — 서버 중계 필요)
 */
app.post('/api/meta/proxy-image', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`이미지 다운로드 실패 (HTTP ${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.json({
      base64: buffer.toString('base64'),
      contentType: response.headers.get('content-type') || 'image/jpeg',
      size: buffer.length,
    });
  } catch (e) {
    safeError(res, e, 'proxy-image');
  }
});

// ─── Google Ads Creative Endpoints ────────────────────────────

/** GET /api/google/pmax-campaigns — list PMAX campaigns from Google Ads API */
app.get('/api/google/pmax-campaigns', async (req, res) => {
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const campaigns = await google.getPmaxCampaigns();
    res.json(campaigns);
  } catch (e) {
    logger.error('getPmaxCampaigns error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/google/campaigns/:campaignId/asset-groups — list asset groups for a PMAX campaign */
app.get('/api/google/campaigns/:campaignId/asset-groups', async (req, res) => {
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const groups = await google.getAssetGroups(req.params.campaignId);
    res.json(groups);
  } catch (e) {
    logger.error('getAssetGroups error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/google/asset-groups/:assetGroupId/asset-counts — current asset counts per field type */
app.get('/api/google/asset-groups/:assetGroupId/asset-counts', async (req, res) => {
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const counts = await google.getAssetGroupAssetCounts(req.params.assetGroupId);
    res.json(counts);
  } catch (e) {
    logger.error('getAssetGroupAssetCounts error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/google/asset-groups/:assetGroupId/assets — add images to existing asset group */
app.post('/api/google/asset-groups/:assetGroupId/assets', async (req, res) => {
  const { images } = req.body; // [{base64, fieldType, name}]
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images array required' });
  }
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const result = await google.addAssetsToAssetGroup(req.params.assetGroupId, images);
    res.json({ success: true, result });
  } catch (e) {
    const detail = e?.errors?.[0]?.error_code || e?.code || e?.message || String(e);
    logger.error('addAssetsToAssetGroup error', { message: e.message, detail, stack: e.stack?.slice(0, 300) });
    res.status(500).json({ error: e.message || '알 수 없는 오류', detail });
  }
});

/** GET /api/google/campaigns/:campaignId/adgroups — list ad groups for a campaign */
app.get('/api/google/campaigns/:campaignId/adgroups', async (req, res) => {
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const adGroups = await google.getAdGroups(req.params.campaignId);
    res.json(adGroups);
  } catch (e) {
    safeError(res, e, 'Google adgroups');
  }
});

/**
 * POST /api/google/creative/direct — Create Google ad
 *
 * Body.mode: 'search' | 'display' | 'video' | 'demand_gen' | 'shopping' | 'pmax'
 */
app.post('/api/google/creative/direct', async (req, res) => {
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });

    const { mode, name, dailyBudget = 1, finalUrl, campaignId: existingCampaignId } = req.body;
    if (!name) return res.status(400).json({ error: 'name 필수' });

    // ── PMAX: uses separate mutateResources flow ──
    if (mode === 'pmax') {
      const { businessName, headlines, longHeadline, descriptions,
              logoBase64, marketingImageBase64, squareImageBase64 } = req.body;
      if (!businessName || !finalUrl) return res.status(400).json({ error: 'businessName, finalUrl 필수' });

      const result = await google.createPmaxCampaign({
        name, dailyBudget: Number(dailyBudget), businessName,
        logoBase64, marketingImageBase64, squareImageBase64,
        finalUrls: [finalUrl], headlines, longHeadline, descriptions,
      });
      broadcastToClients('creative_registered', { campaignId: result.id, type: 'pmax' });
      return res.json({ success: true, campaignId: result.id, name: result.name, type: 'pmax' });
    }

    // ── DEMAND_GEN: uses separate mutateResources flow ──
    if (mode === 'demand_gen') {
      const { biddingGoal, targetCpa, merchantId, startDate, endDate, adGroupName,
              adType, adName, businessName, headlines, descriptions, callToActionText,
              logoBase64, marketingImagesBase64, squareImagesBase64,
              youtubeVideoIds, longHeadlines } = req.body;
      if (!businessName || !finalUrl) return res.status(400).json({ error: 'businessName, finalUrl 필수' });
      if (!headlines?.length || !descriptions?.length) return res.status(400).json({ error: 'headlines, descriptions 필수' });

      const result = await google.createDemandGenCampaign({
        name, dailyBudget: Number(dailyBudget), biddingGoal, businessName,
        targetCpaMicros: targetCpa ? Math.round(Number(targetCpa) * 1_000_000) : undefined,
        merchantId, startDate, endDate, adGroupName,
        adType: adType || 'image', adName,
        finalUrls: [finalUrl], headlines, descriptions, callToActionText,
        logoBase64,
        marketingImagesBase64: marketingImagesBase64 || [],
        squareImagesBase64: squareImagesBase64 || [],
        youtubeVideoIds: youtubeVideoIds || [],
        longHeadlines: longHeadlines || [],
      });

      broadcastToClients('creative_registered', { campaignId: result.id, type: 'demand_gen' });
      return res.json({ success: true, campaignId: result.id, name: result.name, type: 'demand_gen', adType: result.adType });
    }

    // ── Common: campaign type mapping ──
    const CHANNEL_MAP = {
      search: 'SEARCH', display: 'DISPLAY', video: 'VIDEO',
      shopping: 'SHOPPING',
    };
    const ADGROUP_TYPE_MAP = {
      search: 'SEARCH_STANDARD', display: 'DISPLAY_STANDARD',
      video: 'VIDEO_RESPONSIVE',
      shopping: 'SHOPPING_PRODUCT_ADS',
    };
    const BIDDING_MAP = {
      search: 'MAXIMIZE_CONVERSIONS', display: 'MAXIMIZE_CONVERSIONS',
      video: 'MAXIMIZE_CONVERSIONS',
      shopping: 'MAXIMIZE_CLICKS',
    };

    const channelType = CHANNEL_MAP[mode];
    if (!channelType) return res.status(400).json({ error: `지원하지 않는 mode: ${mode}` });
    if (!finalUrl && mode !== 'shopping') return res.status(400).json({ error: 'finalUrl 필수' });

    // Step 1: Campaign
    let campaignId = existingCampaignId;
    if (!campaignId) {
      const campaign = await google.createCampaign({
        name, dailyBudget: Number(dailyBudget), channelType,
        status: 'PAUSED', biddingStrategy: BIDDING_MAP[mode],
        ...(mode === 'shopping' && req.body.merchantId && { merchantId: req.body.merchantId }),
      });
      campaignId = campaign.id;
    }

    // Step 2: Ad Group
    const adGroupName = req.body.adGroupName || `${name}_AdGroup`;
    const adGroup = await google.createAdGroup({
      campaignId, name: adGroupName, status: 'PAUSED',
      adGroupType: ADGROUP_TYPE_MAP[mode],
    });

    let adResult;

    // Step 3: Ad creation per type
    if (mode === 'search') {
      const { headlines, descriptions, keywords = [] } = req.body;
      if (!headlines?.length || !descriptions?.length) return res.status(400).json({ error: 'headlines, descriptions 필수' });
      if (keywords.length > 0) {
        const kwList = keywords.map(k => typeof k === 'string' ? { text: k, matchType: 'BROAD' } : k);
        await google.addKeywords(adGroup.id, kwList);
      }
      adResult = await google.createResponsiveSearchAd({
        adGroupId: adGroup.id, headlines, descriptions, finalUrls: [finalUrl],
      });

    } else if (mode === 'display') {
      const { headlines, longHeadline, descriptions, businessName,
              marketingImageBase64, squareImageBase64, logoBase64 } = req.body;
      if (!headlines?.length || !longHeadline || !descriptions?.length || !businessName) {
        return res.status(400).json({ error: 'headlines, longHeadline, descriptions, businessName 필수' });
      }
      // Upload image assets if provided
      const marketingImageAssets = marketingImageBase64
        ? [await google.createImageAsset({ name: `${name}_marketing`, imageBase64: marketingImageBase64 })] : [];
      const squareImageAssets = squareImageBase64
        ? [await google.createImageAsset({ name: `${name}_square`, imageBase64: squareImageBase64 })] : [];
      const logoImageAssets = logoBase64
        ? [await google.createImageAsset({ name: `${name}_logo`, imageBase64: logoBase64 })] : [];

      adResult = await google.createResponsiveDisplayAd({
        adGroupId: adGroup.id, headlines, longHeadline, descriptions, businessName,
        finalUrls: [finalUrl], marketingImageAssets, squareImageAssets,
        squareLogoImageAssets: logoImageAssets,
      });

    } else if (mode === 'video') {
      const { youtubeVideoId, headline, description } = req.body;
      if (!youtubeVideoId) return res.status(400).json({ error: 'youtubeVideoId 필수' });
      // Create YouTube video asset first
      const videoAssetName = await google.createYouTubeVideoAsset({ videoId: youtubeVideoId, name: `${name}_video` });
      adResult = await google.createVideoAd({
        adGroupId: adGroup.id,
        videoId: videoAssetName.split('/').pop(), // asset ID
        headline: headline || name,
        description: description || '',
        finalUrls: [finalUrl],
      });

    } else if (mode === 'shopping') {
      adResult = await google.createShoppingProductAd({ adGroupId: adGroup.id });
    }

    broadcastToClients('creative_registered', { campaignId, adGroupId: adGroup.id, type: mode });
    res.json({ success: true, campaignId, adGroupId: adGroup.id, type: mode });
  } catch (e) {
    safeError(res, e, 'Google direct creative');
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
app.get('/api/ad-performance', async (req, res) => {
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
      ap.ad_id, ap.ad_name, ap.adset_id, ap.adset_name, ap.campaign_id, ap.campaign_name,
      ap.platform, ap.date_start,
      SUM(ap.impressions) as impressions,
      SUM(ap.clicks) as clicks,
      SUM(ap.spend) as spend,
      SUM(ap.conversions) as conversions,
      SUM(ap.conversion_value) as conversion_value,
      CASE WHEN SUM(ap.impressions) > 0 THEN CAST(SUM(ap.clicks) AS REAL) / SUM(ap.impressions) * 100 ELSE 0 END as ctr,
      CASE WHEN SUM(ap.clicks) > 0 THEN SUM(ap.spend) / SUM(ap.clicks) ELSE 0 END as cpc,
      CASE WHEN SUM(ap.impressions) > 0 THEN SUM(ap.spend) / SUM(ap.impressions) * 1000 ELSE 0 END as cpm,
      CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END as roas,
      CASE WHEN SUM(ap.conversions) > 0 THEN SUM(ap.spend) / SUM(ap.conversions) ELSE 0 END as cpa,
      MAX(ap.collected_at) as collected_at,
      MAX(ap.image_url) as image_url,
      (SELECT id FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as library_id,
      (SELECT persona FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as persona,
      (SELECT desire FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as desire,
      (SELECT awareness FROM creative_library WHERE ad_id = ap.ad_id ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC LIMIT 1) as awareness
    FROM ad_performance ap
    WHERE ${since && until ? 'ap.date_start >= ? AND ap.date_start <= ?' : "ap.date_start >= date('now', ? || ' days')"}
  `;
  const params = since && until ? [since, until] : [`-${days}`];

  if (platform) {
    query += ' AND ap.platform = ?';
    params.push(platform);
  }
  if (req.query.campaign_id) {
    query += ' AND ap.campaign_id = ?';
    params.push(req.query.campaign_id);
  }
  if (req.query.adset_id) {
    query += ' AND ap.adset_id = ?';
    params.push(req.query.adset_id);
  }

  query += ` GROUP BY ap.ad_id, ap.platform ORDER BY ${sortCol} ${sortOrder}`;

  let rows;
  try {
    rows = db.prepare(query).all(...params);
  } catch (e) {
    return safeError(res, e, 'ad-performance');
  }

  // library_id 있는 행에 base64 썸네일 포함 (300px 리사이즈)
  try {
    const enriched = await Promise.all(rows.map(async row => {
      if (!row.library_id) return row;
      try {
        const lib = db.prepare(`SELECT image_data FROM creative_library WHERE id = ?`).get(row.library_id);
        if (!lib?.image_data) return row;
        const thumb = await sharp(Buffer.from(lib.image_data))
          .resize(600, 600, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 70 })
          .toBuffer();
        return { ...row, library_thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` };
      } catch { return row; }
    }));
    res.json(enriched);
  } catch (e) {
    // enrichment 실패 시 원본 데이터라도 반환
    logger.warn('ad-performance enrichment failed', { error: e.message });
    res.json(rows);
  }
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

/** GET /api/google/asset-grades — Individual asset performance grades */
app.get('/api/google/asset-grades', (req, res) => {
  const { campaign_id, label } = req.query;
  const ALLOWED_LABELS = ['BEST', 'GOOD', 'LOW', 'LEARNING', 'PENDING'];

  let query = `SELECT * FROM google_asset_grades WHERE 1=1`;
  const params = [];

  if (campaign_id) { query += ` AND campaign_id = ?`; params.push(campaign_id); }
  if (label && ALLOWED_LABELS.includes(label.toUpperCase())) {
    query += ` AND performance_label = ?`; params.push(label.toUpperCase());
  }
  query += ` ORDER BY
    CASE performance_label
      WHEN 'BEST' THEN 1 WHEN 'GOOD' THEN 2
      WHEN 'LEARNING' THEN 3 WHEN 'PENDING' THEN 4 WHEN 'LOW' THEN 5 ELSE 6
    END, campaign_name, ad_group_name`;

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

/** GET /api/google/pmax-asset-performance — PMAX per-asset performance */
app.get('/api/google/pmax-asset-performance', async (req, res) => {
  const { date_from, date_to, campaign_id } = req.query;
  try {
    const google = getGoogleClient();
    if (!google._configured) return res.status(503).json({ error: 'Google Ads client not configured' });
    const campaignIds = campaign_id ? [String(campaign_id)] : [];
    const rows = await google.getPmaxAssetPerformance({
      dateFrom: date_from,
      dateTo: date_to,
      campaignIds,
    });
    res.json(rows);
  } catch (e) {
    logger.error('pmax-asset-performance error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
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

/** POST /api/collect — Manually trigger a data collection cycle */
app.post('/api/collect', async (req, res) => {
  try {
    logger.info('Manual collection triggered via API');
    await collector.collectAll();
    res.json({ success: true, message: 'Collection cycle completed' });
  } catch (err) {
    logger.error('Manual collection failed', { error: err.message });
    res.status(500).json({ error: 'Collection failed', details: err.message });
  }
});

// ─── Slack 수동 발송 ──────────────────────────────────────────
app.post('/api/alerts/send-now', async (req, res) => {
  try {
    const lowRoasAds = db.prepare(`
      SELECT ap.ad_id, ap.ad_name, ap.campaign_name, ap.campaign_id,
        SUM(ap.spend) as spend,
        CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END as roas
      FROM ad_performance ap
      WHERE ap.platform = 'meta'
        AND ap.campaign_name LIKE '%슈즈%'
        AND ap.date_start >= date('now', '-6 days')
      GROUP BY ap.ad_id
      HAVING SUM(ap.spend) >= 40000
        AND (CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END) < 1
    `).all();

    if (lowRoasAds.length === 0) {
      return res.json({ success: true, sent: 0, message: '조건 충족 소재 없음' });
    }

    const lowRoasTraining = db.prepare(`
      SELECT ap.ad_id, ap.ad_name, ap.campaign_name, ap.campaign_id,
        SUM(ap.spend) as spend,
        CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END as roas
      FROM ad_performance ap
      WHERE ap.platform = 'meta'
        AND ap.campaign_name LIKE '%트레이닝%'
        AND ap.date_start >= date('now', '-6 days')
      GROUP BY ap.ad_id
      HAVING SUM(ap.spend) >= 100000
        AND (CASE WHEN SUM(ap.spend) > 0 THEN SUM(ap.conversion_value) / SUM(ap.spend) ELSE 0 END) < 1
    `).all();

    const allAds = [
      ...lowRoasAds.map(ad => ({ ...ad, label: '슈즈' })),
      ...lowRoasTraining.map(ad => ({ ...ad, label: '트레이닝' })),
    ];

    if (allAds.length === 0) {
      return res.json({ success: true, sent: 0, message: '조건 충족 소재 없음' });
    }

    const insertAlert = db.prepare(`INSERT INTO alerts (campaign_id, alert_type, severity, message) VALUES (?, ?, ?, ?)`);
    let sent = 0;
    for (const ad of allAds) {
      const msg = `🚨 [${ad.label} 소재 저성과] ${ad.ad_name || ad.ad_id}\n캠페인: ${ad.campaign_name}\n지출: ₩${krwFmt.format(Math.round(ad.spend))} / ROAS: ${ad.roas.toFixed(2)}`;
      insertAlert.run(ad.campaign_id, 'creative_low_roas', 'warning', msg);
      await notifier.broadcast(msg, { severity: 'warning', data: { 소재: ad.ad_name || ad.ad_id, 지출: `₩${krwFmt.format(Math.round(ad.spend))}`, ROAS: ad.roas.toFixed(2) } });
      if (allAds.length > 1) await new Promise(r => setTimeout(r, 1000));
      sent++;
    }
    res.json({ success: true, sent, message: `${sent}개 소재 알림 발송 완료` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Slack 알림 토글 ─────────────────────────────────────────
app.get('/api/settings/slack-status', (req, res) => {
  res.json({ enabled: !!process.env.SLACK_WEBHOOK_URL });
});

app.post('/api/settings/slack-toggle', (req, res) => {
  const { enabled } = req.body;
  if (enabled) {
    // .env의 주석 처리된 URL을 복원 (메모리에만 적용)
    const saved = process.env.SLACK_WEBHOOK_URL_SAVED;
    if (saved) process.env.SLACK_WEBHOOK_URL = saved;
  } else {
    process.env.SLACK_WEBHOOK_URL_SAVED = process.env.SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL_SAVED;
    process.env.SLACK_WEBHOOK_URL = '';
  }
  res.json({ enabled: !!process.env.SLACK_WEBHOOK_URL });
});

// ─── Alert Thresholds ────────────────────────────────────────
app.get('/api/settings/alert-thresholds', (req, res) => {
  res.json({
    roasMin: parseFloat(process.env.ALERT_ROAS_THRESHOLD || '1.5'),
    cpaMax: parseFloat(process.env.ALERT_CPA_THRESHOLD || '50000'),
    budgetBurnRate: parseFloat(process.env.ALERT_BUDGET_BURN_RATE || '0.85'),
  });
});

app.get('/api/settings/collect-interval', (req, res) => {
  res.json({ intervalMinutes: parseInt(process.env.COLLECT_INTERVAL_MINUTES || '15') });
});

app.post('/api/settings/collect-interval', mutationLimiter, (req, res) => {
  const { intervalMinutes } = req.body;
  const val = parseInt(intervalMinutes);
  if (!val || val < 1 || val > 1440) {
    return res.status(400).json({ error: 'intervalMinutes must be between 1 and 1440' });
  }
  collector.reschedule(val);
  res.json({ success: true, intervalMinutes: val });
});

app.post('/api/settings/alert-thresholds', mutationLimiter, (req, res) => {
  const { roasMin, cpaMax, budgetBurnRate } = req.body;
  if (roasMin !== undefined) process.env.ALERT_ROAS_THRESHOLD = String(roasMin);
  if (cpaMax !== undefined) process.env.ALERT_CPA_THRESHOLD = String(cpaMax);
  if (budgetBurnRate !== undefined) process.env.ALERT_BUDGET_BURN_RATE = String(budgetBurnRate);
  // collector의 thresholds도 즉시 반영
  collector.thresholds = {
    roasMin: parseFloat(process.env.ALERT_ROAS_THRESHOLD),
    cpaMax: parseFloat(process.env.ALERT_CPA_THRESHOLD),
    budgetBurnRate: parseFloat(process.env.ALERT_BUDGET_BURN_RATE),
  };
  res.json({ success: true, thresholds: collector.thresholds });
});

// Push fresh data to dashboard clients after each collection cycle (event-driven)
collector.on('collected', () => {
  broadcastToClients('performance_update', optimizer.getSummary(1));
});

server.listen(PORT, async () => {
  logger.info(`API server running on http://localhost:${PORT}`);
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  if (!API_TOKEN) logger.warn('API_AUTH_TOKEN not set — running without authentication (dev mode)');

  // Start Slack Bot (Socket Mode) for @mention responses
  try {
    await startSlackBot();
  } catch (err) {
    logger.warn('Slack Bot failed to start', { error: err.message });
  }
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
