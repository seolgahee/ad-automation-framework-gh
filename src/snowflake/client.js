/**
 * Snowflake Inventory Client
 *
 * 재고 데이터 조회 모듈 (Discovery 브랜드 기준)
 * Tables: DW_SCS_DACUM (재고), DB_PRDT (상품명/최초출고일), DW_SH_SCS_D (판매)
 * 인증: RSA 키페어 (SNOWFLAKE_JWT) — 서비스 계정 SVC_ORG_PF
 */
import snowflake from 'snowflake-sdk';
import fs from 'fs';
import logger from '../utils/logger.js';

const ACCOUNT          = process.env.SNOWFLAKE_ACCOUNT;
const USER             = process.env.SNOWFLAKE_USER;
const PRIVATE_KEY_PATH = process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
const DATABASE         = process.env.SNOWFLAKE_DATABASE;
const WAREHOUSE        = process.env.SNOWFLAKE_WAREHOUSE;
const ROLE             = process.env.SNOWFLAKE_ROLE;
const SCHEMA           = process.env.SNOWFLAKE_STOCK_SCHEMA || 'PRCS';
const BRAND_CD         = process.env.STOCK_BRAND_CD         || 'X';
const SHOP_ID          = process.env.JASAMOL_SHOP_ID        || '30001';

const SIZE_ORDER = { XS: 0, S: 1, M: 2, L: 3, XL: 4, XXL: 5, XXXL: 6 };

function loadPrivateKey() {
  if (!PRIVATE_KEY_PATH) throw new Error('SNOWFLAKE_PRIVATE_KEY_PATH not set');
  return fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
}

function createConnection() {
  return snowflake.createConnection({
    account:          ACCOUNT,
    username:         USER,
    authenticator:    'SNOWFLAKE_JWT',
    privateKey:       loadPrivateKey(),
    database:         DATABASE,
    warehouse:        WAREHOUSE,
    role:             ROLE,
  });
}

function connectAsync(conn) {
  return new Promise((resolve, reject) => {
    conn.connect((err, c) => (err ? reject(err) : resolve(c)));
  });
}

function executeAsync(conn, sql, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText:  sql,
      binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroyAsync(conn) {
  return new Promise((resolve) => conn.destroy(resolve));
}

/**
 * 재고 조회
 * @param {string} partCd   - 품번 (예: "TWSK16063")
 * @param {string|null} colorCd - 컬러 코드 (없으면 컬러별 합산 반환)
 * @param {object} [options]
 * @param {string} [options.saleStart] - 판매 집계 시작일 (yyyy-mm-dd, 포함). 없으면 최근 7일.
 * @param {string} [options.saleEnd]   - 판매 집계 종료일 (yyyy-mm-dd, 포함). 없으면 어제.
 * @returns {object|null}
 *   colorCd 있을 때: { prdt_nm, is_mc, sizes: [{size, wh, total}], sale_7d, daily_avg, days_of_supply }
 *   colorCd 없을 때: { prdt_nm, is_mc, colors: [{color, wh, total}], sale_7d, daily_avg, days_of_supply }
 *   재고는 항상 최신(MAX(START_DT)) 기준. 판매·일평균은 옵션 기간 또는 최근 7일 기준.
 */
export async function fetchStockInfo(partCd, colorCd = null, options = {}) {
  const { saleStart, saleEnd } = options;
  const useRange = !!(saleStart && saleEnd);
  const conn = createConnection();

  try {
    await connectAsync(conn);

    const latestDtSub = `
      SELECT MAX(START_DT)
      FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM
      WHERE BRD_CD = ? AND PART_CD = ?
    `;

    let stockRows;
    if (colorCd) {
      stockRows = await executeAsync(conn, `
        SELECT d.SIZE_CD,
               SUM(d.WH_STOCK_QTY) AS WH_STOCK,
               SUM(d.STOCK_QTY)    AS TOTAL_STOCK,
               MAX(p.PRDT_NM)      AS PRDT_NM,
               MIN(p.DELV_DT_1ST)  AS DELV_DT_1ST
        FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM d
        LEFT JOIN ${DATABASE}.${SCHEMA}.DB_PRDT p ON d.PRDT_CD = p.PRDT_CD
        WHERE d.BRD_CD = ? AND d.PART_CD = ? AND d.COLOR_CD = ?
          AND d.START_DT = (${latestDtSub})
        GROUP BY d.SIZE_CD
      `, [BRAND_CD, partCd, colorCd, BRAND_CD, partCd]);
    } else {
      stockRows = await executeAsync(conn, `
        SELECT d.COLOR_CD,
               SUM(d.WH_STOCK_QTY) AS WH_STOCK,
               SUM(d.STOCK_QTY)    AS TOTAL_STOCK,
               MAX(p.PRDT_NM)      AS PRDT_NM,
               MIN(p.DELV_DT_1ST)  AS DELV_DT_1ST
        FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM d
        LEFT JOIN ${DATABASE}.${SCHEMA}.DB_PRDT p ON d.PRDT_CD = p.PRDT_CD
        WHERE d.BRD_CD = ? AND d.PART_CD = ?
          AND d.START_DT = (${latestDtSub})
        GROUP BY d.COLOR_CD
        ORDER BY WH_STOCK DESC
      `, [BRAND_CD, partCd, BRAND_CD, partCd]);
    }

    // 자사몰 판매량 — 기간 옵션 있으면 해당 기간, 없으면 최근 7일
    const colorFilter = colorCd ? 'AND COLOR_CD = ?' : '';
    const dateClause  = useRange ? 'AND DT >= ? AND DT <= ?' : 'AND DT >= CURRENT_DATE - 7 AND DT <  CURRENT_DATE';
    const saleParams  = [BRAND_CD, SHOP_ID, partCd];
    if (colorCd) saleParams.push(colorCd);
    if (useRange) saleParams.push(saleStart, saleEnd);

    const saleRows = await executeAsync(conn, `
      SELECT SUM(SALE_NML_QTY - SALE_RET_QTY) AS SALE_QTY
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_D
      WHERE BRD_CD = ?
        AND SHOP_ID = ?
        AND PART_CD = ?
        ${colorFilter}
        ${dateClause}
    `, saleParams);

    const periodDays = useRange
      ? Math.max(1, Math.round((Date.parse(saleEnd) - Date.parse(saleStart)) / 86400000) + 1)
      : 7;
    const sale7d   = parseInt(saleRows?.[0]?.SALE_QTY || 0, 10);
    const dailyAvg = Math.round((sale7d / periodDays) * 10) / 10;

    if (!stockRows || stockRows.length === 0) return null;

    const prdtNm = stockRows.find(r => r.PRDT_NM)?.PRDT_NM || '';
    const isMc   = prdtNm.toUpperCase().split(' ').includes('MC');
    const delvDt1st = stockRows.find(r => r.DELV_DT_1ST)?.DELV_DT_1ST || null;

    let totalWh;
    let result;

    if (colorCd) {
      const sizes = stockRows
        .map(r => ({ size: r.SIZE_CD, wh: parseInt(r.WH_STOCK || 0, 10), total: parseInt(r.TOTAL_STOCK || 0, 10) }))
        .sort((a, b) => (SIZE_ORDER[a.size] ?? 99) - (SIZE_ORDER[b.size] ?? 99));
      totalWh = sizes.reduce((s, x) => s + x.wh, 0);
      result  = { sizes };
    } else {
      const colors = stockRows.map(r => ({ color: r.COLOR_CD, wh: parseInt(r.WH_STOCK || 0, 10), total: parseInt(r.TOTAL_STOCK || 0, 10) }));
      totalWh = colors.reduce((s, x) => s + x.wh, 0);
      result  = { colors };
    }

    const daysOfSupply = dailyAvg > 0 ? Math.round(totalWh / dailyAvg) : null;

    return { prdt_nm: prdtNm, is_mc: isMc, delv_dt_1st: delvDt1st, sale_7d: sale7d, daily_avg: dailyAvg, days_of_supply: daysOfSupply, ...result };

  } catch (err) {
    logger.warn(`재고 조회 실패 (${partCd}-${colorCd}): ${err.message}`);
    return null;
  } finally {
    await destroyAsync(conn);
  }
}

/**
 * 재고 일괄 조회 — 품번 여러 개를 단일 연결 + 2개 쿼리로 처리
 * @param {string[]} partCds - 품번 배열
 * @param {object} [options]
 * @param {string} [options.saleStart] - 판매 집계 시작일 (yyyy-mm-dd)
 * @param {string} [options.saleEnd]   - 판매 집계 종료일 (yyyy-mm-dd)
 * @returns {Promise<Map<string, object>>} part_cd → fetchStockInfo no-color 형태 결과
 *   재고가 없는 품번은 Map에 포함되지 않음.
 */
export async function fetchStockInfoBatch(partCds, options = {}) {
  if (!Array.isArray(partCds) || partCds.length === 0) return new Map();
  const { saleStart, saleEnd } = options;
  const useRange = !!(saleStart && saleEnd);
  const placeholders = partCds.map(() => '?').join(',');
  const conn = createConnection();

  try {
    await connectAsync(conn);

    // 재고 — 품번별 최신 스냅샷 × 컬러별 합산 (한 번에)
    const stockRows = await executeAsync(conn, `
      WITH latest AS (
        SELECT PART_CD, MAX(START_DT) AS MAX_DT
        FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM
        WHERE BRD_CD = ? AND PART_CD IN (${placeholders})
        GROUP BY PART_CD
      )
      SELECT d.PART_CD, d.COLOR_CD,
             SUM(d.WH_STOCK_QTY) AS WH_STOCK,
             SUM(d.STOCK_QTY)    AS TOTAL_STOCK,
             MAX(p.PRDT_NM)      AS PRDT_NM,
             MIN(p.DELV_DT_1ST)  AS DELV_DT_1ST
      FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM d
      JOIN latest l ON d.PART_CD = l.PART_CD AND d.START_DT = l.MAX_DT
      LEFT JOIN ${DATABASE}.${SCHEMA}.DB_PRDT p ON d.PRDT_CD = p.PRDT_CD
      WHERE d.BRD_CD = ? AND d.PART_CD IN (${placeholders})
      GROUP BY d.PART_CD, d.COLOR_CD
      ORDER BY d.PART_CD, WH_STOCK DESC
    `, [BRAND_CD, ...partCds, BRAND_CD, ...partCds]);

    // 자사몰 판매 — 품번별 합산
    const dateClause = useRange ? 'AND DT >= ? AND DT <= ?' : 'AND DT >= CURRENT_DATE - 7 AND DT < CURRENT_DATE';
    const saleBinds  = [BRAND_CD, SHOP_ID, ...partCds];
    if (useRange) saleBinds.push(saleStart, saleEnd);

    const saleRows = await executeAsync(conn, `
      SELECT PART_CD, SUM(SALE_NML_QTY - SALE_RET_QTY) AS SALE_QTY
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_D
      WHERE BRD_CD = ?
        AND SHOP_ID = ?
        AND PART_CD IN (${placeholders})
        ${dateClause}
      GROUP BY PART_CD
    `, saleBinds);

    // 오프라인(백화점/대리점/직영점) 판매 — DB_SHOP.ANAL_DIST_TYPE_NM으로 매장 필터링 후 일별 합산
    const offlineBinds = [BRAND_CD, BRAND_CD, ...partCds];
    if (useRange) offlineBinds.push(saleStart, saleEnd);

    const offlineSaleRows = await executeAsync(conn, `
      WITH offline_shops AS (
        SELECT SHOP_ID FROM ${DATABASE}.${SCHEMA}.DB_SHOP
        WHERE BRD_CD = ?
          AND ANAL_DIST_TYPE_NM IN ('백화점', '대리점', '직영점')
      )
      SELECT s.PART_CD, SUM(s.SALE_NML_QTY - s.SALE_RET_QTY) AS SALE_QTY
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_D s
      JOIN offline_shops os ON s.SHOP_ID = os.SHOP_ID
      WHERE s.BRD_CD = ?
        AND s.PART_CD IN (${placeholders})
        ${dateClause.replace(/DT /g, 's.DT ')}
      GROUP BY s.PART_CD
    `, offlineBinds);

    const periodDays = useRange
      ? Math.max(1, Math.round((Date.parse(saleEnd) - Date.parse(saleStart)) / 86400000) + 1)
      : 7;
    const saleMap = new Map(saleRows.map(r => [r.PART_CD, parseInt(r.SALE_QTY || 0, 10)]));
    const offlineSaleMap = new Map(offlineSaleRows.map(r => [r.PART_CD, parseInt(r.SALE_QTY || 0, 10)]));

    const grouped = new Map();
    for (const row of stockRows) {
      let g = grouped.get(row.PART_CD);
      if (!g) { g = { prdt_nm: '', delv_dt_1st: null, colors: [] }; grouped.set(row.PART_CD, g); }
      if (row.PRDT_NM && !g.prdt_nm) g.prdt_nm = row.PRDT_NM;
      if (row.DELV_DT_1ST && !g.delv_dt_1st) g.delv_dt_1st = row.DELV_DT_1ST;
      g.colors.push({
        color: row.COLOR_CD,
        wh:    parseInt(row.WH_STOCK || 0, 10),
        total: parseInt(row.TOTAL_STOCK || 0, 10),
      });
    }

    const result = new Map();
    for (const [partCd, g] of grouped) {
      const sale     = saleMap.get(partCd) || 0;
      const dailyAvg = Math.round((sale / periodDays) * 10) / 10;
      const offlineSale     = offlineSaleMap.get(partCd) || 0;
      const dailyAvgOffline = Math.round((offlineSale / periodDays) * 10) / 10;
      const totalWh  = g.colors.reduce((s, c) => s + c.wh, 0);
      const dos      = dailyAvg > 0 ? Math.round(totalWh / dailyAvg) : null;
      const isMc     = (g.prdt_nm || '').toUpperCase().split(' ').includes('MC');
      result.set(partCd, {
        prdt_nm:           g.prdt_nm,
        is_mc:             isMc,
        delv_dt_1st:       g.delv_dt_1st,
        sale_7d:           sale,
        daily_avg:         dailyAvg,
        sale_offline:      offlineSale,
        daily_avg_offline: dailyAvgOffline,
        days_of_supply:    dos,
        colors:            g.colors,
      });
    }
    return result;
  } catch (err) {
    logger.warn(`fetchStockInfoBatch 실패 (${partCds.length}개 품번): ${err.message}`);
    return new Map();
  } finally {
    await destroyAsync(conn);
  }
}

/**
 * 출고 후 sell-through 곡선 + 동기(같은 시즌·같은 카테고리) cohort 비교
 *
 * Sell-through % = 누적 판매(순) ÷ 총입고량
 *   - 분자: AC_SALE_NML_QTY_NET (DW_SH_SCS_DACUM, 해당 주 마지막 스냅샷)
 *   - 분모: 모든 매장 누적 입고(AC_DELV_NML_QTY 최종값) + 창고 현재 재고(WH_STOCK_QTY)
 *
 * 카테고리 = PART_CD 3~4번째 글자 (예: DWPD42061 → "PD")
 *
 * @param {string} partCd
 * @returns {object|null}
 *   {
 *     part_cd, prdt_nm, sesn, category, delv_dt_1st, total_inflow,
 *     curve: [{week, week_end_date, cum_sales, sell_through_pct}],
 *     cohort: { size, category, sesn, curve: [{week, p25, p50, p75}] }
 *   }
 *   delv_dt_1st 가 없으면 { part_cd, ..., delv_dt_1st: null, curve: [], cohort: {...size:0} } 반환.
 */
export async function fetchSellThroughCurve(partCd) {
  const conn = createConnection();
  try {
    await connectAsync(conn);

    // 1. 해당 품번의 SESN, DELV_DT_1ST, PRDT_NM (가장 최근 시즌 기준)
    const selfRows = await executeAsync(conn, `
      SELECT SESN, DELV_DT_1ST, PRDT_NM
      FROM ${DATABASE}.${SCHEMA}.DB_PRDT
      WHERE BRD_CD = ? AND PART_CD = ? AND DELV_DT_1ST IS NOT NULL
      ORDER BY DELV_DT_1ST DESC
      LIMIT 1
    `, [BRAND_CD, partCd]);

    const category = partCd.length >= 4 ? partCd.substring(2, 4) : '';

    if (!selfRows || selfRows.length === 0) {
      return {
        part_cd: partCd, prdt_nm: '', sesn: '', category,
        delv_dt_1st: null, total_inflow: 0,
        curve: [], cohort: { size: 0, category, sesn: '', curve: [] },
      };
    }

    const self = selfRows[0];
    const sesn = self.SESN;
    const selfLaunch = new Date(self.DELV_DT_1ST);

    // 2. Cohort 품번 모집: 같은 BRD_CD + SESN + 카테고리(PART_CD[3:4]) + DELV_DT_1ST 존재
    const cohortRows = await executeAsync(conn, `
      SELECT PART_CD, MIN(DELV_DT_1ST) AS DELV_DT_1ST
      FROM ${DATABASE}.${SCHEMA}.DB_PRDT
      WHERE BRD_CD = ? AND SESN = ?
        AND SUBSTR(PART_CD, 3, 2) = ?
        AND DELV_DT_1ST IS NOT NULL
        AND PART_CD != ?
      GROUP BY PART_CD
      ORDER BY DELV_DT_1ST DESC
      LIMIT 50
    `, [BRAND_CD, sesn, category, partCd]);

    const partLaunch = new Map();
    partLaunch.set(partCd, selfLaunch);
    for (const r of cohortRows) {
      partLaunch.set(r.PART_CD, new Date(r.DELV_DT_1ST));
    }

    const allParts = [partCd, ...cohortRows.map(r => r.PART_CD)];
    const placeholders = allParts.map(() => '?').join(',');

    // 3. 시계열 누적 판매·입고 (모든 cohort + self, 단일 쿼리)
    const earliestLaunch = [...partLaunch.values()].reduce((min, d) => d < min ? d : min, selfLaunch);
    const earliestStr = earliestLaunch.toISOString().split('T')[0];

    const tsRows = await executeAsync(conn, `
      SELECT PART_CD, START_DT,
             SUM(AC_SALE_NML_QTY_NET) AS CUM_SALES_NET,
             SUM(AC_DELV_NML_QTY)     AS CUM_DELV
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_DACUM
      WHERE BRD_CD = ?
        AND PART_CD IN (${placeholders})
        AND START_DT >= ?
      GROUP BY PART_CD, START_DT
    `, [BRAND_CD, ...allParts, earliestStr]);

    // 4. 창고 현재 재고 (총입고량 분모용)
    const whRows = await executeAsync(conn, `
      WITH latest AS (
        SELECT PART_CD, MAX(START_DT) AS MAX_DT
        FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM
        WHERE BRD_CD = ? AND PART_CD IN (${placeholders})
        GROUP BY PART_CD
      )
      SELECT d.PART_CD, SUM(d.WH_STOCK_QTY) AS WH_STOCK
      FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM d
      JOIN latest l ON d.PART_CD = l.PART_CD AND d.START_DT = l.MAX_DT
      WHERE d.BRD_CD = ? AND d.PART_CD IN (${placeholders})
      GROUP BY d.PART_CD
    `, [BRAND_CD, ...allParts, BRAND_CD, ...allParts]);

    const whMap = new Map(whRows.map(r => [r.PART_CD, parseInt(r.WH_STOCK || 0, 10)]));

    // 5. JS 집계: PART_CD × week 마지막 스냅샷 → sell-through 곡선
    // 5-1. (PART_CD, week) 별 마지막 스냅샷
    const WEEK_MS = 7 * 86400000;
    const lastSnapshot = new Map(); // key: `${partCd}__${week}` → {part, week, weekEnd, cumSales, cumDelv}
    let maxCumDelvByPart = new Map(); // 분모 계산용: part → 최대 누적 입고

    for (const row of tsRows) {
      const launch = partLaunch.get(row.PART_CD);
      if (!launch) continue;
      const startDt = new Date(row.START_DT);
      if (startDt < launch) continue;
      const week = Math.floor((startDt - launch) / WEEK_MS);
      const cumSales = parseInt(row.CUM_SALES_NET || 0, 10);
      const cumDelv  = parseInt(row.CUM_DELV || 0, 10);
      const key = `${row.PART_CD}__${week}`;
      const existing = lastSnapshot.get(key);
      if (!existing || existing._dt < startDt) {
        lastSnapshot.set(key, { part: row.PART_CD, week, weekEnd: row.START_DT, cumSales, cumDelv, _dt: startDt });
      }
      const prev = maxCumDelvByPart.get(row.PART_CD) || 0;
      if (cumDelv > prev) maxCumDelvByPart.set(row.PART_CD, cumDelv);
    }

    // 5-2. PART_CD 별 총입고량 = max 누적 입고 + 창고 재고
    const totalInflow = new Map();
    for (const part of allParts) {
      const inflow = (maxCumDelvByPart.get(part) || 0) + (whMap.get(part) || 0);
      totalInflow.set(part, inflow);
    }

    // 5-3. PART_CD 별 weekly sell-through %
    const curveByPart = new Map();
    for (const { part, week, weekEnd, cumSales } of lastSnapshot.values()) {
      const denom = totalInflow.get(part) || 0;
      const pct = denom > 0 ? (cumSales / denom) * 100 : null;
      if (!curveByPart.has(part)) curveByPart.set(part, []);
      curveByPart.get(part).push({
        week,
        week_end_date: typeof weekEnd === 'string' ? weekEnd : weekEnd.toISOString().split('T')[0],
        cum_sales: cumSales,
        sell_through_pct: pct == null ? null : Math.round(pct * 10) / 10,
      });
    }
    for (const arr of curveByPart.values()) {
      arr.sort((a, b) => a.week - b.week);
    }

    // 6. Cohort 주차별 분포 → p25/p50/p75
    const cohortParts = cohortRows.map(r => r.PART_CD);
    const byWeek = new Map(); // week → [pct, ...]
    for (const cp of cohortParts) {
      const arr = curveByPart.get(cp) || [];
      for (const p of arr) {
        if (p.sell_through_pct == null) continue;
        if (!byWeek.has(p.week)) byWeek.set(p.week, []);
        byWeek.get(p.week).push(p.sell_through_pct);
      }
    }
    const cohortCurve = [...byWeek.entries()]
      .map(([week, vals]) => {
        vals.sort((a, b) => a - b);
        const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
        return {
          week,
          p25: Math.round(q(0.25) * 10) / 10,
          p50: Math.round(q(0.50) * 10) / 10,
          p75: Math.round(q(0.75) * 10) / 10,
          n: vals.length,
        };
      })
      .sort((a, b) => a.week - b.week);

    return {
      part_cd:      partCd,
      prdt_nm:      self.PRDT_NM || '',
      sesn,
      category,
      delv_dt_1st:  typeof self.DELV_DT_1ST === 'string' ? self.DELV_DT_1ST : self.DELV_DT_1ST.toISOString().split('T')[0],
      total_inflow: totalInflow.get(partCd) || 0,
      curve:        curveByPart.get(partCd) || [],
      cohort: {
        size: cohortParts.length,
        category,
        sesn,
        curve: cohortCurve,
      },
    };
  } catch (err) {
    logger.warn(`fetchSellThroughCurve 실패 (${partCd}): ${err.message}`);
    return null;
  } finally {
    await destroyAsync(conn);
  }
}

/** 진단용: 품번의 실제 SHOP_ID 목록 조회 */
export async function debugSaleShops(partCd) {
  const conn = createConnection();
  try {
    await connectAsync(conn);
    const rows = await executeAsync(conn, `
      SELECT SHOP_ID, SUM(SALE_NML_QTY - SALE_RET_QTY) AS SALE_QTY
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_D
      WHERE BRD_CD = ? AND PART_CD = ?
        AND DT >= CURRENT_DATE - 7 AND DT < CURRENT_DATE
      GROUP BY SHOP_ID
      ORDER BY SALE_QTY DESC
      LIMIT 20
    `, [BRAND_CD, partCd]);
    return rows;
  } catch (err) {
    logger.warn(`debugSaleShops 실패 (${partCd}): ${err.message}`);
    return null;
  } finally {
    await destroyAsync(conn);
  }
}

export default { fetchStockInfo, fetchStockInfoBatch, fetchSellThroughCurve, debugSaleShops };
