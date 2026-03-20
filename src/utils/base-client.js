/**
 * Base class for platform API clients
 *
 * Provides shared guard pattern and reduces duplication
 * between MetaAdsClient and GoogleAdsClient.
 */

export class BaseAdsClient {
  constructor() {
    this._configured = false;
  }

  /**
   * Guard: throws if client is not configured (missing env vars).
   * Subclasses set `this._configured = true` after successful init.
   */
  _ensureConfigured() {
    if (!this._configured) {
      throw new Error(`${this.constructor.name} not configured — check required environment variables`);
    }
  }
}

export default BaseAdsClient;
