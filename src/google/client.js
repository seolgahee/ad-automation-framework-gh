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

    const campaigns = await this._withTimeout(this.customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign_budget.amount_micros,
        campaign.start_date_time,
        campaign.end_date_time
      FROM campaign
      WHERE campaign.status IN ('${safeFilter.join("','")}')
      ORDER BY campaign.name
    `), 'getCampaigns');

    logger.info(`Fetched ${campaigns.length} Google campaigns`);
    return campaigns.map(row => ({
      id: row.campaign.id,
      name: row.campaign.name,
      status: Object.keys(enums.CampaignStatus).find(
        k => enums.CampaignStatus[k] === row.campaign.status
      ),
      channelType: row.campaign.advertising_channel_type,
      dailyBudget: Number(row.campaign_budget.amount_micros) / 1_000_000,
      startDate: row.campaign.start_date_time,
      endDate: row.campaign.end_date_time,
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
    const budgetResult = await this._withTimeout(this.customer.campaignBudgets.create([{
      name: `${name}_budget`,
      amount_micros: Math.round(dailyBudget * 1_000_000),
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    }]), 'createBudget');

    // Step 2: Create campaign
    const campaignResult = await this._withTimeout(this.customer.campaigns.create([{
      name,
      status: enums.CampaignStatus[status],
      advertising_channel_type: enums.AdvertisingChannelType[channelType],
      campaign_budget: budgetResult.results[0].resource_name,
      bidding_strategy_type: enums.BiddingStrategyType[biddingStrategy],
    }]), 'createCampaign');

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
    const [campaign] = await this._withTimeout(this.customer.query(`
      SELECT campaign.campaign_budget FROM campaign
      WHERE campaign.id = ${safeCampaignId}
    `), 'getBudget');

    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    await this._withTimeout(this.customer.campaignBudgets.update({
      resource_name: campaign.campaign.campaign_budget,
      amount_micros: Math.round(newDailyBudget * 1_000_000),
    }), 'updateBudget');

    logger.info('Google campaign budget updated', { campaignId, newDailyBudget });
    return { success: true, campaignId, newDailyBudget };
  }

  /** Pause or enable a campaign */
  async setCampaignStatus(campaignId, status) {
    this._ensureConfigured();
    await this._withTimeout(this.customer.campaigns.update({
      resource_name: `customers/${this.customerId}/campaigns/${campaignId}`,
      status: enums.CampaignStatus[status],
    }), 'setCampaignStatus');
    logger.info('Google campaign status updated', { campaignId, status });
  }

  // ─── PMAX Campaign & Asset Group Management ─────────────────

  /**
   * Create a full PMAX campaign with all required assets in one mutate call.
   *
   * PMAX requires: budget + campaign + business name asset + logo asset + asset group
   * Uses temporary resource names for atomic creation.
   *
   * @param {Object} params
   * @param {string} params.name - Campaign name
   * @param {number} params.dailyBudget - Daily budget in KRW (default 1)
   * @param {string} params.businessName - Business name for brand guidelines
   * @param {string} params.logoBase64 - Square logo image (base64, min 128x128)
   * @param {string} params.marketingImageBase64 - Landscape image (base64, 1200x628)
   * @param {string} params.squareImageBase64 - Square image (base64, 1200x1200)
   * @param {string[]} params.finalUrls - Landing page URLs
   * @param {string[]} params.headlines - Headline texts (min 3, max 30 chars)
   * @param {string} params.longHeadline - Long headline (max 90 chars)
   * @param {string[]} params.descriptions - Description texts (min 2, max 90 chars)
   */
  async createPmaxCampaign({
    name, dailyBudget = 1,
    biddingStrategy = 'MAXIMIZE_CONVERSIONS',
    businessName, logoBase64, marketingImageBase64, squareImageBase64,
    finalUrls, headlines = [], longHeadline, descriptions = [],
  }) {
    this._ensureConfigured();

    // Use temporary resource names for atomic mutate
    const budgetTemp = `customers/${this.customerId}/campaignBudgets/-1`;
    const campaignTemp = `customers/${this.customerId}/campaigns/-2`;
    const businessNameAssetTemp = `customers/${this.customerId}/assets/-3`;
    const logoAssetTemp = `customers/${this.customerId}/assets/-4`;
    const assetGroupTemp = `customers/${this.customerId}/assetGroups/-5`;
    const marketingImageTemp = `customers/${this.customerId}/assets/-50`;
    const squareImageTemp = `customers/${this.customerId}/assets/-51`;
    const longHeadlineTemp = `customers/${this.customerId}/assets/-52`;

    const biddingConfig = biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE'
      ? { maximize_conversion_value: {} }
      : { maximize_conversions: {} };

    // Build mutate operations using google-ads-api format:
    // { entity: string, operation: 'create', resource: {...} }
    const mutations = [
      // 1. Campaign Budget
      {
        entity: 'campaign_budget',
        operation: 'create',
        resource: {
          resource_name: budgetTemp,
          name: `${name}_budget`,
          amount_micros: Math.round(dailyBudget * 1_000_000),
          delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          explicitly_shared: false,
        },
      },
      // 2. Campaign
      {
        entity: 'campaign',
        operation: 'create',
        resource: {
          resource_name: campaignTemp,
          name,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
          campaign_budget: budgetTemp,
          ...biddingConfig,
          // Required: EU political advertising compliance declaration
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        },
      },
      // 3. Business Name Asset
      {
        entity: 'asset',
        operation: 'create',
        resource: {
          resource_name: businessNameAssetTemp,
          text_asset: { text: businessName },
          type: enums.AssetType.TEXT,
        },
      },
      // 4. Link Business Name to Campaign
      {
        entity: 'campaign_asset',
        operation: 'create',
        resource: {
          campaign: campaignTemp,
          asset: businessNameAssetTemp,
          field_type: enums.AssetFieldType.BUSINESS_NAME,
        },
      },
    ];

    // 5-6. Logo image
    if (logoBase64) {
      mutations.push(
        {
          entity: 'asset',
          operation: 'create',
          resource: {
            resource_name: logoAssetTemp,
            name: `${name}_logo`,
            image_asset: { data: Buffer.from(logoBase64, 'base64') },
            type: enums.AssetType.IMAGE,
          },
        },
        {
          entity: 'campaign_asset',
          operation: 'create',
          resource: {
            campaign: campaignTemp,
            asset: logoAssetTemp,
            field_type: enums.AssetFieldType.LOGO,
          },
        }
      );
    }

    // 7-8. Marketing image (landscape 1200x628)
    if (marketingImageBase64) {
      mutations.push(
        {
          entity: 'asset',
          operation: 'create',
          resource: {
            resource_name: marketingImageTemp,
            name: `${name}_marketing_image`,
            image_asset: { data: Buffer.from(marketingImageBase64, 'base64') },
            type: enums.AssetType.IMAGE,
          },
        }
      );
    }

    // 9-10. Square marketing image (1200x1200)
    if (squareImageBase64) {
      mutations.push(
        {
          entity: 'asset',
          operation: 'create',
          resource: {
            resource_name: squareImageTemp,
            name: `${name}_square_image`,
            image_asset: { data: Buffer.from(squareImageBase64, 'base64') },
            type: enums.AssetType.IMAGE,
          },
        }
      );
    }

    // Create all text assets first (before asset group)
    // Long headline
    if (longHeadline) {
      mutations.push({
        entity: 'asset',
        operation: 'create',
        resource: {
          resource_name: longHeadlineTemp,
          text_asset: { text: longHeadline },
          type: enums.AssetType.TEXT,
        },
      });
    }

    // Headline assets
    let assetIdx = -6;
    const headlineTemps = [];
    for (const text of headlines) {
      const assetTemp = `customers/${this.customerId}/assets/${assetIdx--}`;
      headlineTemps.push(assetTemp);
      mutations.push({
        entity: 'asset',
        operation: 'create',
        resource: {
          resource_name: assetTemp,
          text_asset: { text },
          type: enums.AssetType.TEXT,
        },
      });
    }

    // Description assets
    const descriptionTemps = [];
    for (const text of descriptions) {
      const assetTemp = `customers/${this.customerId}/assets/${assetIdx--}`;
      descriptionTemps.push(assetTemp);
      mutations.push({
        entity: 'asset',
        operation: 'create',
        resource: {
          resource_name: assetTemp,
          text_asset: { text },
          type: enums.AssetType.TEXT,
        },
      });
    }

    // Now create Asset Group (after all assets exist)
    mutations.push({
      entity: 'asset_group',
      operation: 'create',
      resource: {
        resource_name: assetGroupTemp,
        campaign: campaignTemp,
        name: `${name}_AssetGroup`,
        status: enums.AssetGroupStatus.PAUSED,
        final_urls: finalUrls,
        final_mobile_urls: finalUrls,
      },
    });

    // Link all assets to asset group
    if (marketingImageBase64) {
      mutations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupTemp,
          asset: marketingImageTemp,
          field_type: enums.AssetFieldType.MARKETING_IMAGE,
        },
      });
    }
    if (squareImageBase64) {
      mutations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupTemp,
          asset: squareImageTemp,
          field_type: enums.AssetFieldType.SQUARE_MARKETING_IMAGE,
        },
      });
    }
    if (longHeadline) {
      mutations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupTemp,
          asset: longHeadlineTemp,
          field_type: enums.AssetFieldType.LONG_HEADLINE,
        },
      });
    }
    for (const temp of headlineTemps) {
      mutations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupTemp,
          asset: temp,
          field_type: enums.AssetFieldType.HEADLINE,
        },
      });
    }
    for (const temp of descriptionTemps) {
      mutations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupTemp,
          asset: temp,
          field_type: enums.AssetFieldType.DESCRIPTION,
        },
      });
    }

    const result = await this._withTimeout(
      this.customer.mutateResources(mutations),
      'createPmaxCampaign'
    );

    // Extract campaign ID from results
    const campaignResult = result.mutate_operation_responses[1];
    const campaignResourceName = campaignResult.campaign_result?.resource_name;
    const campaignId = campaignResourceName?.split('/').pop();

    logger.info('Google PMAX campaign created (PAUSED)', { id: campaignId, name, dailyBudget });
    return { id: campaignId, name, dailyBudget, resourceName: campaignResourceName, result };
  }

  // ─── Ad Group & Ad Management ──────────────────────────────

  /** Create an ad group */
  async createAdGroup({ campaignId, name, cpcBidMicros, status = 'PAUSED' }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroups.create({
      campaign: `customers/${this.customerId}/campaigns/${campaignId}`,
      name,
      status: enums.AdGroupStatus[status],
      cpc_bid_micros: cpcBidMicros || 1_000_000, // Default 1 unit
      type: enums.AdGroupType.SEARCH_STANDARD,
    }), 'createAdGroup');

    const adGroupId = result.results[0].resource_name.split('/').pop();
    logger.info('Google ad group created', { id: adGroupId, name });
    return { id: adGroupId, name };
  }

  /** Create a responsive search ad */
  async createResponsiveSearchAd({ adGroupId, headlines, descriptions, finalUrls }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.ads.create({
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        responsive_search_ad: {
          headlines: headlines.map(h => ({ text: h })),
          descriptions: descriptions.map(d => ({ text: d })),
        },
        final_urls: finalUrls,
      },
      status: enums.AdGroupAdStatus.PAUSED,
    }), 'createAd');

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

    const result = await this._withTimeout(this.customer.adGroupCriteria.create(operations), 'addKeywords');
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

    const rows = await this._withTimeout(this.customer.query(query), 'getPerformance');
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

  /**
   * Get ad-level performance insights
   *
   * Google Ads has two ad-level resources depending on campaign type:
   * - ad_group_ad: SEARCH, DISPLAY, VIDEO, SHOPPING, etc.
   * - asset_group: PERFORMANCE_MAX (PMAX) campaigns
   *
   * This method queries both and merges the results.
   */
  async getAdInsights({ dateFrom, dateTo } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = this._validateDate(dateFrom || today);
    const to = this._validateDate(dateTo || today);

    // Query 1: Standard ads (SEARCH, DISPLAY, VIDEO, SHOPPING, etc.)
    const adQuery = `
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad.name,
        ad_group.id,
        ad_group.name,
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
      FROM ad_group_ad
      WHERE segments.date BETWEEN '${from}' AND '${to}'
        AND campaign.status != 'REMOVED'
        AND ad_group_ad.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
    `;

    // Query 2: PMAX asset groups (PMAX campaigns don't use ad_group_ad)
    const assetGroupQuery = `
      SELECT
        asset_group.id,
        asset_group.name,
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM asset_group
      WHERE segments.date BETWEEN '${from}' AND '${to}'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
    `;

    const [adRows, assetRows] = await Promise.all([
      this._withTimeout(this.customer.query(adQuery), 'getAdInsights:ad_group_ad'),
      this._withTimeout(this.customer.query(assetGroupQuery), 'getAdInsights:asset_group'),
    ]);

    const standardAds = adRows.map(row => ({
      adId: String(row.ad_group_ad.ad.id),
      adName: row.ad_group_ad.ad.name || '',
      adGroupId: String(row.ad_group.id),
      adGroupName: row.ad_group.name,
      campaignId: String(row.campaign.id),
      campaignName: row.campaign.name,
      impressions: Number(row.metrics.impressions || 0),
      clicks: Number(row.metrics.clicks || 0),
      spend: Number(row.metrics.cost_micros || 0) / 1_000_000,
      conversions: Number(row.metrics.conversions || 0),
      conversionValue: Number(row.metrics.conversions_value || 0),
      ctr: Number(row.metrics.ctr || 0),
      cpc: Number(row.metrics.average_cpc || 0) / 1_000_000,
      cpm: Number(row.metrics.average_cpm || 0) / 1_000_000,
    }));

    const pmaxAds = assetRows.map(row => {
      const impressions = Number(row.metrics.impressions || 0);
      const clicks = Number(row.metrics.clicks || 0);
      const spend = Number(row.metrics.cost_micros || 0) / 1_000_000;
      return {
        adId: `ag_${row.asset_group.id}`,
        adName: row.asset_group.name || '',
        adGroupId: `ag_${row.asset_group.id}`,
        adGroupName: row.asset_group.name || '',
        campaignId: String(row.campaign.id),
        campaignName: row.campaign.name,
        impressions,
        clicks,
        spend,
        conversions: Number(row.metrics.conversions || 0),
        conversionValue: Number(row.metrics.conversions_value || 0),
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
        cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
      };
    });

    const all = [...standardAds, ...pmaxAds];
    logger.info(`Fetched ${all.length} Google ad-level insight rows (${standardAds.length} standard + ${pmaxAds.length} PMAX)`, { from, to });
    return all;
  }

  /** Quick today spend check */
  async getTodaySpend() {
    return this.getPerformance({ level: 'campaign' });
  }
}

export default GoogleAdsClient;
