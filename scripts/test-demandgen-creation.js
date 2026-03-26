#!/usr/bin/env node
/**
 * Demand Gen 캠페인 생성 테스트 스크립트
 *
 * 단계별로 API 호출을 검증합니다.
 * Step 1: Campaign Budget + Campaign (mutateResources)
 * Step 2: Ad Group (개별 create)
 * Step 3: Image Asset 업로드 (개별 create)
 * Step 4: Ad 생성 (demand_gen_multi_asset_ad)
 *
 * 안전장치:
 * - 캠페인 상태: PAUSED
 * - 일 예산: ₩1
 *
 * Usage: node scripts/test-demandgen-creation.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAdsApi, enums } from 'google-ads-api';
import { getGoogleClient } from '../src/utils/clients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const google = getGoogleClient();

if (!google._configured) {
  console.error('Google Ads client not configured. Check .env credentials.');
  process.exit(1);
}

const TEST_CAMPAIGN_NAME = `TEST_DEMANDGEN_삭제예정_${Date.now()}`;
const TEST_LANDING_URL = 'https://www.discovery-expedition.com';
const BUSINESS_NAME = 'Discovery Expedition';

// Load test images
const logoBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'logo_navy.png')).toString('base64');
const marketingImageBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '628.png')).toString('base64');

async function run() {
  console.log('=== Demand Gen 캠페인 생성 테스트 ===\n');
  console.log(`캠페인명: ${TEST_CAMPAIGN_NAME}`);
  console.log(`상태: PAUSED / 예산: ₩1 / 비즈니스: ${BUSINESS_NAME}\n`);

  const customerId = google.customerId;

  try {
    // ── Step 1: Budget + Campaign via mutateResources ──
    console.log('[Step 1] Budget + Campaign 생성 (mutateResources)...');
    const budgetTemp = `customers/${customerId}/campaignBudgets/-1`;
    const campaignTemp = `customers/${customerId}/campaigns/-2`;

    const step1Result = await google.customer.mutateResources([
      {
        entity: 'campaign_budget',
        operation: 'create',
        resource: {
          resource_name: budgetTemp,
          name: `${TEST_CAMPAIGN_NAME}_budget`,
          amount_micros: 1_000_000, // ₩1
          delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          explicitly_shared: false,
        },
      },
      {
        entity: 'campaign',
        operation: 'create',
        resource: {
          resource_name: campaignTemp,
          name: TEST_CAMPAIGN_NAME,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.DEMAND_GEN,
          campaign_budget: budgetTemp,
          maximize_conversions: {},
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        },
      },
    ]);

    const campaignResourceName = step1Result.mutate_operation_responses[1].campaign_result?.resource_name;
    const campaignId = campaignResourceName?.split('/').pop();
    console.log(`  ✅ Campaign 생성 완료: ID=${campaignId}\n`);

    // ── Step 2: Ad Group ──
    console.log('[Step 2] Ad Group 생성...');
    // Demand Gen: do NOT set ad group type — Google auto-assigns it
    const adGroupResult = await google.customer.adGroups.create([{
      campaign: campaignResourceName,
      name: `${TEST_CAMPAIGN_NAME}_AdGroup`,
      status: enums.AdGroupStatus.PAUSED,
    }]);
    const adGroupResourceName = adGroupResult.results[0].resource_name;
    const adGroupId = adGroupResourceName.split('/').pop();
    console.log(`  ✅ Ad Group 생성 완료: ID=${adGroupId}\n`);

    // ── Step 3: Image Assets ──
    console.log('[Step 3] Image Assets 업로드...');

    // Logo
    const logoResult = await google.customer.assets.create([{
      name: `${TEST_CAMPAIGN_NAME}_logo`,
      image_asset: { data: Buffer.from(logoBase64, 'base64') },
      type: enums.AssetType.IMAGE,
    }]);
    const logoAssetName = logoResult.results[0].resource_name;
    console.log(`  ✅ Logo asset: ${logoAssetName}`);

    // Marketing image
    const imgResult = await google.customer.assets.create([{
      name: `${TEST_CAMPAIGN_NAME}_marketing`,
      image_asset: { data: Buffer.from(marketingImageBase64, 'base64') },
      type: enums.AssetType.IMAGE,
    }]);
    const imgAssetName = imgResult.results[0].resource_name;
    console.log(`  ✅ Marketing image asset: ${imgAssetName}\n`);

    // ── Step 4: Create Ad (demand_gen_multi_asset_ad) ──
    console.log('[Step 4] Demand Gen 광고 생성 (demand_gen_multi_asset_ad)...');
    const adResult = await google.customer.adGroupAds.create([{
      ad_group: adGroupResourceName,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [TEST_LANDING_URL],
        demand_gen_multi_asset_ad: {
          headlines: [
            { text: '디스커버리 익스페디션' },
            { text: '새로운 발견의 시작' },
          ],
          descriptions: [
            { text: '디스커버리 익스페디션에서 트렌디한 아웃도어 패션을 만나보세요.' },
          ],
          business_name: BUSINESS_NAME,
          marketing_images: [{ asset: imgAssetName }],
          logo_images: [{ asset: logoAssetName }],
        },
      },
    }]);
    console.log(`  ✅ Ad 생성 완료\n`);

    // ── Summary ──
    console.log('=== 테스트 완료 ===');
    console.log(`캠페인 ID: ${campaignId}`);
    console.log(`광고그룹 ID: ${adGroupId}`);
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
