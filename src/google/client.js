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

  /**
   * Create a campaign with budget.
   * Supports: SEARCH, DISPLAY, VIDEO, DEMAND_GEN, SHOPPING, PERFORMANCE_MAX
   *
   * @param {Object} params
   * @param {string} params.channelType - SEARCH | DISPLAY | VIDEO | DEMAND_GEN | SHOPPING
   * @param {string} [params.merchantId] - Required for SHOPPING campaigns (Google Merchant Center ID)
   */
  async createCampaign({
    name, dailyBudget,
    channelType = 'SEARCH',
    status = 'PAUSED',
    biddingStrategy = 'MAXIMIZE_CONVERSIONS',
    merchantId,
  }) {
    this._ensureConfigured();
    // Step 1: Create campaign budget
    const budgetResult = await this._withTimeout(this.customer.campaignBudgets.create([{
      name: `${name}_budget`,
      amount_micros: Math.round(dailyBudget * 1_000_000),
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    }]), 'createBudget');

    // Step 2: Build campaign object
    const campaignObj = {
      name,
      status: enums.CampaignStatus[status],
      advertising_channel_type: enums.AdvertisingChannelType[channelType],
      campaign_budget: budgetResult.results[0].resource_name,
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    };

    // Bidding strategy: VIDEO uses TARGET_CPM or TARGET_CPV, others use smart bidding objects
    if (channelType === 'VIDEO') {
      // VIDEO campaigns: use target_cpv (cost per view) by default
      campaignObj.target_cpv = {};
    } else if (biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
      campaignObj.maximize_conversions = {};
    } else if (biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') {
      campaignObj.maximize_conversion_value = {};
    } else if (biddingStrategy === 'MAXIMIZE_CLICKS') {
      campaignObj.maximize_clicks = {};
    } else if (biddingStrategy === 'TARGET_CPA') {
      campaignObj.target_cpa = {};
    } else {
      campaignObj.bidding_strategy_type = enums.BiddingStrategyType[biddingStrategy];
    }

    // Shopping requires merchant_id
    if (channelType === 'SHOPPING' && merchantId) {
      campaignObj.shopping_setting = { merchant_id: Number(merchantId) };
    }

    const campaignResult = await this._withTimeout(
      this.customer.campaigns.create([campaignObj]), 'createCampaign'
    );

    const campaignId = campaignResult.results[0].resource_name.split('/').pop();
    logger.info('Google campaign created', { id: campaignId, name, channelType });
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

  // ─── Demand Gen Campaign ──────────────────────────────────

  /**
   * Create a Demand Gen campaign with ad group + ad.
   *
   * Two-phase approach:
   * Phase 1: mutateResources → Budget + Campaign + Ad Group (atomic)
   * Phase 2: Upload image/video assets individually, then create ad via ads.create
   *
   * Supports two ad types:
   * - 'image': demand_gen_multi_asset_ad
   * - 'video': demand_gen_video_responsive_ad
   */
  async createDemandGenCampaign({
    // Campaign
    name, dailyBudget = 1, biddingGoal = 'CONVERSIONS',
    targetCpaMicros, merchantId, startDate, endDate,
    // Ad Group
    adGroupName,
    // Ad (common)
    adType = 'image', adName, businessName, finalUrls,
    headlines = [], descriptions = [], callToActionText,
    logoBase64,
    // Image ad type
    marketingImagesBase64 = [], squareImagesBase64 = [],
    // Video ad type
    youtubeVideoIds = [], longHeadlines = [],
  }) {
    this._ensureConfigured();

    // ── Phase 1: Create Campaign + Ad Group via mutateResources ──
    const budgetTemp = `customers/${this.customerId}/campaignBudgets/-1`;
    const campaignTemp = `customers/${this.customerId}/campaigns/-2`;
    const adGroupTemp = `customers/${this.customerId}/adGroups/-3`;

    const biddingConfig = biddingGoal === 'CLICKS'
      ? { maximize_clicks: {} }
      : biddingGoal === 'CONVERSION_VALUE'
        ? { maximize_conversion_value: {} }
        : targetCpaMicros
          ? { maximize_conversions: { target_cpa_micros: targetCpaMicros } }
          : { maximize_conversions: {} };

    // Phase 1a: Budget + Campaign (mutateResources)
    const phase1Mutations = [
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
      {
        entity: 'campaign',
        operation: 'create',
        resource: {
          resource_name: campaignTemp,
          name,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.DEMAND_GEN,
          campaign_budget: budgetTemp,
          ...biddingConfig,
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
          ...(startDate && { start_date: startDate }),
          ...(endDate && { end_date: endDate }),
          ...(merchantId && { shopping_setting: { merchant_id: Number(merchantId) } }),
        },
      },
    ];

    const phase1Result = await this._withTimeout(
      this.customer.mutateResources(phase1Mutations),
      'createDemandGenCampaign_phase1'
    );

    const campaignResourceName = phase1Result.mutate_operation_responses[1].campaign_result?.resource_name;
    const campaignId = campaignResourceName?.split('/').pop();

    // Phase 1b: Ad Group (separate create — Demand Gen auto-assigns type)
    const adGroupResult = await this._withTimeout(
      this.customer.adGroups.create([{
        campaign: campaignResourceName,
        name: adGroupName || `${name}_AdGroup`,
        status: enums.AdGroupStatus.PAUSED,
      }]),
      'createDemandGenCampaign_adGroup'
    );
    const adGroupResourceName = adGroupResult.results[0].resource_name;
    const adGroupId = adGroupResourceName.split('/').pop();

    logger.info('Demand Gen campaign + ad group created', { campaignId, adGroupId });

    // ── Phase 2: Upload assets individually, then create ad ──
    const logoAssetNames = [];
    if (logoBase64) {
      const res = await this.createImageAsset({ name: `${name}_logo`, imageBase64: logoBase64 });
      logoAssetNames.push(res);
    }

    const marketingAssetNames = [];
    for (const [i, base64] of marketingImagesBase64.entries()) {
      const res = await this.createImageAsset({ name: `${name}_img_${i}`, imageBase64: base64 });
      marketingAssetNames.push(res);
    }

    const squareAssetNames = [];
    for (const [i, base64] of squareImagesBase64.entries()) {
      const res = await this.createImageAsset({ name: `${name}_sq_${i}`, imageBase64: base64 });
      squareAssetNames.push(res);
    }

    const videoAssetNames = [];
    for (const [i, videoId] of youtubeVideoIds.entries()) {
      const res = await this.createYouTubeVideoAsset({ videoId, name: `${name}_vid_${i}` });
      videoAssetNames.push(res);
    }

    // Build the ad object
    const adObj = {
      ad_group: adGroupResourceName,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        ...(adName && { name: adName }),
        final_urls: finalUrls,
      },
    };

    if (adType === 'video') {
      adObj.ad.demand_gen_video_responsive_ad = {
        headlines: headlines.map(text => ({ text })),
        long_headlines: longHeadlines.map(text => ({ text })),
        descriptions: descriptions.map(text => ({ text })),
        business_name: businessName,
        ...(callToActionText && { call_to_action_text: callToActionText }),
        ...(videoAssetNames.length && { videos: videoAssetNames.map(a => ({ asset: a })) }),
        ...(logoAssetNames.length && { logo_images: logoAssetNames.map(a => ({ asset: a })) }),
      };
    } else {
      adObj.ad.demand_gen_multi_asset_ad = {
        headlines: headlines.map(text => ({ text })),
        descriptions: descriptions.map(text => ({ text })),
        business_name: businessName,
        ...(callToActionText && { call_to_action_text: callToActionText }),
        ...(marketingAssetNames.length && { marketing_images: marketingAssetNames.map(a => ({ asset: a })) }),
        ...(squareAssetNames.length && { square_marketing_images: squareAssetNames.map(a => ({ asset: a })) }),
        ...(logoAssetNames.length && { logo_images: logoAssetNames.map(a => ({ asset: a })) }),
      };
    }

    await this._withTimeout(
      this.customer.adGroupAds.create([adObj]),
      'createDemandGenCampaign_ad'
    );

    logger.info('Google Demand Gen campaign created (PAUSED)', { id: campaignId, name, adType, dailyBudget });
    return { id: campaignId, name, dailyBudget, adType, adGroupId, resourceName: campaignResourceName };
  }

  // ─── Ad Group & Ad Management ──────────────────────────────

  /**
   * Create an ad group.
   * @param {string} [adGroupType] - SEARCH_STANDARD | DISPLAY_STANDARD | VIDEO_RESPONSIVE | SHOPPING_PRODUCT_ADS
   */
  async createAdGroup({ campaignId, name, cpcBidMicros, status = 'PAUSED', adGroupType = 'SEARCH_STANDARD' }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroups.create([{
      campaign: `customers/${this.customerId}/campaigns/${campaignId}`,
      name,
      status: enums.AdGroupStatus[status],
      cpc_bid_micros: cpcBidMicros || 1_000_000,
      type: enums.AdGroupType[adGroupType],
    }]), 'createAdGroup');

    const adGroupId = result.results[0].resource_name.split('/').pop();
    logger.info('Google ad group created', { id: adGroupId, name, type: adGroupType });
    return { id: adGroupId, name };
  }

  /** Create a responsive search ad */
  async createResponsiveSearchAd({ adGroupId, headlines, descriptions, finalUrls }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroupAds.create([{
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        responsive_search_ad: {
          headlines: headlines.map(h => ({ text: h })),
          descriptions: descriptions.map(d => ({ text: d })),
        },
        final_urls: finalUrls,
      },
      status: enums.AdGroupAdStatus.PAUSED,
    }]), 'createAd');

    logger.info('Google responsive search ad created', { adGroupId });
    return result;
  }

  /**
   * Create a responsive display ad (for DISPLAY campaigns).
   * @param {Object} params
   * @param {string} params.adGroupId
   * @param {string[]} params.headlines - Short headlines (max 5, each 30 chars)
   * @param {string} params.longHeadline - Long headline (max 90 chars)
   * @param {string[]} params.descriptions - Descriptions (max 5, each 90 chars)
   * @param {string} params.businessName
   * @param {string[]} params.finalUrls
   * @param {string[]} [params.marketingImageAssets] - Resource names of marketing images
   * @param {string[]} [params.squareImageAssets] - Resource names of square images
   * @param {string[]} [params.logoImageAssets] - Resource names of logo images
   */
  async createResponsiveDisplayAd({ adGroupId, headlines, longHeadline, descriptions, businessName, finalUrls,
                                     marketingImageAssets = [], squareImageAssets = [], logoImageAssets = [], squareLogoImageAssets = [] }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroupAds.create([{
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        responsive_display_ad: {
          headlines: headlines.map(h => ({ text: h })),
          long_headline: { text: longHeadline },
          descriptions: descriptions.map(d => ({ text: d })),
          business_name: businessName,
          ...(marketingImageAssets.length && { marketing_images: marketingImageAssets.map(a => ({ asset: a })) }),
          ...(squareImageAssets.length && { square_marketing_images: squareImageAssets.map(a => ({ asset: a })) }),
          ...(logoImageAssets.length && { logo_images: logoImageAssets.map(a => ({ asset: a })) }),
          ...(squareLogoImageAssets.length && { square_logo_images: squareLogoImageAssets.map(a => ({ asset: a })) }),
        },
        final_urls: finalUrls,
      },
      status: enums.AdGroupAdStatus.PAUSED,
    }]), 'createResponsiveDisplayAd');

    logger.info('Google responsive display ad created', { adGroupId });
    return result;
  }

  /**
   * Create a video ad (for VIDEO campaigns).
   * @param {Object} params
   * @param {string} params.adGroupId
   * @param {string} params.videoId - YouTube video ID (e.g., 'dQw4w9WgXcQ')
   * @param {string} params.headline - Ad headline
   * @param {string} [params.description] - Ad description
   * @param {string[]} params.finalUrls
   * @param {string} [params.companionBannerAsset] - Companion banner image asset resource name
   */
  async createVideoAd({ adGroupId, videoId, headline, description = '', finalUrls, companionBannerAsset }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroupAds.create([{
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        video_ad: {
          video: { asset: `customers/${this.customerId}/assets/${videoId}` },
          in_stream: {
            action_headline: headline,
            ...(companionBannerAsset && { companion_banner: { asset: companionBannerAsset } }),
          },
        },
        final_urls: finalUrls,
        ...(headline && { headlines: [{ text: headline }] }),
        ...(description && { descriptions: [{ text: description }] }),
      },
      status: enums.AdGroupAdStatus.PAUSED,
    }]), 'createVideoAd');

    logger.info('Google video ad created', { adGroupId, videoId });
    return result;
  }

  /**
   * Create a Demand Gen multi-asset ad.
   * @param {Object} params
   * @param {string} params.adGroupId
   * @param {string[]} params.headlines - Headlines (max 5)
   * @param {string[]} params.descriptions - Descriptions (max 5)
   * @param {string} params.businessName
   * @param {string[]} params.finalUrls
   * @param {string[]} [params.marketingImageAssets] - Marketing image asset resource names
   * @param {string[]} [params.squareImageAssets] - Square image asset resource names
   * @param {string[]} [params.logoImageAssets] - Logo image asset resource names
   * @param {string} [params.callToActionText] - CTA text
   */
  async createDemandGenAd({ adGroupId, headlines, descriptions, businessName, finalUrls,
                             marketingImageAssets = [], squareImageAssets = [], logoImageAssets = [],
                             callToActionText }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroupAds.create([{
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: {
        demand_gen_multi_asset_ad: {
          headlines: headlines.map(h => ({ text: h })),
          descriptions: descriptions.map(d => ({ text: d })),
          business_name: businessName,
          ...(callToActionText && { call_to_action_text: callToActionText }),
          ...(marketingImageAssets.length && { marketing_images: marketingImageAssets.map(a => ({ asset: a })) }),
          ...(squareImageAssets.length && { square_marketing_images: squareImageAssets.map(a => ({ asset: a })) }),
          ...(logoImageAssets.length && { logo_images: logoImageAssets.map(a => ({ asset: a })) }),
        },
        final_urls: finalUrls,
      },
      status: enums.AdGroupAdStatus.PAUSED,
    }]), 'createDemandGenAd');

    logger.info('Google demand gen ad created', { adGroupId });
    return result;
  }

  /**
   * Create a shopping product ad (for SHOPPING campaigns).
   * Shopping ads are auto-populated from Merchant Center feed — no creative fields needed.
   */
  async createShoppingProductAd({ adGroupId }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.adGroupAds.create([{
      ad_group: `customers/${this.customerId}/adGroups/${adGroupId}`,
      ad: { shopping_product_ad: {} },
      status: enums.AdGroupAdStatus.PAUSED,
    }]), 'createShoppingProductAd');

    logger.info('Google shopping product ad created', { adGroupId });
    return result;
  }

  /**
   * Upload an image asset and return its resource name.
   * Used by Display/DemandGen campaigns that need image assets.
   */
  async createImageAsset({ name, imageBase64 }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.assets.create([{
      name,
      type: enums.AssetType.IMAGE,
      image_asset: { data: Buffer.from(imageBase64, 'base64') },
    }]), 'createImageAsset');

    const resourceName = result.results[0].resource_name;
    logger.info('Google image asset created', { name, resourceName });
    return resourceName;
  }

  /**
   * Create a YouTube video asset from a YouTube video ID.
   */
  async createYouTubeVideoAsset({ videoId, name }) {
    this._ensureConfigured();
    const result = await this._withTimeout(this.customer.assets.create([{
      name: name || `video_${videoId}`,
      type: enums.AssetType.YOUTUBE_VIDEO,
      youtube_video_asset: { youtube_video_id: videoId },
    }]), 'createYouTubeVideoAsset');

    const resourceName = result.results[0].resource_name;
    logger.info('YouTube video asset created', { videoId, resourceName });
    return resourceName;
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

  /** List ad groups for a campaign */
  async getAdGroups(campaignId) {
    this._ensureConfigured();
    const safeCampaignId = String(campaignId).replace(/\D/g, '');
    if (!safeCampaignId) throw new Error('Invalid campaign ID');

    const rows = await this._withTimeout(this.customer.query(`
      SELECT ad_group.id, ad_group.name, ad_group.status
      FROM ad_group
      WHERE campaign.id = ${safeCampaignId}
        AND ad_group.status IN ('ENABLED', 'PAUSED')
      ORDER BY ad_group.name
    `), 'getAdGroups');

    return rows.map(row => ({
      id: String(row.ad_group.id),
      name: row.ad_group.name,
      status: row.ad_group.status,
    }));
  }

  /** List all PMAX campaigns (advertising_channel_sub_type = PERFORMANCE_MAX) */
  async getPmaxCampaigns() {
    this._ensureConfigured();
    const rows = await this._withTimeout(this.customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.advertising_channel_sub_type
      FROM campaign
      WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
        AND campaign.status != 'REMOVED'
      ORDER BY campaign.name
    `), 'getPmaxCampaigns');
    return rows.map(r => ({
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status,
    }));
  }

  /** List asset groups for a PMAX campaign */
  async getAssetGroups(campaignId) {
    this._ensureConfigured();
    const rows = await this._withTimeout(this.customer.query(`
      SELECT
        asset_group.id,
        asset_group.name,
        asset_group.status,
        campaign.id,
        campaign.name
      FROM asset_group
      WHERE campaign.id = '${campaignId}'
        AND asset_group.status != 'REMOVED'
      ORDER BY asset_group.name
    `), 'getAssetGroups');
    return rows.map(r => ({
      id: String(r.asset_group.id),
      name: r.asset_group.name,
      status: r.asset_group.status,
      campaignId: String(r.campaign.id),
      campaignName: r.campaign.name,
    }));
  }

  /**
   * Get current asset counts per field type for an asset group.
   * Used to validate against PMAX per-field-type limits before adding.
   */
  async getAssetGroupAssetCounts(assetGroupId) {
    this._ensureConfigured();
    // fieldType numbers: MARKETING_IMAGE=5, SQUARE_MARKETING_IMAGE=19, PORTRAIT_MARKETING_IMAGE=20, LOGO=21
    const FIELD_TYPE_NUM_TO_NAME = { 5: 'MARKETING_IMAGE', 19: 'SQUARE_MARKETING_IMAGE', 20: 'PORTRAIT_MARKETING_IMAGE', 21: 'LOGO' };
    const rows = await this._withTimeout(this.customer.query(`
      SELECT
        asset_group_asset.field_type,
        asset_group_asset.status
      FROM asset_group_asset
      WHERE asset_group.id = '${assetGroupId}'
        AND asset_group_asset.status != 'REMOVED'
    `), 'getAssetGroupAssetCounts');
    const counts = {};
    for (const r of rows) {
      const ft = FIELD_TYPE_NUM_TO_NAME[r.asset_group_asset.field_type] || String(r.asset_group_asset.field_type);
      counts[ft] = (counts[ft] || 0) + 1;
    }
    return counts;
  }

  /**
   * Add image assets to an existing PMAX asset group.
   * @param {string} assetGroupId
   * @param {Array<{base64: string, fieldType: string, name: string}>} images
   *   fieldType: 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'PORTRAIT_MARKETING_IMAGE' | 'LOGO'
   */
  async addAssetsToAssetGroup(assetGroupId, images = []) {
    this._ensureConfigured();
    if (images.length === 0) throw new Error('No images provided');

    // PMAX per-field-type limits
    const FIELD_LIMITS = {
      MARKETING_IMAGE: 20,
      SQUARE_MARKETING_IMAGE: 20,
      PORTRAIT_MARKETING_IMAGE: 20,
      LOGO: 5,
    };

    // Check existing counts before attempting mutation
    const currentCounts = await this.getAssetGroupAssetCounts(assetGroupId);
    logger.info('Current asset counts', { assetGroupId, currentCounts });

    // Count how many of each type we're trying to add
    const addCounts = {};
    for (const img of images) {
      addCounts[img.fieldType] = (addCounts[img.fieldType] || 0) + 1;
    }

    const violations = [];
    for (const [ft, addCount] of Object.entries(addCounts)) {
      const current = currentCounts[ft] || 0;
      const limit = FIELD_LIMITS[ft] ?? 20;
      if (current + addCount > limit) {
        violations.push(`${ft}: 현재 ${current}개, 추가 ${addCount}개 → 한도 ${limit}개 초과`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`에셋 한도 초과:\n${violations.join('\n')}`);
    }

    const assetGroupRn = `customers/${this.customerId}/assetGroups/${assetGroupId}`;
    const FIELD_TYPE_ENUM = {
      MARKETING_IMAGE: enums.AssetFieldType.MARKETING_IMAGE,
      SQUARE_MARKETING_IMAGE: enums.AssetFieldType.SQUARE_MARKETING_IMAGE,
      PORTRAIT_MARKETING_IMAGE: enums.AssetFieldType.PORTRAIT_MARKETING_IMAGE,
      LOGO: enums.AssetFieldType.LOGO,
    };

    const operations = [];
    const tempNames = [];

    images.forEach((img, i) => {
      const tempRn = `customers/${this.customerId}/assets/-${100 + i}`;
      tempNames.push({ tempRn, fieldType: img.fieldType });
      operations.push({
        entity: 'asset',
        operation: 'create',
        resource: {
          resource_name: tempRn,
          name: img.name || `asset_${Date.now()}_${i}`,
          type: enums.AssetType.IMAGE,
          image_asset: { data: Buffer.from(img.base64, 'base64') },
        },
      });
    });

    tempNames.forEach(({ tempRn, fieldType }) => {
      operations.push({
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: assetGroupRn,
          asset: tempRn,
          field_type: FIELD_TYPE_ENUM[fieldType] ?? FIELD_TYPE_ENUM.MARKETING_IMAGE,
        },
      });
    });

    const result = await this._withTimeout(
      this.customer.mutateResources(operations),
      'addAssetsToAssetGroup'
    );
    logger.info('Assets added to asset group', { assetGroupId, count: images.length });
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

  /** Individual asset performance grades via ad_group_ad_asset_view (RSA/RDA) */
  async getAssetGrades(campaignIds = []) {
    this._ensureConfigured();

    if (campaignIds.length === 0) {
      logger.warn('getAssetGrades: no campaignIds provided, skipping');
      return [];
    }

    const idList = campaignIds.map(id => `'${id}'`).join(', ');

    const rows = await this._withTimeout(this.customer.query(`
      SELECT
        ad_group_ad_asset_view.field_type,
        ad_group_ad_asset_view.performance_label,
        asset.id,
        asset.name,
        asset.image_asset.full_size.url,
        asset.youtube_video_asset.youtube_video_id,
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        ad_group_ad.ad.id
      FROM ad_group_ad_asset_view
      WHERE campaign.status = 'ENABLED'
        AND ad_group.status = 'ENABLED'
        AND ad_group_ad.status = 'ENABLED'
        AND ad_group_ad_asset_view.enabled = TRUE
        AND campaign.id IN (${idList})
        AND ad_group_ad_asset_view.field_type IN (
          'SQUARE_MARKETING_IMAGE',
          'PORTRAIT_MARKETING_IMAGE',
          'MARKETING_IMAGE',
          'YOUTUBE_VIDEO'
        )
    `), 'getAssetGrades');

    logger.info(`Fetched ${rows.length} Google asset grade rows (before dedup)`);

    // 같은 에셋이 여러 광고그룹에 쓰일 경우 (asset_id + field_type) 기준으로 중복 제거
    // 우선순위: BEST > GOOD > LEARNING > PENDING > LOW
    const LABEL_RANK = { BEST: 1, GOOD: 2, LEARNING: 3, PENDING: 4, LOW: 5 };
    const dedup = new Map();

    for (const row of rows) {
      const key = `${row.asset.id}_${row.ad_group_ad_asset_view.field_type}`;
      const label = row.ad_group_ad_asset_view.performance_label;
      const existing = dedup.get(key);
      if (!existing || (LABEL_RANK[label] || 9) < (LABEL_RANK[existing.performanceLabel] || 9)) {
        dedup.set(key, {
          assetId: String(row.asset.id),
          assetName: row.asset.name || '',
          assetText: null,
          imageUrl: row.asset.image_asset?.full_size?.url || null,
          youtubeId: row.asset.youtube_video_asset?.youtube_video_id || null,
          fieldType: row.ad_group_ad_asset_view.field_type,
          performanceLabel: label,
          campaignId: String(row.campaign.id),
          campaignName: row.campaign.name,
          adGroupId: String(row.ad_group.id),
          adGroupName: row.ad_group.name,
          adId: String(row.ad_group_ad.ad.id),
        });
      }
    }

    const result = [...dedup.values()];
    logger.info(`Google asset grades: ${rows.length} → ${result.length} after dedup`);
    return result;
  }

  /** PMAX asset group insights only (lighter than full getAdInsights) */
  async getPmaxAssetInsights({ dateFrom, dateTo } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = this._validateDate(dateFrom || today);
    const to = this._validateDate(dateTo || today);

    const rows = await this._withTimeout(this.customer.query(`
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
    `), 'getPmaxAssetInsights');

    return rows.map(row => {
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
  }

  /**
   * Per-asset performance for PMAX campaigns.
   * asset_group_asset resource does not expose raw metrics — instead we
   * Query asset_group_asset directly with metrics — per-asset impressions,
   * clicks, cost, conversions for PMAX campaigns.
   */
  async getPmaxAssetPerformance({ dateFrom, dateTo, campaignIds = [] } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = this._validateDate(dateFrom || today);
    const to = this._validateDate(dateTo || today);

    let conditions = [
      `segments.date BETWEEN '${from}' AND '${to}'`,
      `campaign.status = 'ENABLED'`,
      `asset_group.status = 'ENABLED'`,
      `asset_group_asset.status = 'ENABLED'`,
      `asset_group_asset.field_type IN ('SQUARE_MARKETING_IMAGE','PORTRAIT_MARKETING_IMAGE','MARKETING_IMAGE','YOUTUBE_VIDEO')`,
    ];
    if (campaignIds.length > 0) {
      const idList = campaignIds.map(id => `'${id}'`).join(', ');
      conditions.push(`campaign.id IN (${idList})`);
    }

    const rows = await this._withTimeout(
      this.customer.query(`
        SELECT
          asset.id,
          asset.name,
          asset.image_asset.full_size.url,
          asset.youtube_video_asset.youtube_video_id,
          asset_group_asset.field_type,
          asset_group_asset.source,
          asset_group.id,
          asset_group.name,
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM asset_group_asset
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY metrics.cost_micros DESC
      `),
      'getPmaxAssetPerformance'
    );

    logger.info(`PMAX asset_group_asset direct metrics: ${rows.length} rows`);

    return rows.map(row => {
      const impressions = Number(row.metrics.impressions || 0);
      const clicks = Number(row.metrics.clicks || 0);
      const spend = Number(row.metrics.cost_micros || 0) / 1_000_000;
      const conversions = Number(row.metrics.conversions || 0);
      const conversionValue = Number(row.metrics.conversions_value || 0);
      return {
        assetId: String(row.asset.id),
        assetName: row.asset.name || '',
        imageUrl: row.asset.image_asset?.full_size?.url || null,
        youtubeId: row.asset.youtube_video_asset?.youtube_video_id || null,
        fieldType: row.asset_group_asset.field_type,
        source: row.asset_group_asset.source || '',
        assetGroupId: String(row.asset_group.id),
        assetGroupName: row.asset_group.name || '',
        campaignId: String(row.campaign.id),
        campaignName: row.campaign.name || '',
        impressions,
        clicks,
        spend,
        conversions,
        conversionValue,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
        cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
        roas: spend > 0 ? conversionValue / spend : 0,
      };
    });
  }

  /** Quick today spend check */
  async getTodaySpend() {
    return this.getPerformance({ level: 'campaign' });
  }
}

export default GoogleAdsClient;
