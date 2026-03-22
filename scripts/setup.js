#!/usr/bin/env node
/**
 * Initial setup: create DB, seed templates, verify credentials
 * Usage: node scripts/setup.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initDatabase } from '../src/utils/db.js';
import { CopyTemplateEngine } from '../src/content/copy-templates.js';
import { getMetaClient, getGoogleClient } from '../src/utils/clients.js';

console.log('=== Ad Automation Framework Setup ===\n');

// 1. Check .env exists
const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  console.log('⚠️  No .env file found. Copying from config/default.env...');
  fs.copyFileSync(path.resolve('config/default.env'), envPath);
  console.log('   Created .env — please fill in your API credentials.\n');
} else {
  console.log('✅ .env file found\n');
}

// 2. Initialize DB
console.log('Initializing database...');
initDatabase();
console.log('✅ Database initialized\n');

// 3. Seed templates
console.log('Seeding copy templates...');
new CopyTemplateEngine();
console.log('✅ Templates seeded\n');

// 4. Verify credentials
console.log('Checking API credentials...');
const meta = getMetaClient();
const google = getGoogleClient();
console.log(`   Meta:   ${meta._configured ? '✅ Configured' : '❌ Not configured'}`);
console.log(`   Google: ${google._configured ? '✅ Configured' : '❌ Not configured'}`);

console.log('\n=== Setup Complete ===');
console.log('Run `npm run dev` to start the server + dashboard.');
process.exit(0);
