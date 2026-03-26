#!/usr/bin/env node
/**
 * Standard (Search) 캠페인 + RSA 생성 테스트 스크립트
 *
 * 안전장치:
 * - 캠페인 상태: PAUSED (광고 미게재)
 * - 일 예산: ₩1 (최소값)
 * - 광고그룹 상태: PAUSED
 * - RSA 상태: PAUSED
 *
 * 플로우: createCampaign → createAdGroup → addKeywords → createResponsiveSearchAd
 *
 * Usage: node scripts/test-standard-creation.js
 */
import 'dotenv/config';
import { getGoogleClient } from '../src/utils/clients.js';

const google = getGoogleClient();

if (!google._configured) {
  console.error('Google Ads client not configured. Check .env credentials.');
  process.exit(1);
}

const TEST_CAMPAIGN_NAME = `TEST_STANDARD_RSA_삭제예정_${Date.now()}`;
const TEST_ADGROUP_NAME = 'TEST_AdGroup_삭제예정';
const TEST_LANDING_URL = 'https://www.discovery-expedition.com';

const TEST_HEADLINES = [
  '디스커버리 익스페디션',
  '새로운 발견의 시작',
  '지금 바로 만나보세요',
];

const TEST_DESCRIPTIONS = [
  '디스커버리 익스페디션에서 트렌디한 아웃도어 패션을 만나보세요.',
  '자연과 함께하는 라이프스타일, 디스커버리.',
];

const TEST_KEYWORDS = [
  { text: '디스커버리', matchType: 'BROAD' },
  { text: '아웃도어 패션', matchType: 'PHRASE' },
  { text: '디스커버리 익스페디션', matchType: 'EXACT' },
];

async function run() {
  console.log('=== Standard (Search) 캠페인 + RSA 생성 테스트 ===\n');
  console.log(`캠페인명: ${TEST_CAMPAIGN_NAME}`);
  console.log(`광고그룹: ${TEST_ADGROUP_NAME}`);
  console.log(`상태: PAUSED / 예산: ₩1`);
  console.log(`Headlines: ${TEST_HEADLINES.length}개 / Descriptions: ${TEST_DESCRIPTIONS.length}개`);
  console.log(`Keywords: ${TEST_KEYWORDS.length}개\n`);

  try {
    // Step 1: 캠페인 생성
    console.log('[1/4] 캠페인 생성...');
    const campaign = await google.createCampaign({
      name: TEST_CAMPAIGN_NAME,
      dailyBudget: 1,
      channelType: 'SEARCH',
      status: 'PAUSED',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
    });
    console.log(`  ✅ 캠페인 생성 완료: ID=${campaign.id}, 이름=${campaign.name}\n`);

    // Step 2: 광고그룹 생성
    console.log('[2/4] 광고그룹 생성...');
    const adGroup = await google.createAdGroup({
      campaignId: campaign.id,
      name: TEST_ADGROUP_NAME,
      status: 'PAUSED',
    });
    console.log(`  ✅ 광고그룹 생성 완료: ID=${adGroup.id}, 이름=${adGroup.name}\n`);

    // Step 3: 키워드 추가
    console.log('[3/4] 키워드 추가...');
    const kwResult = await google.addKeywords(adGroup.id, TEST_KEYWORDS);
    console.log(`  ✅ 키워드 ${TEST_KEYWORDS.length}개 추가 완료`);
    for (const kw of TEST_KEYWORDS) {
      console.log(`     - "${kw.text}" (${kw.matchType})`);
    }
    console.log();

    // Step 4: RSA 생성
    console.log('[4/4] 반응형 검색 광고(RSA) 생성...');
    const rsaResult = await google.createResponsiveSearchAd({
      adGroupId: adGroup.id,
      headlines: TEST_HEADLINES,
      descriptions: TEST_DESCRIPTIONS,
      finalUrls: [TEST_LANDING_URL],
    });
    console.log(`  ✅ RSA 생성 완료\n`);

    // 결과 요약
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
    }
  }
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
