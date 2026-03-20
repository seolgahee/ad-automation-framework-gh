#!/usr/bin/env node
/**
 * Manual data collection trigger
 * Usage: node scripts/collect-data.js
 */
import 'dotenv/config';
import DataCollector from '../src/analytics/collector.js';

const collector = new DataCollector();
console.log('Starting manual data collection...');
await collector.collectAll();
console.log('Collection complete.');
process.exit(0);
