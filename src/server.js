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
import { getMetaClient, getGoogleClient, getNaverClient } from './utils/clients.js';
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

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '50mb' }));

// 대시보드 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'dashboard')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'index.html')));

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

// 실시간 API 응답 캐시 (rate limit 방지)
const _apiCache = new Map();
function getCache(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { _apiCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  _apiCache.set(key, { ts: Date.now(), data, ttl: ttlMs });
}

// 하위 호환 (overview 전용 캐시 → 공통 캐시로 통합)
const _overviewCache = _apiCache;
function getCachedOverview(key) { return getCache(key); }

/** GET /api/overview — High-level KPIs */
app.get('/api/overview', async (req, res) => {
  const { since, until, platform } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform — use "meta", "google", or "tiktok"' });
  }

  const dateFrom = since || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const dateTo   = until || new Date().toISOString().split('T')[0];

  // 캐시 확인 (실시간 API 호출 플랫폼만)
  if (platform === 'meta' || platform === 'google' || platform === 'naver') {
    const cacheKey = `${platform}:${dateFrom}:${dateTo}`;
    const cached = getCachedOverview(cacheKey);
    if (cached) return res.json(cached);
  }

  // ── Google: 실시간 API ───────────────────────────────────────────────
  if (platform === 'google') {
    const google = getGoogleClient();
    if (google._configured) try {
      const rows = await google.getPerformance({ dateFrom, dateTo });
      const totals = rows.reduce((acc, r) => ({
        spend:       acc.spend       + r.spend,
        conversions: acc.conversions + r.conversions,
        value:       acc.value       + r.conversionValue,
        impressions: acc.impressions + r.impressions,
        clicks:      acc.clicks      + r.clicks,
      }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });

      const payload = {
        days,
        totalSpend:       totals.spend,
        totalConversions: totals.conversions,
        totalValue:       totals.value,
        roas: totals.spend > 0 ? totals.value / totals.spend : 0,
        cpa:  totals.conversions > 0 ? totals.spend / totals.conversions : 0,
        cpc:  totals.clicks > 0 ? totals.spend / totals.clicks : 0,
        ctr:  totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
        activeCampaigns: rows.filter(r => r.spend > 0).length,
        byPlatform: { meta: [], google: rows, tiktok: [] },
      };
      setCache(`google:${dateFrom}:${dateTo}`, payload);
      return res.json(payload);
    } catch (e) {
      logger.error('google overview realtime error', { error: e.message });
      // 오류 시 DB 폴백
    }
  }

  // ── Meta: 실시간 API (platform=meta 명시 시에만) ────────────────────
  if (platform === 'meta') {
    const meta = getMetaClient();
    if (meta._configured) try {
      const rows = await meta.getInsights({ level: 'campaign', timeRange: { since: dateFrom, until: dateTo } });
      const totals = rows.reduce((acc, r) => ({
        spend:       acc.spend       + r.spend,
        conversions: acc.conversions + r.conversions,
        value:       acc.value       + r.conversionValue,
        impressions: acc.impressions + r.impressions,
        clicks:      acc.clicks      + r.clicks,
      }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });

      const payload = {
        days,
        totalSpend:       totals.spend,
        totalConversions: totals.conversions,
        totalValue:       totals.value,
        roas: totals.spend > 0 ? totals.value / totals.spend : 0,
        cpa:  totals.conversions > 0 ? totals.spend / totals.conversions : 0,
        cpc:  totals.clicks > 0 ? totals.spend / totals.clicks : 0,
        ctr:  totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
        activeCampaigns: rows.filter(r => r.spend > 0).length,
        byPlatform: { meta: rows, google: [], tiktok: [] },
      };
      setCache(`meta:${dateFrom}:${dateTo}`, payload);
      return res.json(payload);
    } catch (e) {
      logger.error('meta filters realtime error', { error: e.message });
      // 오류 시 DB 폴백
    }
  }

  // ── Naver GFA: 실시간 API ────────────────────────────────────────────
  if (platform === 'naver') {
    const naver = getNaverClient();
    if (naver._configured) try {
      const rows = await naver.getInsights({ dateFrom, dateTo });
      const totals = rows.reduce((acc, r) => ({
        spend:       acc.spend       + r.spend,
        conversions: acc.conversions + r.conversions,
        value:       acc.value       + r.conversionValue,
        impressions: acc.impressions + r.impressions,
        clicks:      acc.clicks      + r.clicks,
      }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });

      const payload = {
        days,
        totalSpend:       totals.spend,
        totalConversions: totals.conversions,
        totalValue:       totals.value,
        roas: totals.spend > 0 ? totals.value / totals.spend : 0,
        cpa:  totals.conversions > 0 ? totals.spend / totals.conversions : 0,
        cpc:  totals.clicks > 0 ? totals.spend / totals.clicks : 0,
        ctr:  totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
        activeCampaigns: rows.filter(r => r.spend > 0).length,
        byPlatform: { meta: [], google: [], naver: rows, tiktok: [] },
      };
      setCache(`naver:${dateFrom}:${dateTo}`, payload);
      return res.json(payload);
    } catch (e) {
      logger.error('naver overview realtime error', { error: e.message });
    }
  }

  // ── DB 폴백 (전체 / 미설정 / 오류) ──────────────────────────────────
  const summary = optimizer.getSummary(days, since || null, until || null);
  const filtered = platform ? summary.filter(c => c.platform === platform) : summary;

  const totals = filtered.reduce((acc, c) => ({
    spend:       acc.spend       + (c.total_spend || 0),
    conversions: acc.conversions + (c.total_conversions || 0),
    value:       acc.value       + (c.total_value || 0),
    impressions: acc.impressions + (c.total_impressions || 0),
    clicks:      acc.clicks      + (c.total_clicks || 0),
  }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });

  res.json({
    days,
    totalSpend:       totals.spend,
    totalConversions: totals.conversions,
    totalValue:       totals.value,
    roas: totals.spend > 0 ? totals.value / totals.spend : 0,
    cpa:  totals.conversions > 0 ? totals.spend / totals.conversions : 0,
    cpc:  totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    ctr:  totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    activeCampaigns: filtered.filter(c => c.total_spend > 0).length,
    byPlatform: {
      meta:   summary.filter(c => c.platform === 'meta'),
      google: summary.filter(c => c.platform === 'google'),
      tiktok: summary.filter(c => c.platform === 'tiktok'),
    },
  });
});

/** GET /api/campaign-daily — 기간별 캠페인 성과 집계 (노출량 > 0) */
app.get('/api/campaign-daily', async (req, res) => {
  const { since, until, platform = 'meta' } = req.query;
  if (!since || !until) return res.status(400).json({ error: 'since and until required (YYYY-MM-DD)' });

  const cacheKey = `campaign-daily:${platform}:${since}:${until}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    let rows = [];

    if (platform === 'meta') {
      const meta = getMetaClient();
      if (!meta._configured) return res.json([]);
      rows = await meta.getInsights({ level: 'campaign', timeRange: { since, until } });
    } else if (platform === 'google') {
      const google = getGoogleClient();
      if (!google._configured) return res.json([]);
      rows = await google.getPerformance({ dateFrom: since, dateTo: until });
    } else {
      return res.json([]);
    }

    // 캠페인별 집계 (기간 내 여러 날 데이터 합산)
    const byId = new Map();
    for (const r of rows) {
      if (r.impressions === 0) continue;
      if (!byId.has(r.campaignId)) {
        byId.set(r.campaignId, {
          campaignId:      r.campaignId,
          campaignName:    r.campaignName,
          impressions:     0,
          clicks:          0,
          spend:           0,
          conversions:     0,
          conversionValue: 0,
        });
      }
      const c = byId.get(r.campaignId);
      c.impressions     += r.impressions;
      c.clicks          += r.clicks;
      c.spend           += r.spend;
      c.conversions     += r.conversions;
      c.conversionValue += r.conversionValue;
    }

    const result = [...byId.values()]
      .map(c => ({
        ...c,
        ctr:  c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
        cpc:  c.clicks > 0 ? c.spend / c.clicks : 0,
        roas: c.spend > 0 ? c.conversionValue / c.spend : 0,
        cpa:  c.conversions > 0 ? c.spend / c.conversions : 0,
      }))
      .sort((a, b) => b.spend - a.spend);

    setCache(cacheKey, result, 5 * 60 * 1000);
    return res.json(result);
  } catch (e) {
    logger.error('campaign-daily error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

/** GET /api/insights/creative — Rule-based TOP3 선별 + Claude 한줄 코멘트 */
app.get('/api/insights/creative', async (req, res) => {
  const cacheKey = 'insights:creative';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.json({ surge: [], highPerf: [], waste: [], highCpa: [] });

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const d7  = new Date(Date.now() -  7 * 86400000).toISOString().split('T')[0];
    const d8  = new Date(Date.now() -  8 * 86400000).toISOString().split('T')[0];
    const d14 = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];

    // 현재 7일 + 이전 7일 병렬 조회
    const [current, previous] = await Promise.all([
      meta.getAdInsights({ timeRange: { since: d7,  until: yesterday } }),
      meta.getAdInsights({ timeRange: { since: d14, until: d8 } }),
    ]);

    // ── 카드 #1: 노출·클릭 급증 ───────────────────────────────
    const prevMap = new Map(previous.map(r => [r.adId, r]));
    const surge = current
      .map(r => {
        const prev = prevMap.get(r.adId);
        const prevScore = prev ? (prev.impressions + prev.clicks) : 0;
        const currScore = r.impressions + r.clicks;
        const growthRate = prevScore > 0 ? currScore / prevScore : (currScore > 0 ? 99 : 0);
        return { ...r, growthRate, currScore };
      })
      .filter(r => r.currScore > 0)
      .sort((a, b) => b.growthRate - a.growthRate)
      .slice(0, 3);

    // ── 카드 #2: 고성과 (ROAS >= 2.0 & 전환 >= 5) ────────────
    const highPerf = current
      .filter(r => r.roas >= 2.0 && r.conversions >= 5)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 3);

    // ── 카드 #3: 낭비 소재 (지출 >= 10만 & 전환 0) ───────────
    const waste = current
      .filter(r => r.spend >= 100000 && r.conversions === 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 3);

    // ── 카드 #4: 고CPA (전환 > 0 & CPA >= 15만) ──────────────
    const highCpa = current
      .filter(r => r.conversions > 0 && r.cpa >= 150000)
      .sort((a, b) => b.cpa - a.cpa)
      .slice(0, 3);

    // ── Claude 한줄 코멘트 생성 ───────────────────────────────
    const allItems = [
      ...surge.map(r => ({ ...r, category: 'surge' })),
      ...highPerf.map(r => ({ ...r, category: 'highPerf' })),
      ...waste.map(r => ({ ...r, category: 'waste' })),
      ...highCpa.map(r => ({ ...r, category: 'highCpa' })),
    ];

    let comments = {};
    if (allItems.length > 0 && process.env.ANTHROPIC_API_KEY) {
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const payload = allItems.map(r => ({
          id: r.adId,
          name: r.adName,
          category: r.category,
          spend: Math.round(r.spend),
          roas: parseFloat((r.roas || 0).toFixed(2)),
          conversions: r.conversions,
          cpa: Math.round(r.cpa || 0),
          impressions: r.impressions,
          clicks: r.clicks,
          ctr: parseFloat((r.ctr || 0).toFixed(2)),
          growthRate: r.growthRate ? parseFloat(r.growthRate.toFixed(1)) : null,
        }));

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `광고 소재 성과 데이터를 분석해 각 소재에 한국어 한줄 인사이트를 생성하세요.
카테고리: surge=노출·클릭 급증, highPerf=고성과, waste=전환없는 낭비, highCpa=고CPA

JSON 배열만 반환하세요 (다른 텍스트 없이):
[{"id":"소재ID","comment":"한줄 인사이트 (20자 이내)"}]

데이터:
${JSON.stringify(payload)}`,
          }],
        });

        const text = response.content[0]?.text || '[]';
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          comments = Object.fromEntries(parsed.map(c => [c.id, c.comment]));
        }
      } catch (e) {
        logger.warn('Claude insight comment generation failed', { error: e.message });
      }
    }

    const withComment = (list) => list.map(r => ({ ...r, comment: comments[r.adId] || null }));

    const result = {
      surge:    withComment(surge),
      highPerf: withComment(highPerf),
      waste:    withComment(waste),
      highCpa:  withComment(highCpa),
      generatedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result, 30 * 60 * 1000); // 30분 캐시
    return res.json(result);
  } catch (e) {
    logger.error('insights/creative error', { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

/** GET /api/campaigns — All campaigns (실시간 API, 5분 캐시) */
app.get('/api/campaigns', async (req, res) => {
  const cacheKey = 'campaigns:all';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [meta, google, naver] = [getMetaClient(), getGoogleClient(), getNaverClient()];
    const results = await Promise.allSettled([
      meta._configured   ? meta.getCampaigns(['ACTIVE', 'PAUSED'])   : Promise.resolve([]),
      google._configured ? google.getCampaigns(['ENABLED', 'PAUSED']) : Promise.resolve([]),
      naver._configured  ? naver.getCampaigns()                       : Promise.resolve([]),
    ]);

    const metaCampaigns = (results[0].value || []).map(c => ({
      id: `meta_${c.id}`, platform: 'meta', platform_id: c.id,
      name: c.name, status: c.effective_status || c.status,
      daily_budget: c.daily_budget ? c.daily_budget : null,
      stop_time: c.stop_time || null,
      week_roas: null, today_spend: null, today_conversions: null,
    }));

    const googleCampaigns = (results[1].value || []).map(c => ({
      id: `google_${c.id}`, platform: 'google', platform_id: c.id,
      name: c.name, status: c.status,
      daily_budget: c.dailyBudget || null,
      stop_time: null,
      week_roas: null, today_spend: null, today_conversions: null,
    }));

    const naverCampaigns = (results[2].value || []).map(c => ({
      id: `naver_${c.id}`, platform: 'naver', platform_id: c.id,
      name: c.name, status: c.status,
      daily_budget: c.dailyBudget || null,
      stop_time: null,
      week_roas: null, today_spend: null, today_conversions: null,
    }));

    const payload = [...metaCampaigns, ...googleCampaigns, ...naverCampaigns]
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));

    setCache(cacheKey, payload, 5 * 60 * 1000);
    res.json(payload);
  } catch (e) {
    safeError(res, e, 'campaigns');
  }
});

/** GET /api/performance/timeline — 일별 시계열 (실시간 API, 5분 캐시) */
app.get('/api/performance/timeline', async (req, res) => {
  const { since, until } = req.query;
  const days = validateDays(req.query.days, 14);
  const platform = req.query.platform;

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const dateFrom = since || new Date(Date.now() - (days - 1) * 86400000).toISOString().split('T')[0];
  const dateTo   = until || new Date().toISOString().split('T')[0];
  const cacheKey = `timeline:${platform || 'all'}:${dateFrom}:${dateTo}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [meta, google] = [getMetaClient(), getGoogleClient()];
    const rows = [];

    if (!platform || platform === 'meta') {
      if (meta._configured) {
        const insights = await meta.getInsights({
          level: 'campaign',
          timeRange: { since: dateFrom, until: dateTo },
          timeIncrement: 1,
        }).catch(() => []);
        // date_start별로 집계
        const byDate = new Map();
        for (const r of insights) {
          const date = r.dateStart || dateTo;
          if (!byDate.has(date)) byDate.set(date, { impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 });
          const d = byDate.get(date);
          d.impressions += r.impressions; d.clicks += r.clicks; d.spend += r.spend;
          d.conversions += r.conversions; d.value += r.conversionValue;
        }
        for (const [date, d] of byDate) {
          rows.push({ date, platform: 'meta', ...d,
            ctr:  d.impressions > 0 ? d.clicks / d.impressions : 0,
            cpc:  d.clicks > 0 ? d.spend / d.clicks : 0,
            roas: d.spend > 0 ? d.value / d.spend : 0,
          });
        }
      }
    }

    if (!platform || platform === 'google') {
      if (google._configured) {
        const gRows = await google.getPerformance({ dateFrom, dateTo }).catch(() => []);
        const byDate = new Map();
        for (const r of gRows) {
          const date = r.date || dateTo;
          if (!byDate.has(date)) byDate.set(date, { impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 });
          const d = byDate.get(date);
          d.impressions += r.impressions; d.clicks += r.clicks; d.spend += r.spend;
          d.conversions += r.conversions; d.value += r.conversionValue;
        }
        for (const [date, d] of byDate) {
          rows.push({ date, platform: 'google', ...d,
            ctr:  d.impressions > 0 ? d.clicks / d.impressions : 0,
            cpc:  d.clicks > 0 ? d.spend / d.clicks : 0,
            roas: d.spend > 0 ? d.value / d.spend : 0,
          });
        }
      }
    }

    if (!platform || platform === 'naver') {
      const naver = getNaverClient();
      if (naver._configured) {
        const nRows = await naver.getInsights({ dateFrom, dateTo }).catch(() => []);
        for (const r of nRows) {
          rows.push({ date: r.dateStart || dateTo, platform: 'naver',
            impressions: r.impressions, clicks: r.clicks, spend: r.spend,
            conversions: r.conversions, value: r.conversionValue,
            ctr: r.ctr, cpc: r.cpc, roas: r.roas,
          });
        }
      }
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
    setCache(cacheKey, rows, 5 * 60 * 1000);
    res.json(rows);
  } catch (e) {
    safeError(res, e, 'timeline');
  }
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

    // library_id가 전달된 경우 platform_asset_map에 저장
    const { library_id } = req.body;
    if (library_id && hash) {
      try {
        db.prepare(`
          INSERT OR REPLACE INTO platform_asset_map (library_id, platform, external_asset_id, asset_type, status)
          VALUES (?, 'meta', ?, 'image_hash', 'success')
        `).run(library_id, hash);
        db.prepare(`
          UPDATE creative_library
          SET meta_uploaded = 1,
              processing_status = CASE WHEN processing_status = 'new' THEN 'uploaded_to_meta' ELSE processing_status END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(library_id);
        db.prepare(`INSERT INTO job_log (job_type, library_id, status, message) VALUES ('meta_upload', ?, 'success', ?)`)
          .run(library_id, `image_hash=${hash}`);
        logger.info('Saved image_hash to platform_asset_map', { library_id, hash });
      } catch (mapErr) {
        logger.warn('Failed to save to platform_asset_map', { error: mapErr.message });
      }
    }

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

  // 3단계: 백그라운드에서 Claude Vision PDA 자동 분석
  if (process.env.ANTHROPIC_API_KEY) {
    (async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const updatePda = db.prepare(`UPDATE creative_library SET persona = ?, desire = ?, awareness = ? WHERE id = ?`);

      for (const { id, jpegBuffer } of successItems) {
        try {
          const b64 = jpegBuffer.toString('base64');
          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
                { type: 'text', text: `이 광고 이미지를 분석해서 P·D·A 태그를 작성하세요.
JSON만 반환하세요 (다른 텍스트 없이):
{"persona":"값","desire":"값","awareness":"값"}

persona: 이 광고가 타겟하는 구체적인 인물 유형을 자유롭게 한 문장으로 (예: 운동을 시작하려는 30대 직장인)
desire: 이 광고가 자극하는 핵심 욕구나 동기를 자유롭게 한 문장으로 (예: 건강하게 살 빼고 싶은 욕구)
awareness 옵션 (이 중 하나만): 문제 인식 전, 문제 인식, 해결책 탐색, 제품 인지, 구매 준비` },
              ],
            }],
          });

          const text = response.content[0]?.text || '';
          const match = text.match(/\{[\s\S]*?\}/);
          if (match) {
            const { persona, desire, awareness } = JSON.parse(match[0]);
            updatePda.run(persona || null, desire || null, awareness || null, id);
            broadcastToClients('pda_analyzed', { id, persona, desire, awareness });
            logger.info('PDA auto-analyzed', { id, persona, desire, awareness });
          }
        } catch (e) {
          logger.warn('PDA auto-analysis failed', { id, error: e.message });
        }
      }
    })();
  }
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

/**
 * POST /api/creative-library/analyze-pda
 * 기존 소재 전체(또는 지정 ID 목록) Claude Vision PDA 재분석
 * body: { ids?: string[], overwrite?: boolean }
 *   ids 없으면 전체 대상, overwrite=false(기본)이면 PDA 미입력 소재만 분석
 */
app.post('/api/creative-library/analyze-pda', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { ids, overwrite = false } = req.body || {};

  let query = `SELECT id, image_data FROM creative_library WHERE image_data IS NOT NULL`;
  if (ids?.length) {
    query += ` AND id IN (${ids.map(() => '?').join(',')})`;
  } else if (!overwrite) {
    query += ` AND (persona IS NULL OR desire IS NULL OR awareness IS NULL)`;
  }
  const rows = ids?.length
    ? db.prepare(query).all(...ids)
    : db.prepare(query).all();

  res.json({ success: true, queued: rows.length });

  (async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const updatePda = db.prepare(`UPDATE creative_library SET persona = ?, desire = ?, awareness = ? WHERE id = ?`);

    for (const row of rows) {
      try {
        const b64 = Buffer.from(row.image_data).toString('base64');
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
              { type: 'text', text: `이 광고 이미지를 분석해서 P·D·A 태그를 작성하세요.
JSON만 반환하세요 (다른 텍스트 없이):
{"persona":"값","desire":"값","awareness":"값"}

persona: 이 광고가 타겟하는 구체적인 인물 유형을 자유롭게 한 문장으로 (예: 운동을 시작하려는 30대 직장인)
desire: 이 광고가 자극하는 핵심 욕구나 동기를 자유롭게 한 문장으로 (예: 건강하게 살 빼고 싶은 욕구)
awareness 옵션 (이 중 하나만): 문제 인식 전, 문제 인식, 해결책 탐색, 제품 인지, 구매 준비` },
            ],
          }],
        });

        const text = response.content[0]?.text || '';
        const match = text.match(/\{[\s\S]*?\}/);
        if (match) {
          const { persona, desire, awareness } = JSON.parse(match[0]);
          updatePda.run(persona || null, desire || null, awareness || null, row.id);
          broadcastToClients('pda_analyzed', { id: row.id, persona, desire, awareness });
          logger.info('PDA re-analyzed', { id: row.id, persona, desire, awareness });
        }
      } catch (e) {
        logger.warn('PDA re-analysis failed', { id: row.id, error: e.message });
      }
    }
    broadcastToClients('pda_analyze_done', { total: rows.length });
  })();
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

/**
 * GET /api/creative-library/meta-winners?days=7
 * creative_library에 ad_id가 연결된 모든 소재의 ROAS를 ad_performance DB에서 계산
 * platform_asset_map 등록 여부와 무관하게 과거/신규 소재 모두 포함
 */
app.get('/api/creative-library/meta-winners', (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days) || 7, 90));
    const roasThreshold = parseFloat(req.query.threshold || '1.0');
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);

    // creative_library 전체 (ad_id 있는 것) + ad_performance 기간 합산 ROAS
    const items = db.prepare(`
      SELECT
        cl.id as library_id,
        cl.name,
        cl.width,
        cl.height,
        cl.persona,
        cl.desire,
        cl.awareness,
        cl.ad_id,
        COALESCE(SUM(ap.spend), 0) as spend,
        COALESCE(SUM(ap.conversion_value), 0) as conv_value,
        CASE WHEN COALESCE(SUM(ap.spend), 0) > 0
          THEN COALESCE(SUM(ap.conversion_value), 0) / SUM(ap.spend)
          ELSE 0 END as roas,
        COALESCE(SUM(ap.conversions), 0) as conversions,
        MAX(ap.ad_name) as ad_name
      FROM creative_library cl
      LEFT JOIN ad_performance ap
        ON cl.ad_id = ap.ad_id
        AND ap.platform = 'meta'
        AND ap.date_start >= ?
        AND ap.date_start <= ?
      WHERE cl.ad_id IS NOT NULL
      GROUP BY cl.id
      ORDER BY roas DESC
    `).all(since, until);

    const googleMapStmt = db.prepare(
      `SELECT id FROM platform_asset_map WHERE library_id = ? AND platform = 'google'`
    );

    const winners = items.map(item => ({
      library_id: item.library_id,
      name: item.name,
      width: item.width,
      height: item.height,
      persona: item.persona,
      desire: item.desire,
      awareness: item.awareness,
      ad_id: item.ad_id,
      ad_name: item.ad_name,
      roas: parseFloat(item.roas).toFixed(2),
      spend: Math.round(item.spend),
      conversions: item.conversions,
      is_winner: item.roas >= roasThreshold,
      google_pushed: !!googleMapStmt.get(item.library_id),
    }));

    res.json({ winners, threshold: roasThreshold, days, since, until, total: winners.length });
  } catch (e) {
    safeError(res, e, 'meta-winners');
  }
});

/**
 * POST /api/creative-library/sync-meta-hashes
 * creative_library의 ad_id로 Meta API에서 image_hash를 역조회해 platform_asset_map에 저장
 */
app.post('/api/creative-library/sync-meta-hashes', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });

    // ad_id가 있는 creative_library 전체 조회 (고유 ad_id만)
    const items = db.prepare(`
      SELECT id as library_id, ad_id
      FROM creative_library
      WHERE ad_id IS NOT NULL
    `).all();

    if (items.length === 0) return res.json({ saved: 0, message: 'ad_id 연결된 소재 없음' });

    // 고유 ad_id 목록으로 Meta API 일괄 조회
    const uniqueAdIds = [...new Set(items.map(i => i.ad_id))];
    const hashMap = await meta.getAdImageHashes(uniqueAdIds);

    // platform_asset_map에 저장 (이미 있으면 skip)
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO platform_asset_map (library_id, platform, external_asset_id, asset_type, status)
      VALUES (?, 'meta', ?, 'image_hash', 'success')
    `);
    const updateLibStmt = db.prepare(`
      UPDATE creative_library
      SET meta_uploaded = 1,
          processing_status = CASE WHEN processing_status = 'new' THEN 'uploaded_to_meta' ELSE processing_status END,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    const logStmt = db.prepare(`
      INSERT INTO job_log (job_type, library_id, status, message) VALUES ('sync_meta_hash', ?, 'success', ?)
    `);

    let saved = 0;
    let skipped = 0;
    const details = [];

    const syncAll = db.transaction(() => {
      for (const item of items) {
        const hash = hashMap.get(item.ad_id);
        if (!hash) { skipped++; continue; }
        const info = insertStmt.run(item.library_id, hash);
        if (info.changes > 0) {
          updateLibStmt.run(item.library_id);
          logStmt.run(item.library_id, `image_hash=${hash}`);
          saved++;
          details.push({ library_id: item.library_id, ad_id: item.ad_id, hash });
        } else {
          // 이미 platform_asset_map에 있어도 creative_library 상태는 갱신
          updateLibStmt.run(item.library_id);
          skipped++;
        }
      }
    });
    syncAll();

    logger.info('sync-meta-hashes complete', { saved, skipped });
    res.json({ success: true, saved, skipped, total: items.length, details });
  } catch (e) {
    safeError(res, e, 'sync-meta-hashes');
  }
});

/**
 * POST /api/meta/refresh-image-urls
 * ad_performance.image_url을 Meta API에서 고해상도 permalink_url로 업데이트
 */
app.post('/api/meta/refresh-image-urls', async (req, res) => {
  try {
    const meta = getMetaClient();
    if (!meta._configured) return res.status(503).json({ error: 'Meta API not configured' });

    // 고유 ad_id 목록 수집 (Meta 플랫폼만)
    const rows = db.prepare(
      `SELECT DISTINCT ad_id FROM ad_performance WHERE platform = 'meta' AND ad_id IS NOT NULL`
    ).all();
    const adIds = rows.map(r => r.ad_id);
    if (adIds.length === 0) return res.json({ success: true, updated: 0, total: 0 });

    logger.info(`refresh-image-urls: fetching ${adIds.length} ad images from Meta API`);
    const imageMap = await meta.getAdCreativeImages(adIds);

    const updateStmt = db.prepare(
      `UPDATE ad_performance SET image_url = ? WHERE ad_id = ? AND platform = 'meta'`
    );
    let updated = 0;
    const updateAll = db.transaction(() => {
      for (const [adId, url] of imageMap) {
        if (url) {
          updateStmt.run(url, adId);
          updated++;
        }
      }
    });
    updateAll();

    // 로컬 캐시 파일 삭제 (다음 요청 시 새 URL로 재다운로드)
    try {
      const files = fs.readdirSync(CREATIVE_IMAGE_DIR);
      for (const f of files) fs.unlinkSync(path.join(CREATIVE_IMAGE_DIR, f));
    } catch (_) {}

    logger.info(`refresh-image-urls complete`, { updated, total: adIds.length });
    res.json({ success: true, updated, total: adIds.length });
  } catch (e) {
    safeError(res, e, 'refresh-image-urls');
  }
});

/**
 * POST /api/creative-library/:id/push-to-google
 * creative_library 소재를 Google PMAX 에셋 그룹에 업로드
 * body: { assetGroupId, fieldType }
 */
app.post('/api/creative-library/:id/push-to-google', async (req, res) => {
  const { id } = req.params;
  const { assetGroupId, fieldType = 'MARKETING_IMAGE' } = req.body;
  if (!assetGroupId) return res.status(400).json({ error: 'assetGroupId required' });

  const row = db.prepare(`SELECT id, name, image_data, width, height FROM creative_library WHERE id = ?`).get(id);
  if (!row?.image_data) return res.status(404).json({ error: 'Creative not found' });

  try {
    const google = getGoogleClient();

    // Sharp로 리사이즈 (PMAX 스펙에 맞게)
    const rawBuffer = Buffer.from(row.image_data);
    const outputBuffer = PMAX_IMAGE_SPECS[fieldType]
      ? await resizeForPmax(rawBuffer, fieldType)
      : rawBuffer;

    const base64 = outputBuffer.toString('base64');
    const result = await google.addAssetsToAssetGroup(assetGroupId, [{
      base64,
      fieldType,
      name: row.name,
    }]);

    // platform_asset_map에 저장
    db.prepare(`
      INSERT OR REPLACE INTO platform_asset_map (library_id, platform, external_asset_id, asset_type, status)
      VALUES (?, 'google', ?, ?, 'success')
    `).run(id, `${assetGroupId}_${fieldType}_${id}`, fieldType);

    db.prepare(`INSERT INTO job_log (job_type, library_id, status, message) VALUES ('google_pmax_push', ?, 'success', ?)`)
      .run(id, `assetGroupId=${assetGroupId}, fieldType=${fieldType}`);

    db.prepare(`
      UPDATE creative_library
      SET google_uploaded = 1,
          processing_status = 'uploaded_to_google',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    logger.info('Pushed creative to Google PMAX', { id, assetGroupId, fieldType });
    res.json({ success: true, result });
  } catch (e) {
    db.prepare(`INSERT INTO job_log (job_type, library_id, status, message) VALUES ('google_pmax_push', ?, 'error', ?)`)
      .run(id, e.message);
    safeError(res, e, 'push-to-google');
  }
});

/** GET /api/meta/ad-list — 라이브러리 매핑용 Meta 광고 목록 (Meta API 직접 조회, DB fallback) */
app.get('/api/meta/ad-list', async (req, res) => {
  try {
    const meta = getMetaClient();
    const ads = await meta.getAds(['ACTIVE', 'PAUSED']);
    return res.json(ads);
  } catch (e) {
    logger.warn('meta/ad-list API failed, falling back to DB', { error: e.message });
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
    return res.json(rows);
  }
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
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
      return { ...row, library_thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` };
    } catch { return row; }
  }));

  res.json(enriched);
});

/**
 * GET /api/meta/creative-thumbnail/:adId
 * 1) creative_library BLOB 우선
 * 2) 로컬 캐시
 * 3) Meta CDN URL 프록시 (stp 파라미터 제거해서 원본 품질로 다운로드 + 캐시)
 */
app.get('/api/meta/creative-thumbnail/:adId', async (req, res) => {
  const { adId } = req.params;
  const localPath = path.join(CREATIVE_IMAGE_DIR, `${adId}.jpg`);

  // 1) creative_library BLOB
  const libRow = db.prepare(
    `SELECT image_data, mime_type FROM creative_library WHERE ad_id = ? AND image_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`
  ).get(adId);
  if (libRow?.image_data) {
    res.setHeader('Content-Type', libRow.mime_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(libRow.image_data));
  }

  // 2) 로컬 캐시
  if (fs.existsSync(localPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(localPath).pipe(res);
  }

  // 3) Meta CDN 프록시 (stp 파라미터 제거 → 원본 품질)
  const urlRow = db.prepare(
    `SELECT image_url FROM ad_performance WHERE ad_id = ? AND image_url IS NOT NULL LIMIT 1`
  ).get(adId);
  if (!urlRow?.image_url) return res.status(404).end();

  try {
    // stp 파라미터(썸네일 변환) 제거
    const url = new URL(urlRow.image_url);
    url.searchParams.delete('stp');
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return res.status(502).end();

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // 로컬 캐시 저장
    try {
      fs.mkdirSync(CREATIVE_IMAGE_DIR, { recursive: true });
      fs.writeFileSync(localPath, buffer);
    } catch (_) {}

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (e) {
    res.status(502).end();
  }
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
      // stp 파라미터(썸네일 처리) 제거해서 원본 품질로 다운로드
      const cleanUrl = row.image_url.replace(/[?&]stp=[^&]+/, m => m.startsWith('?') ? '?' : '');
      const response = await fetch(cleanUrl, { signal: AbortSignal.timeout(15000) });
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

/** 소재 라이브러리 enrichment 헬퍼 (PDA 태그 + 썸네일) */
async function enrichWithLibrary(rows) {
  const libStmt = db.prepare(`
    SELECT id, persona, desire, awareness, image_data
    FROM creative_library
    WHERE ad_id = ?
    ORDER BY CASE WHEN width = 1200 AND height = 1200 THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `);
  return Promise.all(rows.map(async row => {
    const lib = libStmt.get(row.ad_id);
    if (!lib) return row;
    const enriched = { ...row, library_id: lib.id, persona: lib.persona, desire: lib.desire, awareness: lib.awareness };
    if (lib.image_data) {
      try {
        const thumb = await sharp(Buffer.from(lib.image_data))
          .resize(600, 600, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 70 })
          .toBuffer();
        enriched.library_thumb = `data:image/jpeg;base64,${thumb.toString('base64')}`;
      } catch {}
    }
    return enriched;
  }));
}

/** GET /api/ad-performance — Ad-level performance data for Creatives gallery */
app.get('/api/ad-performance', async (req, res) => {
  const { platform, sort, order, since, until } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  // ── Meta: 실시간 API 조회 + creative_library 연동 (5분 캐시) ────────
  if (platform === 'meta') {
    const meta = getMetaClient();
    if (meta._configured) try {
      const dateFrom = since || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      const dateTo   = until || new Date().toISOString().split('T')[0];
      const cacheKey = `adperf:meta:${dateFrom}:${dateTo}`;

      let apiRows = getCache(cacheKey);
      if (!apiRows) {
        apiRows = await meta.getAdInsights({ timeRange: { since: dateFrom, until: dateTo } });
        setCache(cacheKey, apiRows, 5 * 60 * 1000);
      }

      let filtered = [...apiRows];
      if (req.query.campaign_id) filtered = filtered.filter(r => r.campaignId === req.query.campaign_id);
      if (req.query.adset_id)    filtered = filtered.filter(r => r.adsetId   === req.query.adset_id);

      const allowedSorts = ['spend', 'roas', 'ctr', 'impressions', 'clicks', 'cpa', 'cpc', 'conversions'];
      const sortKey = allowedSorts.includes(sort) ? sort : 'spend';
      const sortDir = order === 'asc' ? 1 : -1;
      filtered.sort((a, b) => sortDir * ((b[sortKey] || 0) - (a[sortKey] || 0)));

      const normalized = filtered.map(r => ({
        ad_id: r.adId, ad_name: r.adName,
        adset_id: r.adsetId, adset_name: r.adsetName,
        campaign_id: r.campaignId, campaign_name: r.campaignName,
        platform: 'meta',
        impressions: r.impressions, clicks: r.clicks, spend: r.spend,
        conversions: r.conversions, conversion_value: r.conversionValue,
        ctr: r.ctr, cpc: r.cpc, cpm: r.cpm, roas: r.roas, cpa: r.cpa,
        image_url: r.adId || null,  // thumbnail 프록시용 ad_id 전달
        library_id: null, persona: null, desire: null, awareness: null,
      }));

      const enriched = await enrichWithLibrary(normalized);
      return res.json(enriched);
    } catch (e) {
      logger.error('meta ad-performance realtime error', { error: e.message });
    }
  }

  // ── Google: 실시간 API ────────────────────────────────────────────
  if (!platform || platform === 'google') {
    const google = getGoogleClient();
    if (google._configured) try {
      const dateFrom = since || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      const dateTo   = until || new Date().toISOString().split('T')[0];
      const cacheKey = `adperf:google:${dateFrom}:${dateTo}`;
      const cached = getCache(cacheKey);

      let gRows = cached;
      if (!gRows) {
        gRows = await google.getAdInsights({ dateFrom, dateTo });
        setCache(cacheKey, gRows, 5 * 60 * 1000);
      }

      if (req.query.campaign_id) gRows = gRows.filter(r => r.campaignId === req.query.campaign_id || `google_${r.campaignId}` === req.query.campaign_id);

      const allowedSorts = ['spend', 'roas', 'ctr', 'impressions', 'clicks', 'cpa', 'cpc', 'conversions'];
      const sortKey = allowedSorts.includes(sort) ? sort : 'spend';
      const sortDir = order === 'asc' ? 1 : -1;
      gRows.sort((a, b) => sortDir * ((b[sortKey] || 0) - (a[sortKey] || 0)));

      const normalized = gRows.map(r => ({
        ad_id: r.adId, ad_name: r.adName,
        adset_id: r.adGroupId, adset_name: r.adGroupName,
        campaign_id: `google_${r.campaignId}`, campaign_name: r.campaignName,
        platform: 'google',
        impressions: r.impressions, clicks: r.clicks, spend: r.spend,
        conversions: r.conversions, conversion_value: r.conversionValue,
        ctr: r.ctr, cpc: r.cpc, cpm: r.cpm || 0, roas: r.roas, cpa: r.cpa,
        image_url: r.imageUrl || null,
        library_id: null, persona: null, desire: null, awareness: null,
      }));

      if (platform === 'google') return res.json(normalized);
      // platform=all 이면 Meta 결과와 합쳐서 반환은 별도 처리 불필요 — 아래에서 처리
      return res.json(normalized);
    } catch (e) {
      logger.error('google ad-performance realtime error', { error: e.message });
    }
  }

  return res.json([]);
});

/** GET /api/ad-performance/summary — Aggregate stats for the Creatives header */
app.get('/api/ad-performance/summary', async (req, res) => {
  const { platform, since, until } = req.query;
  const days = validateDays(req.query.days, 7);

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  // ── Meta: 실시간 API 집계 (미설정 시 DB 폴백) ──────────────────────
  if (platform === 'meta') {
    const meta = getMetaClient();
    if (meta._configured) try {

      const dateFrom = since || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      const dateTo   = until || new Date().toISOString().split('T')[0];

      let apiRows = await meta.getAdInsights({ timeRange: { since: dateFrom, until: dateTo } });
      if (req.query.campaign_id) apiRows = apiRows.filter(r => r.campaignId === req.query.campaign_id);
      if (req.query.adset_id)    apiRows = apiRows.filter(r => r.adsetId   === req.query.adset_id);

      const total_ads         = apiRows.length;
      const total_spend       = apiRows.reduce((s, r) => s + r.spend, 0);
      const total_impressions = apiRows.reduce((s, r) => s + r.impressions, 0);
      const total_clicks      = apiRows.reduce((s, r) => s + r.clicks, 0);
      const total_conversions = apiRows.reduce((s, r) => s + r.conversions, 0);
      const total_value       = apiRows.reduce((s, r) => s + r.conversionValue, 0);

      return res.json({
        total_ads,
        total_spend,
        total_impressions,
        total_clicks,
        total_conversions,
        total_value,
        avg_ctr:  total_impressions > 0 ? (total_clicks / total_impressions) * 100 : 0,
        avg_roas: total_spend > 0 ? total_value / total_spend : 0,
        avg_cpa:  total_conversions > 0 ? total_spend / total_conversions : 0,
      });
    } catch (e) {
      logger.error('meta ad-performance/summary realtime error', { error: e.message });
      // API 오류 시 DB 폴백
    }
  }

  // ── DB 조회 (Google / meta API 미설정·오류 폴백) ──────────────────
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

/**
 * POST /api/ad-performance/pda-insight
 * 선택된 캠페인의 소재 성과 데이터를 Claude Haiku로 P.D.A 관점 분석
 * body: { ads: [...enriched ad rows], campaign_name: string }
 */
app.post('/api/ad-performance/pda-insight', async (req, res) => {
  const { ads, campaign_name } = req.body;
  if (!Array.isArray(ads) || ads.length === 0) return res.status(400).json({ error: 'ads required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  // P.D.A 태그 있는 소재만 추출, 없으면 전체 사용
  const tagged = ads.filter(a => a.persona || a.desire || a.awareness);
  const target = tagged.length > 0 ? tagged : ads;

  // 분석용 데이터 정제 (상위 30개)
  const payload = target
    .filter(a => (a.spend || 0) > 0)
    .slice(0, 30)
    .map(a => ({
      name: a.ad_name,
      persona: a.persona || null,
      desire: a.desire || null,
      awareness: a.awareness || null,
      spend: Math.round(a.spend || 0),
      roas: parseFloat((a.roas || 0).toFixed(2)),
      conversions: a.conversions || 0,
      ctr: parseFloat((a.ctr || 0).toFixed(2)),
      cpa: Math.round(a.cpa || 0),
      impressions: a.impressions || 0,
    }));

  if (payload.length === 0) return res.status(400).json({ error: '지출 데이터가 있는 소재가 없습니다.' });

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const hasPda = tagged.length > 0;
    const prompt = hasPda
      ? `당신은 퍼포먼스 마케팅 전문가입니다. 아래는 Meta 광고 캠페인 "${campaign_name}"의 소재별 성과 데이터입니다. 각 소재에는 P(Persona), D(Desire), A(Awareness) 태그가 붙어 있습니다.

다음 3가지 관점에서 분석하여 JSON으로만 응답하세요:

{
  "persona": { "best": "가장 성과 좋은 페르소나 태그명", "insight": "해당 페르소나가 왜 잘 됐는지 1-2문장 한국어 인사이트" },
  "desire": { "best": "가장 성과 좋은 욕구/니즈 태그명", "insight": "해당 욕구 소구가 왜 효과적인지 1-2문장 한국어 인사이트" },
  "awareness": { "best": "가장 성과 좋은 인지단계 태그명", "insight": "해당 인지단계 접근이 왜 유효한지 1-2문장 한국어 인사이트" },
  "summary": "전체 캠페인 소재 성과를 P.D.A 관점에서 종합한 2-3문장 한국어 요약 및 다음 소재 제작 추천"
}

소재 데이터:
${JSON.stringify(payload)}`
      : `당신은 퍼포먼스 마케팅 전문가입니다. 아래는 Meta 광고 캠페인 "${campaign_name}"의 소재별 성과 데이터입니다. (P.D.A 태그 없음)

소재명 패턴과 성과 지표를 바탕으로 분석하여 JSON으로만 응답하세요:

{
  "persona": { "best": "소재명에서 유추한 주요 타겟", "insight": "타겟 관련 인사이트 1-2문장" },
  "desire": { "best": "소재명에서 유추한 주요 소구점", "insight": "소구점 관련 인사이트 1-2문장" },
  "awareness": { "best": "소재명에서 유추한 접근 방식", "insight": "접근 방식 관련 인사이트 1-2문장" },
  "summary": "전체 소재 성과 패턴 분석 및 다음 소재 제작 추천 2-3문장"
}

소재 데이터:
${JSON.stringify(payload)}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: '파싱 실패', raw: text });

    const result = JSON.parse(match[0]);
    res.json({ ...result, hasPda, total: payload.length, campaign_name });
  } catch (e) {
    logger.error('PDA insight generation failed', { error: e.message });
    safeError(res, e, 'pda-insight');
  }
});

/** GET /api/ad-performance/filters — Campaign/Adset filter options */
app.get('/api/ad-performance/filters', async (req, res) => {
  const { platform, campaign_id } = req.query;

  if (platform && !validatePlatform(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  // ── Meta: 실시간 전체 캠페인 목록 조회 ────────────────────────────
  if (platform === 'meta') {
    const meta = getMetaClient();
    if (meta._configured) {
      try {
        const metaCampaigns = await meta.getCampaigns(['ACTIVE', 'PAUSED', 'ARCHIVED']);
        const campaigns = metaCampaigns.map(c => ({
          campaign_id: String(c.id),
          campaign_name: c.name,
          status: c.status,
        })).sort((a, b) => a.campaign_name.localeCompare(b.campaign_name));

        // 광고세트는 DB에서 (캠페인 필터 적용)
        let adsetQuery = 'SELECT DISTINCT adset_id, adset_name, campaign_id FROM ad_performance WHERE platform = ?';
        const adsetParams = ['meta'];
        if (campaign_id) {
          adsetQuery += ' AND campaign_id = ?';
          adsetParams.push(campaign_id);
        }
        adsetQuery += ' ORDER BY adset_name';
        const adsets = db.prepare(adsetQuery).all(...adsetParams);

        return res.json({ campaigns, adsets });
      } catch (e) {
        logger.error('meta filters realtime error', { error: e.message });
        // 오류 시 DB 폴백
      }
    }
  }

  // ── DB 조회 폴백 ──────────────────────────────────────────────────
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
