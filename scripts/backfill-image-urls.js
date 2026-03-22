#!/usr/bin/env node
/**
 * Backfill image URLs for existing Meta ads in ad_performance.
 * Only updates image_url — does NOT touch performance data.
 *
 * Usage:
 *   node scripts/backfill-image-urls.js          # image_url이 NULL인 Meta 소재만
 *   node scripts/backfill-image-urls.js --all     # 기존 image_url도 재수집 (덮어쓰기)
 */
import 'dotenv/config';
import db, { initDatabase } from '../src/utils/db.js';
import { getMetaClient } from '../src/utils/clients.js';

const forceAll = process.argv.includes('--all');

initDatabase();

const meta = getMetaClient();

async function backfill() {
  // 1. DB에서 대상 ad_id 목록 조회
  const condition = forceAll
    ? `platform = 'meta'`
    : `platform = 'meta' AND (image_url IS NULL OR image_url = '')`;

  const rows = db.prepare(
    `SELECT DISTINCT ad_id FROM ad_performance WHERE ${condition}`
  ).all();

  console.log(`\n=== Meta 소재 이미지 URL 백필 ===`);
  console.log(`대상: ${rows.length}개 (${forceAll ? '전체 재수집' : 'image_url 없는 소재만'})\n`);

  if (rows.length === 0) {
    console.log('백필 대상 없음 — 모든 Meta 소재에 이미지 URL이 있습니다.');
    return;
  }

  const adIds = rows.map(r => r.ad_id);

  // 2. Meta API로 이미지 URL 조회
  console.log('Meta API 호출 중...');
  const imageMap = await meta.getAdCreativeImages(adIds);

  console.log(`API 결과: ${imageMap.size}/${adIds.length}개 이미지 URL 확인\n`);

  // 3. DB UPDATE (image_url만 변경)
  const update = db.prepare(
    `UPDATE ad_performance SET image_url = ? WHERE ad_id = ? AND platform = 'meta' AND (image_url IS NULL OR image_url = '')`
  );
  const updateForce = db.prepare(
    `UPDATE ad_performance SET image_url = ? WHERE ad_id = ? AND platform = 'meta'`
  );

  let updated = 0;
  let skipped = 0;

  const transaction = db.transaction(() => {
    for (const [adId, url] of imageMap) {
      const stmt = forceAll ? updateForce : update;
      const result = stmt.run(url, adId);
      if (result.changes > 0) {
        updated++;
        console.log(`  ✓ ${adId} → ${url.substring(0, 80)}...`);
      } else {
        skipped++;
      }
    }
  });
  transaction();

  const noImage = adIds.filter(id => !imageMap.has(id));

  console.log(`\n=== 결과 ===`);
  console.log(`업데이트: ${updated}개`);
  console.log(`스킵 (이미 있음): ${skipped}개`);
  console.log(`이미지 없음 (API에서 미반환): ${noImage.length}개`);

  if (noImage.length > 0) {
    console.log(`\n--- 이미지 조회 불가 소재 (${noImage.length}개) ---`);
    for (const id of noImage) {
      const info = db.prepare(
        `SELECT ad_name, SUM(spend) as total_spend FROM ad_performance WHERE ad_id = ? AND platform = 'meta' GROUP BY ad_id`
      ).get(id);
      console.log(`  ${id}  spend=₩${Math.round(info?.total_spend || 0).toLocaleString()}  ${info?.ad_name || '(이름 없음)'}`);
    }
  }
}

backfill().catch(err => {
  console.error('백필 실패:', err.message);
  process.exit(1);
});
