/**
 * Creative Pipeline — Full end-to-end ad content registration
 *
 * Flow: Image/Video Upload → Copy from Template → Creative Assembly → Ad Registration
 *
 * Supports Meta (Facebook/Instagram), Google Ads, and TikTok Ads platforms.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getMetaClient, getGoogleClient, getTikTokClient } from '../utils/clients.js';
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import notifier from '../utils/notifier.js';
import { CopyTemplateEngine } from './copy-templates.js';

export class CreativePipeline {
  /**
   * @param {CopyTemplateEngine} [templateEngine] - Injected singleton. Falls back to new instance.
   */
  constructor(templateEngine) {
    this.meta = getMetaClient();
    this.google = getGoogleClient();
    this.tiktok = getTikTokClient();
    this.templates = templateEngine || new CopyTemplateEngine();
    this._initCreativeTable();
  }

  _initCreativeTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS creatives (
        id               TEXT PRIMARY KEY,
        platform         TEXT NOT NULL,
        platform_id      TEXT,
        campaign_id      TEXT,
        ad_set_id        TEXT,
        name             TEXT NOT NULL,
        type             TEXT NOT NULL,          -- 'image', 'video', 'carousel', 'responsive_search'
        status           TEXT DEFAULT 'DRAFT',   -- DRAFT, UPLOADED, ACTIVE, PAUSED
        headline         TEXT,
        description      TEXT,
        body_text        TEXT,
        cta              TEXT,
        media_url        TEXT,
        media_hash       TEXT,
        landing_url      TEXT,
        template_id      TEXT,
        ab_group         TEXT,
        metadata_json    TEXT,
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS creative_performance (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        creative_id      TEXT REFERENCES creatives(id),
        impressions      INTEGER DEFAULT 0,
        clicks           INTEGER DEFAULT 0,
        conversions      INTEGER DEFAULT 0,
        spend            REAL DEFAULT 0,
        ctr              REAL DEFAULT 0,
        cvr              REAL DEFAULT 0,
        collected_at     TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // ═══════════════════════════════════════════════════════════
  //  STEP 1: Media Upload
  // ═══════════════════════════════════════════════════════════

  /**
   * Upload image to Meta Ad Account and return image hash
   * @param {string} filePath - Local image file path
   * @returns {{ imageHash: string, url: string }}
   */
  async uploadImageToMeta(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const result = await this.meta.account.createAdImage([], {
      bytes: fileBuffer.toString('base64'),
    });

    const images = result._data?.images;
    const hash = images ? Object.values(images)[0]?.hash : null;
    logger.info('Image uploaded to Meta', { hash, file: path.basename(filePath) });
    return { imageHash: hash, url: images ? Object.values(images)[0]?.url : null };
  }

  /**
   * Upload image to Google Ads as an asset
   * @param {string} filePath - Local image file path
   * @param {string} assetName - Name for the asset
   */
  async uploadImageToGoogle(filePath, assetName) {
    const fileBuffer = fs.readFileSync(filePath);

    const result = await this.google.customer.assets.create({
      name: assetName,
      type: 'IMAGE',
      image_asset: {
        data: fileBuffer.toString('base64'),
      },
    });

    const resourceName = result.results[0].resource_name;
    logger.info('Image uploaded to Google', { resourceName, file: path.basename(filePath) });
    return { resourceName };
  }

  // ═══════════════════════════════════════════════════════════
  //  STEP 2: Creative Assembly (Template → Ad Content)
  // ═══════════════════════════════════════════════════════════

  /**
   * Build a complete creative from template + variables
   * @param {object} params
   * @param {string} params.templateId - Template ID from copy-templates
   * @param {object} params.variables - Variables to inject into template
   * @param {string} params.platform - 'meta', 'google', or 'tiktok'
   * @param {string} params.mediaPath - Path to media file (optional; image for Meta/Google, video for TikTok)
   * @param {string} params.landingUrl - Landing page URL
   * @param {string} params.abGroup - A/B test group label (optional)
   */
  async assembleCreative({ templateId, variables, platform, mediaPath, landingUrl, abGroup }) {
    // Generate copy from template
    const copy = this.templates.render(templateId, variables);

    // Upload media if provided (platform-specific)
    let mediaRef = null;
    if (mediaPath && fs.existsSync(mediaPath)) {
      const mediaUploadMap = {
        meta: () => this.uploadImageToMeta(mediaPath),
        google: () => this.uploadImageToGoogle(mediaPath, `creative_${Date.now()}`),
        tiktok: () => this.tiktok.uploadVideo(mediaPath),
      };
      const uploadFn = mediaUploadMap[platform];
      if (uploadFn) mediaRef = await uploadFn();
    }

    // Store in DB as DRAFT
    const creativeId = `cr_${crypto.randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO creatives (id, platform, name, type, headline, description, body_text,
        cta, media_hash, landing_url, template_id, ab_group, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      creativeId, platform, copy.name || `Creative ${creativeId}`,
      mediaPath ? (platform === 'tiktok' ? 'video' : 'image') : 'responsive_search',
      copy.headline, copy.description, copy.bodyText,
      copy.cta || 'LEARN_MORE',
      mediaRef?.imageHash || mediaRef?.resourceName || null,
      landingUrl, templateId, abGroup || null,
      JSON.stringify({ mediaRef, variables })
    );

    logger.info('Creative assembled', { creativeId, platform, templateId, abGroup });
    return { creativeId, copy, mediaRef };
  }

  // ═══════════════════════════════════════════════════════════
  //  STEP 3: Register Creative → Platform
  // ═══════════════════════════════════════════════════════════

  /**
   * Common wrapper: fetch creative, call platform API, update DB, log, notify.
   * @param {string} creativeId
   * @param {string} campaignId
   * @param {string} adSetOrGroup - Ad set (Meta) or ad group (Google/TikTok) ID
   * @param {string} platformLabel - Display label for logs/notifications
   * @param {(creative: object) => Promise<object>} apiCall - Platform-specific registration
   */
  async _registerCreative(creativeId, campaignId, adSetOrGroup, platformLabel, apiCall) {
    const creative = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get(creativeId);
    if (!creative) throw new Error(`Creative ${creativeId} not found`);

    const result = await apiCall(creative);

    db.prepare(`
      UPDATE creatives SET campaign_id = ?, ad_set_id = ?,
        status = 'UPLOADED', updated_at = datetime('now')
      WHERE id = ?
    `).run(campaignId, adSetOrGroup, creativeId);

    logger.info(`Creative registered to ${platformLabel}`, { creativeId, adSetOrGroup });
    await notifier.broadcast(
      `새 광고 등록: ${creative.name} → ${platformLabel} (${adSetOrGroup})`,
      { severity: 'info' }
    );

    return result;
  }

  /** Register a draft creative to Meta */
  async registerToMeta({ creativeId, campaignId, adSetId, pageId }) {
    return this._registerCreative(creativeId, campaignId, adSetId, 'Meta', async (creative) => {
      const adCreative = await this.meta.createCreative({
        name: creative.name, pageId,
        message: creative.body_text, link: creative.landing_url,
        imageHash: creative.media_hash, callToAction: creative.cta,
      });
      const ad = await this.meta.createAd({
        adSetId, creativeId: adCreative.id, name: creative.name, status: 'PAUSED',
      });
      // Also store platform_id for Meta (ad.id)
      db.prepare(`UPDATE creatives SET platform_id = ? WHERE id = ?`).run(ad.id, creativeId);
      return { adId: ad.id, creativeId: adCreative.id };
    });
  }

  /** Register a draft creative to Google Ads as Responsive Search Ad */
  async registerToGoogle({ creativeId, campaignId, adGroupId }) {
    return this._registerCreative(creativeId, campaignId, adGroupId, 'Google Ads', async (creative) => {
      const headlines = creative.headline.split('|').map(h => h.trim()).filter(Boolean);
      const descriptions = creative.description.split('|').map(d => d.trim()).filter(Boolean);
      return this.google.createResponsiveSearchAd({
        adGroupId, headlines, descriptions, finalUrls: [creative.landing_url],
      });
    });
  }

  /** Register a draft creative to TikTok Ads */
  async registerToTikTok({ creativeId, campaignId, adGroupId, videoId }) {
    return this._registerCreative(creativeId, campaignId, adGroupId, 'TikTok', async (creative) => {
      return this.tiktok.createAd({
        adGroupId, name: creative.name,
        videoId: videoId || creative.media_hash,
        displayName: creative.headline, landingPageUrl: creative.landing_url,
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Full Pipeline: One-shot content registration
  // ═══════════════════════════════════════════════════════════

  /**
   * Complete pipeline: template → assemble → register
   *
   * @param {object} params
   * @param {string} params.platform - 'meta', 'google', or 'tiktok'
   * @param {string} params.templateId - Copy template ID
   * @param {object} params.variables - Template variables
   * @param {string} params.campaignId - Target campaign (internal ID)
   * @param {string} params.adSetId - Target ad set / ad group (platform ID)
   * @param {string} params.mediaPath - Media file path (image for Meta/Google, video for TikTok)
   * @param {string} params.landingUrl - Landing URL
   * @param {string} [params.pageId] - Meta Page ID (required for Meta)
   * @param {string} [params.videoId] - TikTok Video ID (optional, overrides mediaPath)
   */
  async runFullPipeline(params) {
    logger.info('Starting creative pipeline', { platform: params.platform, template: params.templateId });

    // Step 1 + 2: Assemble
    const { creativeId, copy, mediaRef } = await this.assembleCreative({
      templateId: params.templateId,
      variables: params.variables,
      platform: params.platform,
      mediaPath: params.mediaPath,
      landingUrl: params.landingUrl,
    });

    // Step 3: Register via platform-specific method
    const registrationMap = {
      meta: () => this.registerToMeta({ creativeId, campaignId: params.campaignId, adSetId: params.adSetId, pageId: params.pageId }),
      google: () => this.registerToGoogle({ creativeId, campaignId: params.campaignId, adGroupId: params.adSetId }),
      tiktok: () => this.registerToTikTok({ creativeId, campaignId: params.campaignId, adGroupId: params.adSetId, videoId: params.videoId }),
    };
    const registerFn = registrationMap[params.platform];
    if (!registerFn) throw new Error(`Unsupported platform for creative registration: "${params.platform}"`);
    const result = await registerFn();

    return { creativeId, copy, mediaRef, registration: result };
  }

  // ═══════════════════════════════════════════════════════════
  //  Query Helpers
  // ═══════════════════════════════════════════════════════════

  getCreatives(filters = {}) {
    let query = `SELECT * FROM creatives WHERE 1=1`;
    const params = [];
    if (filters.platform) { query += ` AND platform = ?`; params.push(filters.platform); }
    if (filters.status) { query += ` AND status = ?`; params.push(filters.status); }
    if (filters.campaignId) { query += ` AND campaign_id = ?`; params.push(filters.campaignId); }
    if (filters.abGroup) { query += ` AND ab_group = ?`; params.push(filters.abGroup); }
    query += ` ORDER BY created_at DESC`;
    return db.prepare(query).all(...params);
  }

  getCreativeById(id) {
    return db.prepare(`SELECT * FROM creatives WHERE id = ?`).get(id);
  }
}

export default CreativePipeline;
