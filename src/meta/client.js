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
      'id', 'name', 'status', 'objective', 'daily_budget',
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
  async createCreative({ name, pageId, message, link, imageHash, callToAction = 'LEARN_MORE' }) {
    this._ensureConfigured();
    const params = {
      name,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          message,
          link,
          image_hash: imageHash,
          call_to_action: { type: callToAction },
        },
      },
    };

    const result = await this._withTimeout(this.account.createAdCreative([], params), 'createCreative');
    logger.info('Meta creative created', { id: result.id, name });
    return result._data;
  }

  /** Create an ad linking creative to ad set */
  async createAd({ adSetId, creativeId, name, status = 'PAUSED' }) {
    this._ensureConfigured();
    const params = {
      name,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status,
    };

    const result = await this._withTimeout(this.account.createAd([], params), 'createAd');
    logger.info('Meta ad created', { id: result.id, name });
    return result._data;
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
