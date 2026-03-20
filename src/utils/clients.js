/**
 * Singleton API Client Registry
 *
 * Prevents redundant client instantiation across modules.
 * Each client is created once and shared.
 */
import MetaAdsClient from '../meta/client.js';
import GoogleAdsClient from '../google/client.js';
import TikTokAdsClient from '../tiktok/client.js';

let _metaClient = null;
let _googleClient = null;
let _tiktokClient = null;

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

/** Reset clients (useful for testing or credential rotation) */
export function resetClients() {
  _metaClient = null;
  _googleClient = null;
  _tiktokClient = null;
}
