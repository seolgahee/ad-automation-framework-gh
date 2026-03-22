/**
 * Meta Ad Creative 이미지 URL 테스트 (Step 2)
 * asset_feed_spec.images[].hash → AdImage permalink_url 변환
 */
import 'dotenv/config';
import bizSdk from 'facebook-nodejs-business-sdk';

const { FacebookAdsApi, AdAccount } = bizSdk;

const token = process.env.META_ACCESS_TOKEN;
const accountId = process.env.META_AD_ACCOUNT_ID;

FacebookAdsApi.init(token);
const account = new AdAccount(accountId);

async function test() {
  // 이전 테스트에서 발견된 image hashes
  const hashes = [
    'eb29cd772071a8e5a37fd9e2dee306cf',
    '5d89996c0bacb6adb909dcdf24f9307b',
    'a1d189f0c3045aa9b7fc05df9288fc4f',
  ]; // 중복 제거 (4개 중 1개 중복)

  console.log('=== AdImage API: hash → permalink_url ===\n');

  const images = await account.getAdImages(
    ['permalink_url', 'hash', 'original_height', 'original_width', 'url', 'url_128', 'name'],
    { hashes }
  );

  for (const img of images) {
    const d = img._data;
    console.log(`Hash: ${d.hash}`);
    console.log(`Name: ${d.name}`);
    console.log(`Size: ${d.original_width}x${d.original_height}`);
    console.log(`permalink_url: ${d.permalink_url}`);
    console.log(`url (임시): ${d.url}`);
    console.log('---');
  }
}

test().catch(err => {
  console.error('Error:', err.message);
});
