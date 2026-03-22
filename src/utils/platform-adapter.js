/**
 * Platform Adapter — Unified interface for platform-specific operations
 *
 * Eliminates repeated `if (platform === 'meta') { ... } else { ... }` branches
 * across the codebase. Each adapter implements the same method signatures.
 *
 * Usage:
 *   import { getAdapter } from '../utils/platform-adapter.js';
 *   const adapter = getAdapter(campaign.platform);
 *   await adapter.updateBudget(campaign.platform_id, newBudget);
 */
import { getMetaClient, getGoogleClient, getTikTokClient } from './clients.js';

const adapters = {
  meta: {
    updateBudget: (platformId, newBudget) =>
      getMetaClient().updateCampaign(platformId, { dailyBudget: newBudget }),

    setStatus: (platformId, status) =>
      getMetaClient().updateCampaign(platformId, { status }),

    getCampaigns: (filter) =>
      getMetaClient().getCampaigns(filter),

    getPerformance: (opts) =>
      getMetaClient().getInsights(opts),

    /** Normalize status for internal storage */
    normalizeStatus: (status) => status,

    /** Reverse-normalize internal status for API calls */
    toApiStatus: (status) => status,
  },

  google: {
    updateBudget: (platformId, newBudget) =>
      getGoogleClient().updateBudget(platformId, newBudget),

    setStatus: (platformId, status) => {
      // Internal 'ACTIVE' → Google API 'ENABLED'
      const googleStatus = status === 'ACTIVE' ? 'ENABLED' : status;
      return getGoogleClient().setCampaignStatus(platformId, googleStatus);
    },

    getCampaigns: (filter) =>
      getGoogleClient().getCampaigns(filter),

    getPerformance: (opts) =>
      getGoogleClient().getPerformance(opts),

    /** Normalize Google's ENABLED → internal ACTIVE */
    normalizeStatus: (status) => status === 'ENABLED' ? 'ACTIVE' : status,

    /** Reverse-normalize internal status for API */
    toApiStatus: (status) => status === 'ACTIVE' ? 'ENABLED' : status,
  },

  tiktok: {
    updateBudget: (platformId, newBudget) =>
      getTikTokClient().updateBudget(platformId, newBudget),

    setStatus: (platformId, status) => {
      const ttStatus = status === 'ACTIVE' ? 'CAMPAIGN_STATUS_ENABLE'
        : status === 'PAUSED' ? 'CAMPAIGN_STATUS_DISABLE' : status;
      return getTikTokClient().setCampaignStatus(platformId, ttStatus);
    },

    getCampaigns: (filter) =>
      getTikTokClient().getCampaigns(filter),

    getPerformance: (opts) =>
      getTikTokClient().getPerformance(opts),

    /** Normalize TikTok status → internal */
    normalizeStatus: (status) => {
      if (status === 'CAMPAIGN_STATUS_ENABLE') return 'ACTIVE';
      if (status === 'CAMPAIGN_STATUS_DISABLE') return 'PAUSED';
      return status;
    },

    /** Reverse-normalize internal → TikTok API */
    toApiStatus: (status) => {
      if (status === 'ACTIVE') return 'CAMPAIGN_STATUS_ENABLE';
      if (status === 'PAUSED') return 'CAMPAIGN_STATUS_DISABLE';
      return status;
    },
  },
};

/**
 * Get platform adapter by name
 * @param {'meta'|'google'|'tiktok'} platform
 * @returns {typeof adapters.meta}
 */
export function getAdapter(platform) {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`Unknown platform: "${platform}"`);
  return adapter;
}

export default getAdapter;
