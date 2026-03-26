#!/usr/bin/env node
/**
 * Display (GDN) 캠페인 생성 테스트 스크립트
 *
 * Step 1: Budget + Campaign (DISPLAY, maximize_conversions)
 * Step 2: Ad Group (DISPLAY_STANDARD)
 * Step 3: Image Assets 업로드
 * Step 4: Responsive Display Ad 생성
 *
 * 안전장치: PAUSED, ₩1 예산
 *
 * Usage: node scripts/test-display-creation.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGoogleClient } from '../src/utils/clients.js';
import { enums } from 'google-ads-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const google = getGoogleClient();

if (!google._configured) {
  console.error('Google Ads client not configured. Check .env credentials.');
  process.exit(1);
}

const TEST_CAMPAIGN_NAME = `TEST_DISPLAY_삭제예정_${Date.now()}`;
const TEST_LANDING_URL = 'https://www.discovery-expedition.com';
const BUSINESS_NAME = 'Discovery Expedition';

const logoBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'logo_navy.png')).toString('base64');
const marketingImageBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '628.png')).toString('base64');
const squareImageBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '1200.png')).toString('base64');

async function run() {
  console.log('=== Display (GDN) 캠페인 생성 테스트 ===\n');
  console.log(`캠페인명: ${TEST_CAMPAIGN_NAME}`);
  console.log(`상태: PAUSED / 예산: ₩1 / 비즈니스: ${BUSINESS_NAME}\n`);

  const customerId = google.customerId;

  try {
    // ── Step 1: Budget + Campaign ──
    console.log('[Step 1] Budget + Campaign 생성...');
    const campaign = await google.createCampaign({
      name: TEST_CAMPAIGN_NAME,
      dailyBudget: 1,
      channelType: 'DISPLAY',
      status: 'PAUSED',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
    });
    console.log(`  ✅ Campaign 생성: ID=${campaign.id}\n`);

    // ── Step 2: Ad Group ──
    console.log('[Step 2] Ad Group 생성 (DISPLAY_STANDARD)...');
    const adGroup = await google.createAdGroup({
      campaignId: campaign.id,
      name: `${TEST_CAMPAIGN_NAME}_AdGroup`,
      status: 'PAUSED',
      adGroupType: 'DISPLAY_STANDARD',
    });
    console.log(`  ✅ Ad Group 생성: ID=${adGroup.id}\n`);

    // ── Step 3: Image Assets ──
    console.log('[Step 3] Image Assets 업로드...');
    const imgAsset = await google.createImageAsset({ name: `${TEST_CAMPAIGN_NAME}_marketing`, imageBase64: marketingImageBase64 });
    console.log(`  ✅ Marketing image asset: ${imgAsset}`);
    const sqAsset = await google.createImageAsset({ name: `${TEST_CAMPAIGN_NAME}_square`, imageBase64: squareImageBase64 });
    console.log(`  ✅ Square image asset: ${sqAsset}`);
    // Logo: 128x128 for square_logo_images
    const logoAsset = await google.createImageAsset({ name: `${TEST_CAMPAIGN_NAME}_logo`, imageBase64: logoBase64 });
    console.log(`  ✅ Logo asset (128x128): ${logoAsset}\n`);

    // ── Step 4: Responsive Display Ad ──
    console.log('[Step 4] Responsive Display Ad 생성...');
    const adGroupResourceName = `customers/${customerId}/adGroups/${adGroup.id}`;
    await google.customer.adGroupAds.create([{
      ad_group: adGroupResourceName,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [TEST_LANDING_URL],
        responsive_display_ad: {
          headlines: [{ text: '디스커버리 익스페디션' }, { text: '새로운 발견의 시작' }],
          long_headline: { text: '디스커버리 익스페디션에서 트렌디한 아웃도어 패션을 지금 만나보세요' },
          descriptions: [{ text: '트렌디한 아웃도어 패션을 만나보세요.' }],
          business_name: BUSINESS_NAME,
          marketing_images: [{ asset: imgAsset }],
          square_marketing_images: [{ asset: sqAsset }],
          square_logo_images: [{ asset: logoAsset }],
        },
      },
    }]);
    console.log(`  ✅ Responsive Display Ad 생성 완료\n`);

    console.log('=== 테스트 완료 ===');
    console.log(`캠페인 ID: ${campaign.id}`);
    console.log(`광고그룹 ID: ${adGroup.id}`);
    console.log(`캠페인 상태: PAUSED (광고 미게재)`);
    console.log(`일 예산: ₩1`);
    console.log(`\n⚠️  테스트 후 Google Ads 대시보드에서 "${TEST_CAMPAIGN_NAME}" 캠페인을 삭제해주세요.`);

  } catch (err) {
    console.error('\n❌ 실패:', err.message);
    if (err.errors) {
      for (const e of err.errors) {
        const errorType = Object.keys(e.error_code)[0];
        const errorValue = Object.values(e.error_code)[0];
        console.error(`  - [${errorType}: ${errorValue}] ${e.message}`);
        if (e.location?.field_path_elements) {
          console.error(`    path: ${e.location.field_path_elements.map(f => f.field_name).join('.')}`);
        }
      }
    } else {
      console.error(err);
    }
  }
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
