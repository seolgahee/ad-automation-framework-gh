#!/usr/bin/env node
/**
 * Video 캠페인 생성 테스트 스크립트
 *
 * 단계별 API 호출 검증:
 * Step 1: Budget + Campaign (VIDEO, target_cpv)
 * Step 2: Ad Group (VIDEO_TRUE_VIEW_IN_STREAM)
 * Step 3: YouTube Video Asset 업로드
 * Step 4: Video Ad 생성 (in_stream)
 *
 * 안전장치: PAUSED, ₩1 예산
 *
 * Usage: node scripts/test-video-creation.js
 */
import 'dotenv/config';
import { getGoogleClient } from '../src/utils/clients.js';
import { enums } from 'google-ads-api';

const google = getGoogleClient();

if (!google._configured) {
  console.error('Google Ads client not configured. Check .env credentials.');
  process.exit(1);
}

const TEST_CAMPAIGN_NAME = `TEST_VIDEO_삭제예정_${Date.now()}`;
const TEST_LANDING_URL = 'https://www.discovery-expedition.com';
// Discovery Expedition 공식 YouTube 영상 (실제 존재하는 영상 ID 필요)
// 테스트용으로 짧은 영상 사용
const TEST_YOUTUBE_VIDEO_ID = 'dQw4w9WgXcQ'; // 테스트용 — 실제 브랜드 영상으로 교체 가능

async function run() {
  console.log('=== Video 캠페인 생성 테스트 ===\n');
  console.log(`캠페인명: ${TEST_CAMPAIGN_NAME}`);
  console.log(`상태: PAUSED / 예산: ₩1`);
  console.log(`YouTube 동영상 ID: ${TEST_YOUTUBE_VIDEO_ID}\n`);

  const customerId = google.customerId;

  try {
    // ── Step 1a: Budget ──
    console.log('[Step 1a] Budget 생성...');
    const budgetResult = await google.customer.campaignBudgets.create([{
      name: `${TEST_CAMPAIGN_NAME}_budget`,
      amount_micros: 1_000_000,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    }]);
    const budgetResourceName = budgetResult.results[0].resource_name;
    console.log(`  ✅ Budget: ${budgetResourceName}`);

    // ── Step 1b: Campaign (via mutateResources — single campaign entity) ──
    // Try different approaches to create VIDEO campaign
    console.log('[Step 1b] Campaign 생성 (VIDEO + VIDEO_ACTION sub-type)...');
    let campaignResourceName, campaignId;
    try {
      const campaignMutResult = await google.customer.mutateResources([{
        entity: 'campaign',
        operation: 'create',
        resource: {
          name: TEST_CAMPAIGN_NAME,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.VIDEO,
          advertising_channel_sub_type: enums.AdvertisingChannelSubType.VIDEO_ACTION,
          campaign_budget: budgetResourceName,
          maximize_conversions: {},
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        },
      }]);
      campaignResourceName = campaignMutResult.mutate_operation_responses[0].campaign_result?.resource_name;
      campaignId = campaignResourceName?.split('/').pop();
      console.log(`  ✅ Campaign 생성 (VIDEO_ACTION): ID=${campaignId}\n`);
    } catch (e1) {
      console.log(`  ❌ VIDEO_ACTION 실패: ${e1.errors?.[0] ? `[${Object.keys(e1.errors[0].error_code)[0]}] ${e1.errors[0].message}` : e1.message}`);

      // Fallback: try plain VIDEO with target_cpm
      console.log('  [Retry] target_cpm으로 재시도...');
      try {
        const campaignMutResult2 = await google.customer.mutateResources([{
          entity: 'campaign',
          operation: 'create',
          resource: {
            name: TEST_CAMPAIGN_NAME + '_v2',
            status: enums.CampaignStatus.PAUSED,
            advertising_channel_type: enums.AdvertisingChannelType.VIDEO,
            campaign_budget: budgetResourceName,
            target_cpm: {},
            contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
          },
        }]);
        campaignResourceName = campaignMutResult2.mutate_operation_responses[0].campaign_result?.resource_name;
        campaignId = campaignResourceName?.split('/').pop();
        console.log(`  ✅ Campaign 생성 (target_cpm): ID=${campaignId}\n`);
      } catch (e2) {
        console.log(`  ❌ target_cpm도 실패: ${e2.errors?.[0] ? `[${Object.keys(e2.errors[0].error_code)[0]}] ${e2.errors[0].message}` : e2.message}`);

        // Fallback: try via campaigns.create with target_cpv
        console.log('  [Retry] campaigns.create + target_cpv...');
        const campaignResult3 = await google.customer.campaigns.create([{
          name: TEST_CAMPAIGN_NAME + '_v3',
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.VIDEO,
          campaign_budget: budgetResourceName,
          target_cpv: {},
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        }]);
        campaignResourceName = campaignResult3.results[0].resource_name;
        campaignId = campaignResourceName.split('/').pop();
        console.log(`  ✅ Campaign 생성 (campaigns.create + target_cpv): ID=${campaignId}\n`);
      }
    }

    if (!campaignResourceName) throw new Error('Campaign 생성 실패 — 모든 방법 실패');

    // ── Step 2: Ad Group (in-stream skippable) ──
    console.log('[Step 2] Ad Group 생성 (VIDEO_TRUE_VIEW_IN_STREAM)...');
    const adGroupResult = await google.customer.adGroups.create([{
      campaign: campaignResourceName,
      name: `${TEST_CAMPAIGN_NAME}_AdGroup`,
      status: enums.AdGroupStatus.PAUSED,
      type: enums.AdGroupType.VIDEO_TRUE_VIEW_IN_STREAM,
    }]);
    const adGroupResourceName = adGroupResult.results[0].resource_name;
    const adGroupId = adGroupResourceName.split('/').pop();
    console.log(`  ✅ Ad Group 생성: ID=${adGroupId}\n`);

    // ── Step 3: YouTube Video Asset ──
    console.log('[Step 3] YouTube Video Asset 생성...');
    const videoAssetResult = await google.customer.assets.create([{
      name: `${TEST_CAMPAIGN_NAME}_video`,
      type: enums.AssetType.YOUTUBE_VIDEO,
      youtube_video_asset: { youtube_video_id: TEST_YOUTUBE_VIDEO_ID },
    }]);
    const videoAssetName = videoAssetResult.results[0].resource_name;
    console.log(`  ✅ Video asset: ${videoAssetName}\n`);

    // ── Step 4: Video Ad (in_stream) ──
    console.log('[Step 4] Video Ad 생성 (in_stream)...');
    const adResult = await google.customer.adGroupAds.create([{
      ad_group: adGroupResourceName,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [TEST_LANDING_URL],
        video_ad: {
          video: { asset: videoAssetName },
          in_stream: {
            action_headline: '디스커버리 익스페디션',
            action_button_label: '사이트 방문',
          },
        },
      },
    }]);
    console.log(`  ✅ Video Ad 생성 완료\n`);

    // ── Summary ──
    console.log('=== 테스트 완료 ===');
    console.log(`캠페인 ID: ${campaignId}`);
    console.log(`광고그룹 ID: ${adGroupId}`);
    console.log(`동영상 에셋: ${videoAssetName}`);
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
