/**
 * Meta (Facebook) Marketing API Client
 *
 * Handles: campaign CRUD, ad set management, creative uploads,
 * audience targeting, and insights retrieval.
 *
 * Docs: https://developers.facebook.com/docs/marketing-apis
 */
import bizSdk from 'facebook-nodejs-business-sdk';
import logger from '../utils/logger.js';
import { BaseAdsClient } from '../utils/base-client.js';

const { FacebookAdsApi, AdAccount, Campaign, AdSet, Ad, AdCreative } = bizSdk;

export class MetaAdsClient extends BaseAdsClient {
  constructor() {
    super();
    this.accessToken = process.env.META_ACCESS_TOKEN;
    this.accountId = process.env.META_AD_ACCOUNT_ID;

    if (!this.accessToken || !this.accountId) {
      logger.warn('Meta API credentials not fully configured');
      return;
    }

    FacebookAdsApi.init(this.accessToken);
    this.api = FacebookAdsApi.getDefaultApi();
    this.account = new AdAccount(this.accountId);
    this._configured = true;

    logger.info('Meta Ads client initialized', { account: this.accountId });
  }

  // ─── Campaign Management ───────────────────────────────────

  /** List all campaigns with optional status filter */
  async getCampaigns(statusFilter = ['ACTIVE', 'PAUSED']) {
    this._ensureConfigured();
    const fields = [
      'id', 'name', 'status', 'effective_status', 'objective', 'daily_budget',
      'lifetime_budget', 'start_time', 'stop_time', 'updated_time',
    ];
    const params = { effective_status: statusFilter };

    const campaigns = await this._withTimeout(this.account.getCampaigns(fields, params), 'getCampaigns');
    logger.info(`Fetched ${campaigns.length} Meta campaigns`);
    return campaigns.map(c => c._data);
  }

  /** Create a new campaign */
  async createCampaign({ name, objective, dailyBudget, status = 'PAUSED', specialAdCategories = [] }) {
    this._ensureConfigured();
    const params = {
      name,
      objective,  // e.g. 'OUTCOME_TRAFFIC', 'OUTCOME_CONVERSIONS', 'OUTCOME_AWARENESS'
      status,
      special_ad_categories: specialAdCategories,
      daily_budget: Math.round(dailyBudget * 100),  // Meta uses cents
    };

    const result = await this._withTimeout(this.account.createCampaign([], params), 'createCampaign');
    logger.info('Meta campaign created', { id: result.id, name });
    return result._data;
  }

  /** Update campaign budget or status */
  async updateCampaign(campaignId, updates) {
    this._ensureConfigured();
    const campaign = new Campaign(campaignId);
    const params = {};

    if (updates.dailyBudget !== undefined) {
      params.daily_budget = Math.round(updates.dailyBudget * 100);
    }
    if (updates.status) params.status = updates.status;
    if (updates.name) params.name = updates.name;

    await this._withTimeout(campaign.update([], params), 'updateCampaign');
    logger.info('Meta campaign updated', { id: campaignId, ...updates });
    return { success: true, campaignId, updates };
  }

  // ─── Ad Set Management ─────────────────────────────────────

  /** List Meta Pixels for this ad account */
  async getPixels() {
    this._ensureConfigured();
    const res = await this._withTimeout(
      this.api.call('GET', [this.accountId, 'adspixels'], { fields: 'id,name', limit: 50 }),
      'getPixels'
    );
    logger.info(`Fetched ${res?.data?.length || 0} Meta pixels`);
    return res?.data || [];
  }

  /** List Instagram accounts connected to this business */
  async getInstagramAccounts() {
    this._ensureConfigured();
    try {
      const acct = await this._withTimeout(
        this.api.call('GET', [this.accountId], { fields: 'business' }),
        'getInstagramAccounts_biz'
      );
      const bizId = acct?.business?.id;
      if (!bizId) return [];
      const res = await this._withTimeout(
        this.api.call('GET', [bizId, 'instagram_accounts'], { fields: 'id,username,name', limit: 50 }),
        'getInstagramAccounts'
      );
      logger.info(`Fetched ${res?.data?.length || 0} Instagram accounts`);
      return res?.data || [];
    } catch (e) {
      logger.warn('Failed to fetch Instagram accounts', { error: e.message });
      return [];
    }
  }

  /** List Facebook Pages connected to this ad account */
  async getPages() {
    this._ensureConfigured();
    const fields = 'id,name,category';

    // 1) 개인 유저 토큰: me/accounts
    try {
      const res = await this._withTimeout(
        this.api.call('GET', ['me', 'accounts'], { fields, limit: 50 }),
        'getPages_me'
      );
      if (res?.data?.length) {
        logger.info(`Fetched ${res.data.length} Facebook pages via me/accounts`);
        return res.data;
      }
    } catch (_) { /* fall through */ }

    // 2) 시스템 유저 토큰: 광고 계정 → 비즈니스 → owned_pages
    try {
      const acctRes = await this._withTimeout(
        this.api.call('GET', [this.accountId], { fields: 'business' }),
        'getPages_business'
      );
      const businessId = acctRes?.business?.id;
      if (businessId) {
        const pagesRes = await this._withTimeout(
          this.api.call('GET', [businessId, 'owned_pages'], { fields, limit: 50 }),
          'getPages_owned'
        );
        if (pagesRes?.data?.length) {
          logger.info(`Fetched ${pagesRes.data.length} Facebook pages via business owned_pages`);
          return pagesRes.data;
        }
      }
    } catch (_) { /* fall through */ }

    logger.warn('Could not fetch Facebook pages via any method');
    return [];
  }

  /** List ad sets for a given campaign */
  async getAdSets(campaignId) {
    this._ensureConfigured();
    const campaign = new bizSdk.Campaign(campaignId);
    const fields = ['id', 'name', 'status', 'daily_budget', 'optimization_goal', 'billing_event'];
    const params = { effective_status: ['ACTIVE', 'PAUSED'] };
    const adSets = await this._withTimeout(campaign.getAdSets(fields, params), 'getAdSets');
    logger.info(`Fetched ${adSets.length} ad sets for campaign ${campaignId}`);
    return adSets.map(a => a._data);
  }

  /** Create an ad set with targeting */
  async createAdSet({
    campaignId, name, dailyBudget, billingEvent = 'IMPRESSIONS',
    optimizationGoal = 'REACH', targeting, startTime, endTime,
    status = 'PAUSED',
  }) {
    this._ensureConfigured();
    const params = {
      campaign_id: campaignId,
      name,
      daily_budget: Math.round(dailyBudget * 100),
      billing_event: billingEvent,
      optimization_goal: optimizationGoal,
      targeting: targeting || this._defaultTargeting(),
      start_time: startTime || new Date().toISOString(),
      status,
    };
    if (endTime) params.end_time = endTime;

    const result = await this._withTimeout(this.account.createAdSet([], params), 'createAdSet');
    logger.info('Meta ad set created', { id: result.id, name });
    return result._data;
  }

  /** Default Korean market targeting template */
  _defaultTargeting() {
    return {
      geo_locations: { countries: ['KR'] },
      age_min: 18,
      age_max: 65,
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed', 'story', 'reels'],
      instagram_positions: ['stream', 'story', 'reels'],
    };
  }

  // ─── Ad Creative & Ads ─────────────────────────────────────

  /** Create ad creative */
  async createCreative({ name, pageId, instagramAccountId, message, headline, description, link, imageHash, imageUrl, callToAction = 'LEARN_MORE' }) {
    this._ensureConfigured();
    const linkData = {
      message,
      link,
      call_to_action: { type: callToAction },
    };
    if (headline)    linkData.name        = headline;
    if (description) linkData.description = description;
    if (imageHash)   linkData.image_hash  = imageHash;
    else if (imageUrl) linkData.picture   = imageUrl;

    const storySpec = { page_id: pageId, link_data: linkData };
    if (instagramAccountId) storySpec.instagram_user_id = instagramAccountId;

    const params = {
      name,
      object_story_spec: storySpec,
    };

    const result = await this._withTimeout(this.account.createAdCreative([], params), 'createCreative');
    logger.info('Meta creative created', { id: result.id, name });
    return result._data;
  }

  /** Create an ad linking creative to ad set */
  async createAd({ adSetId, creativeId, name, status = 'PAUSED', pixelId = null, conversionEvent = null }) {
    this._ensureConfigured();
    const params = {
      name,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status,
    };
    if (pixelId) {
      const spec = { 'action.type': ['offsite_conversion'], 'fb_pixel': [pixelId] };
      if (conversionEvent) spec['custom_event_type'] = [conversionEvent];
      params.tracking_specs = [spec];
    }

    const result = await this._withTimeout(this.account.createAd([], params), 'createAd');
    logger.info('Meta ad created', { id: result.id, name });
    return result._data;
  }

  // ─── Creative Image URL Resolution ────────────────────────

  /**
   * Resolve ad IDs to their creative image permalink URLs.
   * @param {string[]} adIds - Array of Meta ad IDs
   * @returns {Promise<Map<string, string>>} Map of adId → permalink_url
   */
  async getAdCreativeImages(adIds) {
    this._ensureConfigured();
    if (!adIds || adIds.length === 0) return new Map();

    const imageMap = new Map();
    const adHashCandidates = new Map(); // adId → [hash, ...] (all candidates, ordered)
    const hashRefCount = new Map();     // hash → number of ads referencing it
    const fallbackThumbnails = new Map(); // adId → thumbnail_url

    // Batch fetch creative data (50 ads per request)
    const batchSize = 50;
    for (let i = 0; i < adIds.length; i += batchSize) {
      const batch = adIds.slice(i, i + batchSize);
      try {
        const fields = ['id', 'creative{id,image_hash,thumbnail_url,object_story_spec,asset_feed_spec}'];
        const params = { ids: batch.join(','), fields: fields.join(',') };

        const response = await this._withTimeout(
          this.api.call('GET', [''], params),
          'getAdCreativeImages'
        );

        for (const adId of batch) {
          const adData = response?.[adId]?.creative;
          if (!adData) continue;

          const hashes = [];

          if (adData.asset_feed_spec?.images?.length > 0) {
            // DCO 광고: asset_feed_spec의 해시 선택은 부정확함 — thumbnail_url 사용
            if (adData.thumbnail_url) {
              fallbackThumbnails.set(adId, adData.thumbnail_url);
            }
          } else if (adData.image_hash) {
            hashes.push(adData.image_hash);
          } else if (adData.object_story_spec?.link_data?.image_hash) {
            hashes.push(adData.object_story_spec.link_data.image_hash);
          } else if (adData.object_story_spec?.photo_data?.image_hash) {
            hashes.push(adData.object_story_spec.photo_data.image_hash);
          } else if (adData.object_story_spec?.video_data?.image_hash) {
            hashes.push(adData.object_story_spec.video_data.image_hash);
          }

          if (hashes.length > 0) {
            adHashCandidates.set(adId, hashes);
            for (const h of hashes) {
              hashRefCount.set(h, (hashRefCount.get(h) || 0) + 1);
            }
          } else if (adData.thumbnail_url && !fallbackThumbnails.has(adId)) {
            fallbackThumbnails.set(adId, adData.thumbnail_url);
          }
        }
      } catch (err) {
        logger.warn(`Failed to fetch creative data for batch starting at index ${i}`, { error: err.message });
      }
    }

    // For each ad, select the most unique hash (fewest other ads sharing it).
    // This ensures Dynamic Creative ads get their own representative image
    // rather than a common placeholder shared across the entire ad set.
    const selectedHashToAdIds = new Map(); // hash → [adId, ...]
    for (const [adId, hashes] of adHashCandidates) {
      const best = hashes.slice().sort((a, b) =>
        (hashRefCount.get(a) || 0) - (hashRefCount.get(b) || 0)
      )[0];
      if (!selectedHashToAdIds.has(best)) selectedHashToAdIds.set(best, []);
      selectedHashToAdIds.get(best).push(adId);
    }

    // Bulk resolve hashes → permalink_url via AdImage API
    const uniqueHashes = [...selectedHashToAdIds.keys()];
    if (uniqueHashes.length > 0) {
      try {
        const hashBatchSize = 50;
        for (let i = 0; i < uniqueHashes.length; i += hashBatchSize) {
          const hashBatch = uniqueHashes.slice(i, i + hashBatchSize);
          const response = await this._withTimeout(
            this.api.call('GET', [this.accountId, 'adimages'], {
              hashes: JSON.stringify(hashBatch),
              fields: 'url,hash',
            }),
            'getAdImages'
          );

          const images = response?.data || [];
          for (const img of images) {
            if (img.url && selectedHashToAdIds.has(img.hash)) {
              for (const adId of selectedHashToAdIds.get(img.hash)) {
                imageMap.set(adId, img.url);
              }
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to resolve image hashes to CDN URLs', { error: err.message });
      }
    }

    // Apply thumbnail fallbacks for ads without a resolved CDN URL
    for (const [adId, thumbUrl] of fallbackThumbnails) {
      if (!imageMap.has(adId)) {
        imageMap.set(adId, thumbUrl);
      }
    }

    logger.info(`Resolved ${imageMap.size}/${adIds.length} ad creative image URLs (CDN-direct)`);
    return imageMap;
  }

  // ─── Insights / Reporting ──────────────────────────────────

  /** Get campaign-level performance insights */
  async getInsights({
    level = 'campaign',
    datePreset,
    timeRange,
    fields = [
      'campaign_id', 'campaign_name', 'impressions', 'clicks',
      'spend', 'actions', 'action_values', 'ctr', 'cpc', 'cpm',
      'cost_per_action_type', 'reach', 'frequency',
    ],
  } = {}) {
    this._ensureConfigured();
    const params = { level };

    if (datePreset) {
      params.date_preset = datePreset; // e.g. 'today', 'yesterday', 'last_7d'
    } else if (timeRange) {
      params.time_range = timeRange;   // { since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' }
    } else {
      params.date_preset = 'today';
    }

    const insights = await this._withTimeout(this.account.getInsights(fields, params), 'getInsights');
    logger.info(`Fetched ${insights.length} Meta insight rows`, { level });

    return insights.map(row => {
      const data = row._data;
      // Extract conversions from actions array
      const purchases = data.actions?.find(a => a.action_type === 'purchase');
      const purchaseValue = data.action_values?.find(a => a.action_type === 'purchase');

      return {
        campaignId: data.campaign_id,
        campaignName: data.campaign_name,
        impressions: parseInt(data.impressions || 0),
        clicks: parseInt(data.clicks || 0),
        spend: parseFloat(data.spend || 0),
        conversions: parseInt(purchases?.value || 0),
        conversionValue: parseFloat(purchaseValue?.value || 0),
        ctr: parseFloat(data.ctr || 0),
        cpc: parseFloat(data.cpc || 0),
        cpm: parseFloat(data.cpm || 0),
        reach: parseInt(data.reach || 0),
        frequency: parseFloat(data.frequency || 0),
      };
    });
  }

  /** Get real-time spend tracking (today's data) */
  async getTodaySpend() {
    return this.getInsights({ datePreset: 'today', level: 'account' });
  }

  /** Get ad-level performance insights */
  async getAdInsights({ datePreset = 'today', timeRange } = {}) {
    this._ensureConfigured();
    const fields = [
      'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
      'impressions', 'clicks', 'spend', 'actions', 'action_values', 'ctr', 'cpc', 'cpm',
    ];
    const params = { level: 'ad' };
    if (timeRange) {
      params.time_range = timeRange;
    } else {
      params.date_preset = datePreset;
    }

    const insights = await this._withTimeout(this.account.getInsights(fields, params), 'getAdInsights');
    logger.info(`Fetched ${insights.length} Meta ad-level insight rows`);

    return insights.map(row => {
      const data = row._data;
      const purchases = data.actions?.find(a => a.action_type === 'purchase');
      const purchaseValue = data.action_values?.find(a => a.action_type === 'purchase');
      const spend = parseFloat(data.spend || 0);
      const conversions = parseInt(purchases?.value || 0);
      const conversionValue = parseFloat(purchaseValue?.value || 0);

      return {
        adId: data.ad_id,
        adName: data.ad_name,
        adsetId: data.adset_id,
        adsetName: data.adset_name,
        campaignId: data.campaign_id,
        campaignName: data.campaign_name,
        impressions: parseInt(data.impressions || 0),
        clicks: parseInt(data.clicks || 0),
        spend,
        conversions,
        conversionValue,
        ctr: parseFloat(data.ctr || 0),
        cpc: parseFloat(data.cpc || 0),
        cpm: parseFloat(data.cpm || 0),
        roas: spend > 0 ? conversionValue / spend : 0,
        cpa: conversions > 0 ? spend / conversions : 0,
      };
    });
  }
}

export default MetaAdsClient;
