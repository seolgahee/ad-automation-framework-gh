/**
 * TikTok Marketing API Client
 *
 * Handles: campaign CRUD, ad group management, creative uploads,
 * audience targeting, and reporting.
 *
 * Docs: https://business-api.tiktok.com/marketing_api/docs
 */
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { BaseAdsClient } from '../utils/base-client.js';

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export class TikTokAdsClient extends BaseAdsClient {
  constructor() {
    super();
    this.accessToken = process.env.TIKTOK_ACCESS_TOKEN;
    this.advertiserId = process.env.TIKTOK_ADVERTISER_ID;

    if (!this.accessToken || !this.advertiserId) {
      logger.warn('TikTok API credentials not fully configured');
      return;
    }
    this._configured = true;
    const masked = this.advertiserId.slice(0, 4) + '***' + this.advertiserId.slice(-2);
    logger.info('TikTok Ads client initialized', { advertiser: masked });
  }

  // ─── Internal HTTP ──────────────────────────────────────────

  async _request(method, path, body = null, retries = 3) {
    const url = `${API_BASE}${path}`;
    const headers = {
      'Access-Token': this.accessToken,
      'Content-Type': 'application/json',
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const opts = { method, headers, signal: controller.signal };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        clearTimeout(timeout);

        // Retry on 429 (rate limit) or 5xx
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
          logger.warn(`TikTok API ${res.status}, retry ${attempt}/${retries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const json = await res.json();
        if (json.code !== 0) {
          throw new Error(`TikTok API error ${json.code}: ${json.message}`);
        }
        return json.data;
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          err.message = `TikTok API timeout after 30s (${method} ${path})`;
        }
        if (attempt >= retries) throw err;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn(`TikTok API error, retry ${attempt}/${retries}: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async _get(path, params = {}) {
    const qs = new URLSearchParams({ advertiser_id: this.advertiserId, ...params });
    return this._request('GET', `${path}?${qs}`);
  }

  async _post(path, body = {}) {
    return this._request('POST', path, { advertiser_id: this.advertiserId, ...body });
  }

  // ─── Campaign Management ───────────────────────────────────

  /** List campaigns with optional status filter */
  async getCampaigns(statusFilter = ['CAMPAIGN_STATUS_ENABLE', 'CAMPAIGN_STATUS_DISABLE']) {
    this._ensureConfigured();
    const data = await this._get('/campaign/get/', {
      filtering: JSON.stringify({ status: statusFilter }),
      page_size: 100,
    });

    logger.info(`Fetched ${data.list?.length || 0} TikTok campaigns`);
    return (data.list || []).map(c => ({
      id: c.campaign_id,
      name: c.campaign_name,
      status: c.status,
      objective: c.objective_type,
      dailyBudget: c.budget || 0,
      budgetMode: c.budget_mode,
    }));
  }

  /** Create a new campaign */
  async createCampaign({ name, objective = 'CONVERSIONS', dailyBudget, status = 'CAMPAIGN_STATUS_DISABLE' }) {
    this._ensureConfigured();
    const data = await this._post('/campaign/create/', {
      campaign_name: name,
      objective_type: objective,
      budget_mode: dailyBudget ? 'BUDGET_MODE_DAY' : 'BUDGET_MODE_INFINITE',
      budget: dailyBudget || 0,
      operation_status: status,
    });

    logger.info('TikTok campaign created', { id: data.campaign_id, name });
    return { id: data.campaign_id, name, dailyBudget };
  }

  /** Update campaign budget */
  async updateBudget(campaignId, newDailyBudget) {
    this._ensureConfigured();
    await this._post('/campaign/update/', {
      campaign_id: campaignId,
      budget: newDailyBudget,
      budget_mode: 'BUDGET_MODE_DAY',
    });

    logger.info('TikTok campaign budget updated', { campaignId, newDailyBudget });
    return { success: true, campaignId, newDailyBudget };
  }

  /** Update campaign status */
  async setCampaignStatus(campaignId, status) {
    this._ensureConfigured();
    await this._post('/campaign/update/status/', {
      campaign_ids: [campaignId],
      operation_status: status,
    });

    logger.info('TikTok campaign status updated', { campaignId, status });
  }

  // ─── Ad Group Management ─────────────────────────────────

  /** Create an ad group */
  async createAdGroup({
    campaignId, name, dailyBudget, placementType = 'PLACEMENT_TYPE_AUTOMATIC',
    optimizationGoal = 'CONVERT', bidPrice, status = 'ADGROUP_STATUS_DISABLE',
  }) {
    this._ensureConfigured();
    const data = await this._post('/adgroup/create/', {
      campaign_id: campaignId,
      adgroup_name: name,
      placement_type: placementType,
      budget_mode: 'BUDGET_MODE_DAY',
      budget: dailyBudget,
      optimization_goal: optimizationGoal,
      bid_price: bidPrice,
      operation_status: status,
      location_ids: [2410],  // South Korea
      schedule_type: 'SCHEDULE_FROM_NOW',
    });

    logger.info('TikTok ad group created', { id: data.adgroup_id, name });
    return { id: data.adgroup_id, name };
  }

  // ─── Video Upload ───────────────────────────────────────

  /**
   * Upload a video file to TikTok for ad creative usage
   * @param {string} filePath - Local video file path
   * @param {string} [fileName] - Optional display name for the video
   * @returns {{ videoId: string }}
   */
  async uploadVideo(filePath, fileName) {
    this._ensureConfigured();
    const fileBuffer = fs.readFileSync(filePath);
    const name = fileName || path.basename(filePath);

    const data = await this._post('/file/video/ad/upload/', {
      upload_type: 'UPLOAD_BY_FILE',
      video_file: fileBuffer.toString('base64'),
      file_name: name,
    });

    logger.info('TikTok video uploaded', { videoId: data.video_id, file: name });
    return { videoId: data.video_id };
  }

  // ─── Creative / Ads ──────────────────────────────────────

  /** Create an ad (spark ad or non-spark) */
  async createAd({ adGroupId, name, creativeType = 'SINGLE_VIDEO', videoId, displayName, landingPageUrl }) {
    this._ensureConfigured();
    const data = await this._post('/ad/create/', {
      adgroup_id: adGroupId,
      creatives: [{
        ad_name: name,
        ad_format: creativeType,
        video_id: videoId,
        display_name: displayName || name,
        landing_page_url: landingPageUrl,
        call_to_action: 'LEARN_MORE',
      }],
    });

    logger.info('TikTok ad created', { adGroupId, name });
    return data;
  }

  // ─── Reporting / Insights ────────────────────────────────

  /** Get campaign performance report */
  async getPerformance({ dateFrom, dateTo, level = 'AUCTION_CAMPAIGN' } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = dateFrom || today;
    const to = dateTo || today;

    // Validate dates
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error('Invalid date format — expected YYYY-MM-DD');
    }

    const data = await this._get('/report/integrated/get/', {
      report_type: 'BASIC',
      data_level: level,
      dimensions: JSON.stringify(['campaign_id']),
      metrics: JSON.stringify([
        'campaign_name', 'impressions', 'clicks', 'spend', 'conversion',
        'cost_per_conversion', 'conversion_rate', 'ctr', 'cpc', 'cpm',
      ]),
      start_date: from,
      end_date: to,
      page_size: 200,
    });

    logger.info(`Fetched ${data.list?.length || 0} TikTok performance rows`, { from, to });

    return (data.list || []).map(row => {
      const m = row.metrics;
      const d = row.dimensions;
      return {
        campaignId: d.campaign_id,
        campaignName: m.campaign_name,
        impressions: parseInt(m.impressions || 0),
        clicks: parseInt(m.clicks || 0),
        spend: parseFloat(m.spend || 0),
        conversions: parseInt(m.conversion || 0),
        conversionValue: 0,  // TikTok reports value separately
        ctr: parseFloat(m.ctr || 0),
        cpc: parseFloat(m.cpc || 0),
        cpm: parseFloat(m.cpm || 0),
      };
    });
  }

  /** Quick today spend */
  async getTodaySpend() {
    return this.getPerformance({ level: 'AUCTION_CAMPAIGN' });
  }
}

export default TikTokAdsClient;
