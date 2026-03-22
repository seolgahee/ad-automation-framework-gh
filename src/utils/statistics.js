/**
 * Statistical Testing Utilities for A/B Test Significance
 *
 * Implements:
 * - Two-proportion Z-test for CVR/CTR comparison
 * - Confidence interval calculation
 * - Minimum sample size estimation (power analysis)
 *
 * No external dependencies — pure math implementation.
 */

/**
 * Standard normal CDF (cumulative distribution function)
 * Using Abramowitz & Stegun approximation (error < 7.5e-8)
 */
export function normalCDF(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Two-proportion Z-test
 *
 * Tests whether two conversion rates are significantly different.
 *
 * @param {number} conversionsA - Successes in group A
 * @param {number} trialsA     - Total trials in group A
 * @param {number} conversionsB - Successes in group B
 * @param {number} trialsB     - Total trials in group B
 * @returns {{ zScore, pValue, significant, rateA, rateB, lift, confidenceLevel }}
 */
export function twoProportionZTest(conversionsA, trialsA, conversionsB, trialsB) {
  if (trialsA <= 0 || trialsB <= 0) {
    return { zScore: 0, pValue: 1, significant: false, rateA: 0, rateB: 0, lift: 0, confidenceLevel: 0 };
  }

  const rateA = conversionsA / trialsA;
  const rateB = conversionsB / trialsB;

  // Pooled proportion under null hypothesis (p_A = p_B)
  const pooled = (conversionsA + conversionsB) / (trialsA + trialsB);

  // Standard error of the difference
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));

  if (se === 0) {
    return { zScore: 0, pValue: 1, significant: false, rateA, rateB, lift: 0, confidenceLevel: 0 };
  }

  const zScore = (rateB - rateA) / se;

  // Two-tailed p-value
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  // Determine confidence level
  let confidenceLevel = 0;
  if (pValue < 0.001) confidenceLevel = 99.9;
  else if (pValue < 0.01) confidenceLevel = 99;
  else if (pValue < 0.05) confidenceLevel = 95;
  else if (pValue < 0.1) confidenceLevel = 90;

  const lift = rateA > 0 ? ((rateB - rateA) / rateA) * 100 : 0;

  return {
    zScore: parseFloat(zScore.toFixed(4)),
    pValue: parseFloat(pValue.toFixed(6)),
    significant: pValue < 0.05,
    rateA: parseFloat(rateA.toFixed(6)),
    rateB: parseFloat(rateB.toFixed(6)),
    lift: parseFloat(lift.toFixed(2)),
    confidenceLevel,
  };
}

/**
 * Wilson score confidence interval for a proportion
 *
 * More robust than normal approximation, especially for small samples.
 *
 * @param {number} successes
 * @param {number} trials
 * @param {number} [zAlpha=1.96] - z-value for desired confidence (1.96 = 95%)
 * @returns {{ lower, upper, center }}
 */
export function wilsonInterval(successes, trials, zAlpha = 1.96) {
  if (trials <= 0) return { lower: 0, upper: 0, center: 0 };

  const p = successes / trials;
  const z2 = zAlpha * zAlpha;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (zAlpha * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denominator;

  return {
    lower: parseFloat(Math.max(0, center - margin).toFixed(6)),
    upper: parseFloat(Math.min(1, center + margin).toFixed(6)),
    center: parseFloat(center.toFixed(6)),
  };
}

/**
 * Minimum sample size per variant for detecting a given effect
 *
 * Based on standard power analysis for two-proportion test.
 *
 * @param {number} baselineRate - Expected conversion rate of control (e.g., 0.03 for 3%)
 * @param {number} minDetectableEffect - Minimum relative lift to detect (e.g., 0.1 for 10%)
 * @param {number} [power=0.8]  - Statistical power (1 - beta)
 * @param {number} [alpha=0.05] - Significance level
 * @returns {number} Required sample size per variant
 */
export function minSampleSize(baselineRate, minDetectableEffect, power = 0.8, alpha = 0.05) {
  if (minDetectableEffect <= 0) throw new Error('minDetectableEffect must be > 0');
  if (baselineRate <= 0 || baselineRate >= 1) throw new Error('baselineRate must be between 0 and 1 (exclusive)');

  const zAlpha = zFromP(alpha / 2);
  const zBeta = zFromP(1 - power);

  const p1 = baselineRate;
  const p2 = baselineRate * (1 + minDetectableEffect);
  const pBar = (p1 + p2) / 2;

  const numerator = (zAlpha * Math.sqrt(2 * pBar * (1 - pBar))
    + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  const denominator = (p2 - p1) ** 2;

  return Math.ceil(numerator / denominator);
}

/** Inverse normal CDF (approximation via Beasley-Springer-Moro) */
function zFromP(p) {
  // For common values, use lookup
  if (Math.abs(p - 0.975) < 0.001) return 1.96;
  if (Math.abs(p - 0.995) < 0.001) return 2.576;
  if (Math.abs(p - 0.95) < 0.001) return 1.645;
  if (Math.abs(p - 0.8) < 0.001) return 0.8416;

  // Rational approximation for 0 < p < 1
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}
