#!/usr/bin/env node
/**
 * Test the Demand Gen API endpoint (simulates what the UI sends)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://localhost:3099/api';

const logoBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'logo_navy.png')).toString('base64');
const imgBase64 = fs.readFileSync(path.join(__dirname, '..', 'tests', '628.png')).toString('base64');

const body = {
  mode: 'demand_gen',
  name: `TEST_DG_UI_삭제예정_${Date.now()}`,
  dailyBudget: '1',
  finalUrl: 'https://www.discovery-expedition.com',
  biddingGoal: 'CONVERSIONS',
  adType: 'image',
  businessName: 'Discovery Expedition',
  headlines: ['디스커버리 익스페디션', '봄 신상 출시'],
  descriptions: ['트렌디한 아웃도어 패션을 만나보세요.'],
  marketingImagesBase64: [imgBase64],
  logoBase64,
};

console.log(`Sending Demand Gen request to ${API}/google/creative/direct`);
console.log(`Campaign name: ${body.name}`);
console.log(`Payload size: ${(JSON.stringify(body).length / 1024 / 1024).toFixed(2)} MB\n`);

const res = await fetch(`${API}/google/creative/direct`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(`Status: ${res.status}`);
console.log('Response:', JSON.stringify(data, null, 2));
