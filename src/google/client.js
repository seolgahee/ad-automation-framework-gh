/**
 * Google Ads API Client
 *
 * Handles: campaign CRUD, ad group management, keyword targeting,
 * responsive search ads, and performance reporting.
 *
 * Docs: https://developers.google.com/google-ads/api/docs/start
 */
import { GoogleAdsApi, enums } from 'google-ads-api';
import logger from '../utils/logger.js';
import { BaseAdsClient } from '../utils/base-client.js';

export class GoogleAdsClient extends BaseAdsClient {
  constructor() {
    super();
    this.clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    this.developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    this.refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
    this.customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, '');
    this.loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '');

    if (!this.clientId || !this.developerToken) {
      logger.warn('Google Ads API credentials not fully configured');
      return;
    }
    this._configured = true;

    this.api = new GoogleAdsApi({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      developer_token: this.developerToken,
    });

    this.customer = this.api.Customer({
      customer_id: this.customerId,
      login_customer_id: this.loginCustomerId,
      refresh_token: this.refreshToken,
    });

    logger.info('Google Ads client initialized', { customer: this.customerId });
  }

  // ─── Campaign Management ───────────────────────────────────

  /** List campaigns with optional status filter */
  async getCampaigns(statusFilter = ['ENABLED', 'PAUSED']) {
    this._ensureConfigured();
    // Only allow known status enum keys — prevents injection via statusFilter
    const ALLOWED_STATUSES = ['ENABLED', 'PAUSED', 'REMOVED', 'UNKNOWN', 'UNSPECIFIED'];
    const safeFilter = statusFilter.filter(s => ALLOWED_STATUSES.includes(s));
    const statusValues = safeFilter.map(s => enums.CampaignStatus[s]).filter(Boolean);

    const campaigns = await this.customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign_budget.amount_micros,
        campaign.start_date,
        campaign.end_date
      FROM campaign
      WHERE campaign.status IN (${statusValues.join(',')})
      ORDER BY campaign.name
    `);

    logger.info(`Fetched ${campaigns.length} Google campaigns`);
    return campaigns.map(row => ({
      id: row.campaign.id,
      name: row.campaign.name,
      status: Object.keys(enums.CampaignStatus).find(
        k => enums.CampaignStatus[k] === row.campaign.status
      ),
      channelType: row.campaign.advertising_channel_type,
      dailyBudget: Number(row.campaign_budget.amount_micros) / 1_000_000,
      startDate: row.campaign.start_date,
      endDate: row.campaign.end_date,
    }));
  }

  /** Create a search campaign with budget */
  async createCampaign({
    name, dailyBudget,
    channelType = 'SEARCH',
    status = 'PAUSED',
    biddingStrategy = 'MAXIMIZE_CONVERSIONS',
  }) {
    this._ensureConfigured();
    // Step 1: Create campaign budget
    const budgetResult = await this.customer.campaignBudgets.create({
      name: `${name}_budget`,
      amount_micros: Math.round(dailyBudget * 1_000_000),
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    });

    // Step 2: Create campaign
    const campaignResult = await this.customer.campaigns.create({
      name,
      status: enums.CampaignStatus[status],
      advertising_channel_type: enums.AdvertisingChannelType[channelType],
      campaign_budget: budgetResult.results[0].resource_name,
      bidding_strategy_type: enums.BiddingStrategyType[biddingStrategy],
    });

    const campaignId = campaignResult.results[0].resource_name.split('/').pop();
    logger.info('Google campaign created', { id: campaignId, name });
    return { id: campaignId, name, dailyBudget };
  }

  /** Update campaign budget */
  async updateBudget(campaignId, newDailyBudget) {
    this._ensureConfigured();
    // Validate campaignId is numeric to prevent GAQL injection
    const safeCampaignId = String(campaignId).replace(/\D/g, '');
    if (!safeCampaignId) throw new Error('Invalid campaign ID — must be numeric');

    // Find current budget resource
    const [campaign] = await this.customer.query(`
      SELECT campaign.campaign_budget FROM campaign
      WHERE campaign.id = ${safeCampaignId}
    `);

    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    await this.customer.campaignBudgets.update({
      resource_name: campaign.campaign.campaign_budget,
      amount_micros: Math.round(newDailyBudget * 1_000_000),
    });

    logger.info('Google campaign budget updated', { campaignId, newDailyBudget });
    return { success: true, campaignId, newDailyBudget };
  }

  /** Pause or enable a campaign */
  async setCampaignStatus(campaignId, status) {
    this._ensureConfigured();
    await this.customer.campaigns.update({
      resource_name: `customers/${this.customerId}/campaigns/${campaignId}`,
      status: enums.CampaignStatus[status],
    });
    logger.info('Google campaign status updated', { campaignId, status });
  }

  // ─── Ad Group & Ad Management ──────────────────────────────

  /** Create an ad group */
  async createAdGroup({ campaignId, name, cpcBidMicros, status = 'PAUSED' }) {
    this._ensureConfigured();
    const result = await this.customer.adGroups.create({
      campaign: `customers/${this.customerId}/campaigns/${campaignId}`,
      name,
      status: enums.AdGroupStatus[status],
      cpc_bid_micros: cpcBidMicros || 1_000_000, // Default 1 unit
      type: enums.AdGroupType.SEARCH_STANDARD,
    });

    const adGroupId = result.results[0].resource_name.split('/').pop();
    logger.info('Google ad group created', { id: adGroupId, name });
    return { id: adGroupId, name };
  }

  /** Create a responsive search ad */
  async createResponsiveSearchAd({ adGroupId, headlines, descriptions, finalUrls }) {
    this._ensureConfigured();
    const result = await this.customer.ads.create({
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        responsive_search_ad: {
          headlines: headlines.map(h => ({ text: h })),
          descriptions: descriptions.map(d => ({ text: d })),
        },
        final_urls: finalUrls,
      },
      status: enums.AdGroupAdStatus.PAUSED,
    });

    logger.info('Google responsive search ad created', { adGroupId });
    return result;
  }

  /** Add keywords to an ad group */
  async addKeywords(adGroupId, keywords) {
    this._ensureConfigured();
    const operations = keywords.map(({ text, matchType = 'BROAD' }) => ({
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      keyword: { text, match_type: enums.KeywordMatchType[matchType] },
      status: enums.AdGroupCriterionStatus.ENABLED,
    }));

    const result = await this.customer.adGroupCriteria.create(operations);
    logger.info(`Added ${keywords.length} keywords to ad group ${adGroupId}`);
    return result;
  }

  // ─── Reporting / Insights ──────────────────────────────────

  /** Validate date string format (YYYY-MM-DD) to prevent GAQL injection */
  _validateDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error(`Invalid date format: "${dateStr}" — expected YYYY-MM-DD`);
    }
    return dateStr;
  }

  /** Get campaign performance for a date range */
  async getPerformance({ dateFrom, dateTo, level = 'campaign' } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = this._validateDate(dateFrom || today);
    const to = this._validateDate(dateTo || today);

    // Validate level to prevent unexpected query shapes
    const safeLevel = level === 'ad_group' ? 'ad_group' : 'campaign';

    let query;
    if (safeLevel === 'campaign') {
      query = `
        SELECT
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.ctr,
          metrics.average_cpc,
          metrics.average_cpm
        FROM campaign
        WHERE segments.date BETWEEN '${from}' AND '${to}'
          AND campaign.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
      `;
    } else {
      query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.ctr,
          metrics.average_cpc
        FROM ad_group
        WHERE segments.date BETWEEN '${from}' AND '${to}'
          AND campaign.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
      `;
    }

    const rows = await this.customer.query(query);
    logger.info(`Fetched ${rows.length} Google performance rows`, { level, from, to });

    return rows.map(row => ({
      campaignId: String(row.campaign.id),
      campaignName: row.campaign.name,
      adGroupId: row.ad_group?.id ? String(row.ad_group.id) : null,
      adGroupName: row.ad_group?.name || null,
      impressions: Number(row.metrics.impressions || 0),
      clicks: Number(row.metrics.clicks || 0),
      spend: Number(row.metrics.cost_micros || 0) / 1_000_000,
      conversions: Number(row.metrics.conversions || 0),
      conversionValue: Number(row.metrics.conversions_value || 0),
      ctr: Number(row.metrics.ctr || 0),
      cpc: Number(row.metrics.average_cpc || 0) / 1_000_000,
      cpm: Number(row.metrics.average_cpm || 0) / 1_000_000,
    }));
  }

  /** Quick today spend check */
  async getTodaySpend() {
    return this.getPerformance({ level: 'campaign' });
  }
}

export default GoogleAdsClient;
