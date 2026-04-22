/**
 * Snowflake Inventory Client
 *
 * 재고 데이터 조회 모듈 (Discovery 브랜드 기준)
 * Tables: DW_SCS_DACUM (재고), DB_PRDT (상품명), DW_SH_SCS_D (판매)
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
 * @returns {object|null}
 *   colorCd 있을 때: { prdt_nm, is_mc, sizes: [{size, wh, total}], sale_7d, daily_avg, days_of_supply }
 *   colorCd 없을 때: { prdt_nm, is_mc, colors: [{color, wh, total}], sale_7d, daily_avg, days_of_supply }
 */
export async function fetchStockInfo(partCd, colorCd = null) {
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
               MAX(p.PRDT_NM)      AS PRDT_NM
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
               MAX(p.PRDT_NM)      AS PRDT_NM
        FROM ${DATABASE}.${SCHEMA}.DW_SCS_DACUM d
        LEFT JOIN ${DATABASE}.${SCHEMA}.DB_PRDT p ON d.PRDT_CD = p.PRDT_CD
        WHERE d.BRD_CD = ? AND d.PART_CD = ?
          AND d.START_DT = (${latestDtSub})
        GROUP BY d.COLOR_CD
        ORDER BY WH_STOCK DESC
      `, [BRAND_CD, partCd, BRAND_CD, partCd]);
    }

    // 최근 7일 자사몰 판매량 — SHOP_ID=30004 ((주)에프앤에프)
    const colorFilter = colorCd ? 'AND COLOR_CD = ?' : '';
    const saleParams  = colorCd
      ? [BRAND_CD, SHOP_ID, partCd, colorCd]
      : [BRAND_CD, SHOP_ID, partCd];

    const saleRows = await executeAsync(conn, `
      SELECT SUM(SALE_NML_QTY - SALE_RET_QTY) AS SALE_QTY
      FROM ${DATABASE}.${SCHEMA}.DW_SH_SCS_D
      WHERE BRD_CD = ?
        AND SHOP_ID = ?
        AND PART_CD = ?
        ${colorFilter}
        AND DT >= CURRENT_DATE - 7
        AND DT <  CURRENT_DATE
    `, saleParams);

    const sale7d   = parseInt(saleRows?.[0]?.SALE_QTY || 0, 10);
    const dailyAvg = Math.round((sale7d / 7) * 10) / 10;

    if (!stockRows || stockRows.length === 0) return null;

    const prdtNm = stockRows.find(r => r.PRDT_NM)?.PRDT_NM || '';
    const isMc   = prdtNm.toUpperCase().split(' ').includes('MC');

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

    return { prdt_nm: prdtNm, is_mc: isMc, sale_7d: sale7d, daily_avg: dailyAvg, days_of_supply: daysOfSupply, ...result };

  } catch (err) {
    logger.warn(`재고 조회 실패 (${partCd}-${colorCd}): ${err.message}`);
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

export default { fetchStockInfo, debugSaleShops };
