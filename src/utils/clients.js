/**
 * Singleton API Client Registry
 *
 * Prevents redundant client instantiation across modules.
 * Each client is created once and shared.
 */
import MetaAdsClient from '../meta/client.js';
import GoogleAdsClient from '../google/client.js';
import TikTokAdsClient from '../tiktok/client.js';
// import NaverGfaClient from '../naver/client.js'; // 파일 없음 - 임시 비활성화
import snowflakeClient from '../snowflake/client.js';

let _metaClient = null;
let _googleClient = null;
let _tiktokClient = null;
let _naverClient = null;

/** Get or create the singleton Meta Ads client */
export function getMetaClient() {
  if (!_metaClient) _metaClient = new MetaAdsClient();
  return _metaClient;
}

/** Get or create the singleton Google Ads client */
export function getGoogleClient() {
  if (!_googleClient) _googleClient = new GoogleAdsClient();
  return _googleClient;
}

/** Get or create the singleton TikTok Ads client */
export function getTikTokClient() {
  if (!_tiktokClient) _tiktokClient = new TikTokAdsClient();
  return _tiktokClient;
}

/** Get or create the singleton Naver GFA client */
export function getNaverClient() {
  // if (!_naverClient) _naverClient = new NaverGfaClient(); // 파일 없음 - 임시 비활성화
  return _naverClient;
}

/** Snowflake 재고 조회 (fetchStockInfo 직접 export) */
export const { fetchStockInfo } = snowflakeClient;

/** Reset clients (useful for testing or credential rotation) */
export function resetClients() {
  _metaClient = null;
  _googleClient = null;
  _tiktokClient = null;
  _naverClient = null;
}
