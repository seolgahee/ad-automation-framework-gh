/**
 * Naver GFA (성과형 디스플레이 광고) API Client
 *
 * Docs: https://naver.github.io/naver-gfa-api/
 * Base: https://api.naver.com/gfa/v1
 */
import { BaseAdsClient } from '../utils/base-client.js';
import logger from '../utils/logger.js';

const BASE_URL = 'https://api.naver.com/gfa/v1';

export class NaverGfaClient extends BaseAdsClient {
  constructor() {
    super();
    this.customerId  = process.env.NAVER_GFA_CUSTOMER_ID;
    this.accessToken = process.env.NAVER_GFA_ACCESS_TOKEN;
    this.secretKey   = process.env.NAVER_GFA_SECRET_KEY;

    if (!this.customerId || !this.accessToken) {
      logger.warn('Naver GFA API credentials not configured');
      return;
    }

    this._configured = true;
    logger.info('Naver GFA client initialized', { customerId: this.customerId });
  }

  /** 공통 요청 헤더 */
  _headers() {
    return {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Naver-Client-Id': this.customerId,
      'Authorization': `Bearer ${this.accessToken}`,
    };
  }

  /** 공통 fetch 래퍼 */
  async _request(method, path, body = null) {
    const url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: this._headers(),
      signal: AbortSignal.timeout(this._timeoutMs),
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Naver GFA API ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * 캠페인 목록 조회
   * GET /campaigns
   */
  async getCampaigns() {
    this._ensureConfigured();
    const data = await this._withTimeout(
      this._request('GET', `/campaigns?customerId=${this.customerId}`),
      'getCampaigns'
    );
    const campaigns = data?.campaigns || data?.data || [];
    logger.info(`Fetched ${campaigns.length} Naver GFA campaigns`);
    return campaigns.map(c => ({
      id: String(c.campaignId || c.id),
      name: c.campaignName || c.name,
      status: c.campaignStatus || c.status,
      dailyBudget: c.dailyBudget || null,
    }));
  }

  /**
   * 캠페인별 성과 조회 (일별 집계)
   * GET /stats/campaigns
   * @param {string} dateFrom - YYYY-MM-DD
   * @param {string} dateTo   - YYYY-MM-DD
   */
  async getInsights({ dateFrom, dateTo } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = dateFrom || today;
    const to   = dateTo   || today;

    const data = await this._withTimeout(
      this._request('GET',
        `/stats/campaigns?customerId=${this.customerId}&startDate=${from}&endDate=${to}&timeUnit=DAY`
      ),
      'getInsights'
    );

    const rows = data?.data || data?.stats || [];
    logger.info(`Fetched ${rows.length} Naver GFA insight rows`);

    // 날짜별 집계
    const byDate = new Map();
    for (const r of rows) {
      const date = r.date || r.statDate || from;
      if (!byDate.has(date)) byDate.set(date, {
        impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0,
      });
      const d = byDate.get(date);
      d.impressions     += Number(r.impressions || r.imp || 0);
      d.clicks          += Number(r.clicks || r.click || 0);
      d.spend           += Number(r.cost || r.spend || 0);
      d.conversions     += Number(r.conversions || r.conv || 0);
      d.conversionValue += Number(r.conversionValue || r.convValue || 0);
    }

    return [...byDate.entries()].map(([date, d]) => ({
      dateStart: date,
      impressions: d.impressions,
      clicks: d.clicks,
      spend: d.spend,
      conversions: d.conversions,
      conversionValue: d.conversionValue,
      ctr:  d.impressions > 0 ? d.clicks / d.impressions : 0,
      cpc:  d.clicks > 0 ? d.spend / d.clicks : 0,
      roas: d.spend > 0 ? d.conversionValue / d.spend : 0,
    }));
  }

  /**
   * 광고 소재(Ad)별 성과 조회
   * GET /stats/ads
   */
  async getAdInsights({ dateFrom, dateTo } = {}) {
    this._ensureConfigured();
    const today = new Date().toISOString().split('T')[0];
    const from = dateFrom || today;
    const to   = dateTo   || today;

    const data = await this._withTimeout(
      this._request('GET',
        `/stats/ads?customerId=${this.customerId}&startDate=${from}&endDate=${to}`
      ),
      'getAdInsights'
    );

    const rows = data?.data || data?.stats || [];
    logger.info(`Fetched ${rows.length} Naver GFA ad-level rows`);

    return rows.map(r => ({
      adId:            String(r.adId || r.id),
      adName:          r.adName || r.name || '',
      adGroupId:       String(r.adGroupId || ''),
      adGroupName:     r.adGroupName || '',
      campaignId:      String(r.campaignId || ''),
      campaignName:    r.campaignName || '',
      impressions:     Number(r.impressions || r.imp || 0),
      clicks:          Number(r.clicks || r.click || 0),
      spend:           Number(r.cost || r.spend || 0),
      conversions:     Number(r.conversions || r.conv || 0),
      conversionValue: Number(r.conversionValue || r.convValue || 0),
      ctr:  Number(r.ctr  || 0),
      cpc:  Number(r.cpc  || 0),
      cpm:  Number(r.cpm  || 0),
      roas: Number(r.roas || 0),
      cpa:  Number(r.cpa  || 0),
    }));
  }
}

export default NaverGfaClient;
