/**
 * Test Setup — Mocks for external dependencies
 *
 * Intercepts all platform API clients (Meta/Google/TikTok) and
 * infrastructure modules (logger, notifier, cron) to isolate
 * integration tests from real API calls.
 */
import { vi } from 'vitest';

// ─── Mock: better-sqlite3 (real in-memory DB) ───────────────────
// We use the real SQLite engine with :memory: for true integration testing

// ─── Mock: Platform API Clients ─────────────────────────────────
const mockMetaCampaigns = [
  { id: 'mc_1', name: 'Meta Spring Sale', status: 'ACTIVE', daily_budget: 5000000 },
  { id: 'mc_2', name: 'Meta Brand Awareness', status: 'PAUSED', daily_budget: 3000000 },
];

const mockGoogleCampaigns = [
  { id: 'gc_1', name: 'Google Search Ads', status: 'ENABLED', dailyBudget: 40000 },
  { id: 'gc_2', name: 'Google Display', status: 'PAUSED', dailyBudget: 25000 },
];

const mockTikTokCampaigns = [
  { id: 'tc_1', name: 'TikTok Video Ads', status: 'CAMPAIGN_STATUS_ENABLE', dailyBudget: 30000 },
];

const mockPerfData = (platform) => [
  {
    campaignId: `${platform === 'meta' ? 'mc' : platform === 'google' ? 'gc' : 'tc'}_1`,
    impressions: 15000, clicks: 450, spend: 25000,
    conversions: 12, conversionValue: 120000,
    ctr: 3.0, cpc: 55.6, cpm: 1666.7,
  },
];

export const mockMeta = {
  getCampaigns: vi.fn().mockResolvedValue(mockMetaCampaigns),
  getInsights: vi.fn().mockResolvedValue(mockPerfData('meta')),
  updateCampaign: vi.fn().mockResolvedValue({ success: true }),
  createCreative: vi.fn().mockResolvedValue({ id: 'meta_cr_1' }),
  uploadImage: vi.fn().mockResolvedValue({ imageHash: 'abc123' }),
};

export const mockGoogle = {
  getCampaigns: vi.fn().mockResolvedValue(mockGoogleCampaigns),
  getPerformance: vi.fn().mockResolvedValue(mockPerfData('google')),
  updateBudget: vi.fn().mockResolvedValue({ success: true }),
  setCampaignStatus: vi.fn().mockResolvedValue({ success: true }),
  createAd: vi.fn().mockResolvedValue({ resourceName: 'customers/123/ads/456' }),
  uploadAsset: vi.fn().mockResolvedValue({ resourceName: 'customers/123/assets/789' }),
};

export const mockTikTok = {
  getCampaigns: vi.fn().mockResolvedValue(mockTikTokCampaigns),
  getPerformance: vi.fn().mockResolvedValue(mockPerfData('tiktok')),
  updateBudget: vi.fn().mockResolvedValue({ success: true }),
  setCampaignStatus: vi.fn().mockResolvedValue({ success: true }),
  createAd: vi.fn().mockResolvedValue({ adId: 'tt_ad_1' }),
  uploadVideo: vi.fn().mockResolvedValue({ videoId: 'tt_vid_1' }),
};

// ─── Mock: node-cron ─────────────────────────────────────────────
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn(),
}));

// ─── Mock: logger (silence test output) ──────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock: notifier (prevent real Slack/Telegram calls) ──────────
vi.mock('../src/utils/notifier.js', () => ({
  default: {
    broadcast: vi.fn().mockResolvedValue(undefined),
    sendSlack: vi.fn().mockResolvedValue(undefined),
    sendTelegram: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Mock: facebook-nodejs-business-sdk ──────────────────────────
vi.mock('facebook-nodejs-business-sdk', () => ({
  default: {
    AdSet: class MockAdSet {},
    Campaign: class MockCampaign {},
    AdCreative: class MockAdCreative {},
    AdImage: class MockAdImage {},
  },
  AdSet: class MockAdSet {},
}));

// ─── Mock: google-ads-api ────────────────────────────────────────
vi.mock('google-ads-api', () => ({
  GoogleAdsApi: class MockGoogleAdsApi {
    constructor() {}
    Customer() { return {}; }
  },
}));

// ─── Export mock data for test assertions ─────────────────────────
export const testData = {
  metaCampaigns: mockMetaCampaigns,
  googleCampaigns: mockGoogleCampaigns,
  tiktokCampaigns: mockTikTokCampaigns,
  mockPerfData,
};
