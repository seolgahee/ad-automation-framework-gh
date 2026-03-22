/**
 * Base class for platform API clients
 *
 * Provides shared guard pattern and reduces duplication
 * between MetaAdsClient and GoogleAdsClient.
 */

export class BaseAdsClient {
  constructor() {
    this._configured = false;
    this._timeoutMs = 30000; // 30s default timeout for all API calls
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

  /**
   * Wrap a promise with a timeout to prevent indefinite hangs.
   * @param {Promise} promise - The API call promise
   * @param {string} label - Description for timeout error message
   * @returns {Promise}
   */
  _withTimeout(promise, label = 'API call') {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${this.constructor.name} timeout after ${this._timeoutMs}ms: ${label}`)), this._timeoutMs)
      ),
    ]);
  }
}

export default BaseAdsClient;
