#!/usr/bin/env node
/**
 * PMAX 캠페인 생성 테스트 스크립트
 *
 * 안전장치:
 * - 캠페인 상태: PAUSED (광고 미게재)
 * - 일 예산: ₩1 (최소값)
 * - Asset Group 상태: PAUSED
 *
 * Usage: node scripts/test-pmax-creation.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGoogleClient } from '../src/utils/clients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const google = getGoogleClient();

if (!google._configured) {
  console.error('Google Ads client not configured. Check .env credentials.');
  process.exit(1);
}

const TEST_CAMPAIGN_NAME = 'TEST_PMAX_API_테스트_삭제예정';
const TEST_LANDING_URL = 'https://www.discovery-expedition.com';
const BUSINESS_NAME = 'Discovery Expedition';

// Load test images as base64
const logoBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'logo_navy.png')).toString('base64');
const marketingImageBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '628.png')).toString('base64');
const squareImageBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '1200.png')).toString('base64');

async function run() {
  console.log('=== PMAX 캠페인 생성 테스트 ===\n');
  console.log(`캠페인명: ${TEST_CAMPAIGN_NAME}`);
  console.log(`상태: PAUSED / 예산: ₩1 / 비즈니스: ${BUSINESS_NAME}`);
  console.log(`이미지: logo(128x128), marketing(1200x628), square(1200x1200)\n`);

  // Enable debug: log mutations before sending
  const origMutate = google.customer.mutateResources.bind(google.customer);
  google.customer.mutateResources = async (mutations, opts) => {
    console.log(`\n[DEBUG] Total mutations: ${mutations.length}`);
    for (const [i, m] of mutations.entries()) {
      const resName = m.resource?.resource_name || '';
      console.log(`  [${i}] entity=${m.entity} op=${m.operation} res_name=${resName} field_type=${m.resource?.field_type || ''}`);
    }
    return origMutate(mutations, opts);
  };

  try {
    const result = await google.createPmaxCampaign({
      name: TEST_CAMPAIGN_NAME,
      dailyBudget: 1,
      businessName: BUSINESS_NAME,
      logoBase64,
      marketingImageBase64,
      squareImageBase64,
      finalUrls: [TEST_LANDING_URL],
      headlines: [
        '디스커버리 익스페디션',
        '새로운 발견의 시작',
        '지금 바로 만나보세요',
        '아웃도어 패션 브랜드',
        '트렌디한 스타일',
      ],
      longHeadline: '디스커버리 익스페디션에서 트렌디한 아웃도어 패션을 지금 만나보세요',
      descriptions: [
        '디스커버리 익스페디션에서 트렌디한 아웃도어 패션을 만나보세요.',
        '자연과 함께하는 라이프스타일, 디스커버리.',
        '아웃도어부터 캐주얼까지, 디스커버리 익스페디션.',
        '새로운 시즌, 새로운 스타일을 발견하세요.',
      ],
    });

    console.log('\n=== 테스트 완료 ===');
    console.log(`캠페인 ID: ${result.id}`);
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
