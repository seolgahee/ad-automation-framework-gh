/**
 * A/B Test Engine
 *
 * Automatically generates creative variants by combining:
 * - Multiple headlines
 * - Multiple images
 * - Multiple CTAs
 * - Multiple body texts
 *
 * Then registers all variants as a test group, monitors performance,
 * and auto-pauses losers / scales winners.
 */
import crypto from 'crypto';
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import notifier from '../utils/notifier.js';
import CreativePipeline from './creative-pipeline.js';
import { twoProportionZTest, wilsonInterval, minSampleSize } from '../utils/statistics.js';

export class ABTestEngine {
  /**
   * @param {CreativePipeline} [pipeline] - Injected singleton. Falls back to new instance.
   */
  constructor(pipeline) {
    this.pipeline = pipeline || new CreativePipeline();
    this._initTestTable();
  }

  _initTestTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        platform         TEXT NOT NULL,
        campaign_id      TEXT,
        ad_set_id        TEXT,
        status           TEXT DEFAULT 'SETUP',  -- SETUP, RUNNING, COMPLETED, CANCELLED
        test_type        TEXT DEFAULT 'creative', -- creative, audience, bidding
        variants_json    TEXT,
        winner_id        TEXT,
        confidence       REAL,
        min_impressions  INTEGER DEFAULT 1000,
        min_duration_hrs INTEGER DEFAULT 48,
        auto_optimize    INTEGER DEFAULT 1,
        started_at       TEXT,
        completed_at     TEXT,
        created_at       TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // ═══════════════════════════════════════════════════════════
  //  Variant Generation
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate creative variants from combinations
   *
   * @param {object} config
   * @param {string} config.templateId - Base template
   * @param {object} config.baseVariables - Common variables
   * @param {object} config.variations - { fieldName: [value1, value2, ...] }
   * @param {string} config.platform - 'meta', 'google', or 'tiktok'
   * @param {string[]} [config.mediaPaths] - Multiple image paths to test
   * @param {string} config.landingUrl
   *
   * @example
   * generateVariants({
   *   templateId: 'meta-sale',
   *   baseVariables: { product: '운동화', season: '봄' },
   *   variations: {
   *     discount: ['20', '30', '40'],
   *     benefit: ['무료 배송', '사은품 증정'],
   *   },
   *   platform: 'meta',
   *   landingUrl: 'https://example.com/shoes',
   * })
   * // → 6 variants (3 discounts × 2 benefits)
   */
  async generateVariants({ templateId, baseVariables, variations, platform, mediaPaths, landingUrl }) {
    // Compute cartesian product of all variations
    const keys = Object.keys(variations);
    const combos = this._cartesianProduct(keys.map(k => variations[k]));

    const variants = [];

    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      const variables = { ...baseVariables };
      keys.forEach((key, idx) => { variables[key] = combo[idx]; });

      // If multiple images, cycle through them
      const mediaPath = mediaPaths ? mediaPaths[i % mediaPaths.length] : null;

      const abGroup = `variant_${String.fromCharCode(65 + i)}`; // A, B, C, ...

      const result = await this.pipeline.assembleCreative({
        templateId,
        variables,
        platform,
        mediaPath,
        landingUrl,
        abGroup,
      });

      variants.push({
        creativeId: result.creativeId,
        label: abGroup,
        variables,
        mediaPath,
        copy: result.copy,
      });
    }

    logger.info(`Generated ${variants.length} A/B variants`, { templateId, platform });
    return variants;
  }

  /**
   * Create an A/B test and register all variants
   */
  async createTest({
    name, platform, templateId, baseVariables, variations,
    campaignId, adSetId, mediaPaths, landingUrl, pageId,
    minImpressions = 1000, minDurationHrs = 48, autoOptimize = true,
  }) {
    // Generate variants
    const variants = await this.generateVariants({
      templateId, baseVariables, variations, platform, mediaPaths, landingUrl,
    });

    // Register each variant to the platform via registration map
    const registrationMap = {
      meta: (cId) => this.pipeline.registerToMeta({ creativeId: cId, campaignId, adSetId, pageId }),
      google: (cId) => this.pipeline.registerToGoogle({ creativeId: cId, campaignId, adGroupId: adSetId }),
      tiktok: (cId) => this.pipeline.registerToTikTok({ creativeId: cId, campaignId, adGroupId: adSetId }),
    };
    const registerFn = registrationMap[platform];
    if (!registerFn) throw new Error(`Unsupported platform for A/B registration: "${platform}"`);

    const registered = [];
    for (const v of variants) {
      try {
        const reg = await registerFn(v.creativeId);
        registered.push({ ...v, registration: reg });
      } catch (err) {
        logger.error(`Failed to register variant ${v.label}`, { error: err.message });
        registered.push({ ...v, error: err.message });
      }
    }

    // Save test to DB
    const testId = `ab_${crypto.randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO ab_tests (id, name, platform, campaign_id, ad_set_id, status,
        variants_json, min_impressions, min_duration_hrs, auto_optimize, started_at)
      VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, datetime('now'))
    `).run(testId, name, platform, campaignId, adSetId,
      JSON.stringify(registered), minImpressions, minDurationHrs, autoOptimize ? 1 : 0);

    await notifier.broadcast(
      `A/B 테스트 시작: "${name}" — ${registered.length}개 변형 등록`,
      { severity: 'info', data: { Test: name, Variants: registered.length, Platform: platform } }
    );

    logger.info('A/B test created', { testId, name, variants: registered.length });
    return { testId, name, variants: registered };
  }

  // ═══════════════════════════════════════════════════════════
  //  Performance Evaluation
  // ═══════════════════════════════════════════════════════════

  /**
   * Evaluate a running A/B test with statistical significance
   *
   * Uses two-proportion Z-test for CVR comparison between variants.
   * Only declares a winner when p < 0.05 (95% confidence).
   */
  async evaluateTest(testId) {
    const test = db.prepare(`SELECT * FROM ab_tests WHERE id = ?`).get(testId);
    if (!test || test.status !== 'RUNNING') return null;

    const variants = JSON.parse(test.variants_json);

    // Fetch performance for each variant
    const results = variants.map(v => {
      const perf = db.prepare(`
        SELECT
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(conversions) as conversions,
          SUM(spend) as spend
        FROM creative_performance
        WHERE creative_id = ?
      `).get(v.creativeId);

      const impressions = perf?.impressions || 0;
      const clicks = perf?.clicks || 0;
      const conversions = perf?.conversions || 0;
      const spend = perf?.spend || 0;
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const cvr = clicks > 0 ? (conversions / clicks) * 100 : 0;

      // Wilson confidence intervals for CVR and CTR
      const cvrCI = wilsonInterval(conversions, clicks);
      const ctrCI = wilsonInterval(clicks, impressions);

      return {
        ...v,
        impressions, clicks, conversions, spend, ctr, cvr,
        cpa: conversions > 0 ? spend / conversions : Infinity,
        cvrCI, ctrCI,
      };
    });

    // Check data thresholds
    const totalImpressions = results.reduce((s, r) => s + r.impressions, 0);
    const hoursElapsed = (Date.now() - new Date(test.started_at).getTime()) / (1000 * 60 * 60);
    const meetsMinData = totalImpressions >= test.min_impressions
      && hoursElapsed >= test.min_duration_hrs;

    // Pairwise statistical tests: compare each variant against the best control (variant A)
    const ranked = [...results].sort((a, b) => {
      if (b.cvr !== a.cvr) return b.cvr - a.cvr;
      return b.ctr - a.ctr;
    });

    const control = ranked[ranked.length - 1]; // worst performer as baseline
    const significanceTests = ranked.map(v => {
      if (v.creativeId === control.creativeId) {
        return { ...v, vsControl: null };
      }
      const cvrTest = twoProportionZTest(
        control.conversions, control.clicks,
        v.conversions, v.clicks
      );
      const ctrTest = twoProportionZTest(
        control.clicks, control.impressions,
        v.clicks, v.impressions
      );
      return { ...v, vsControl: { cvr: cvrTest, ctr: ctrTest } };
    });

    // Winner must both be top-ranked AND statistically significant
    const topVariant = significanceTests[0];
    const isSignificant = topVariant.vsControl?.cvr?.significant === true;
    const readyToDecide = meetsMinData && isSignificant;

    // Estimate remaining sample needed if not yet significant
    let estimatedSampleNeeded = null;
    if (!isSignificant && results.length >= 2) {
      const baseRate = control.clicks > 0 ? control.conversions / control.clicks : 0.01;
      estimatedSampleNeeded = minSampleSize(baseRate || 0.01, 0.1);
    }

    const evaluation = {
      testId,
      name: test.name,
      status: readyToDecide ? 'significant_winner' : meetsMinData ? 'not_significant' : 'collecting_data',
      totalImpressions,
      hoursElapsed: parseFloat(hoursElapsed.toFixed(1)),
      variants: significanceTests,
      winner: readyToDecide ? topVariant : null,
      losers: readyToDecide ? significanceTests.slice(1) : [],
      pValue: topVariant.vsControl?.cvr?.pValue ?? null,
      confidenceLevel: topVariant.vsControl?.cvr?.confidenceLevel ?? 0,
      estimatedSampleNeeded,
    };

    // Auto-optimize only if statistically significant
    if (readyToDecide && test.auto_optimize) {
      await this._autoOptimize(test, significanceTests);
    }

    return evaluation;
  }

  async _autoOptimize(test, ranked) {
    const winner = ranked[0];
    const pValue = winner.vsControl?.cvr?.pValue ?? 'N/A';
    const confidence = winner.vsControl?.cvr?.confidenceLevel ?? 0;

    // Update test status with confidence score
    db.prepare(`
      UPDATE ab_tests SET status = 'COMPLETED', winner_id = ?, confidence = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(winner.creativeId, confidence, test.id);

    // Pause losers (set creative status to PAUSED)
    for (const loser of ranked.slice(1)) {
      db.prepare(`UPDATE creatives SET status = 'PAUSED' WHERE id = ?`).run(loser.creativeId);
    }

    await notifier.broadcast(
      `A/B 테스트 완료: "${test.name}"\n` +
      `승자: ${winner.label} (CVR ${winner.cvr.toFixed(2)}%, CTR ${winner.ctr.toFixed(2)}%)\n` +
      `통계적 유의성: p=${pValue} (${confidence}% 신뢰도)\n` +
      `패자 ${ranked.length - 1}개 자동 중지됨`,
      { severity: 'info' }
    );

    logger.info('A/B test auto-optimized', { testId: test.id, winner: winner.label, pValue, confidence });
  }

  // ═══════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════

  _cartesianProduct(arrays) {
    return arrays.reduce((acc, curr) =>
      acc.flatMap(a => curr.map(c => [...a, c])), [[]]);
  }

  getTests(status) {
    if (status) {
      return db.prepare(`SELECT * FROM ab_tests WHERE status = ? ORDER BY created_at DESC`).all(status);
    }
    return db.prepare(`SELECT * FROM ab_tests ORDER BY created_at DESC`).all();
  }

  getTestById(id) {
    return db.prepare(`SELECT * FROM ab_tests WHERE id = ?`).get(id);
  }
}

export default ABTestEngine;
