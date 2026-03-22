/**
 * Audience Manager
 *
 * Unified audience creation and management across Meta and Google.
 * Supports: Custom Audiences, Lookalike/Similar, Interest-based, Remarketing lists
 */
import { createHash, randomBytes } from 'crypto';
import bizSdk from 'facebook-nodejs-business-sdk';
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import { getMetaClient, getGoogleClient } from '../utils/clients.js';

const { AdSet } = bizSdk;

/** SHA-256 hash for PII normalization (required by Meta & Google APIs) */
function hashPII(value) {
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

export class AudienceManager {
  constructor() {
    this.meta = getMetaClient();
    this.google = getGoogleClient();
    this._initTable();
  }

  _initTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audiences (
        id               TEXT PRIMARY KEY,
        platform         TEXT NOT NULL,
        platform_id      TEXT,
        name             TEXT NOT NULL,
        type             TEXT NOT NULL,        -- custom, lookalike, interest, remarketing, combined
        source           TEXT,                 -- pixel, customer_list, website, app, engagement
        size_estimate    INTEGER,
        targeting_json   TEXT,
        status           TEXT DEFAULT 'ACTIVE',
        campaigns_used   TEXT,                 -- comma-separated campaign IDs
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // ═══════════════════════════════════════════════════════════
  //  Meta Audiences
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a Meta Custom Audience from website visitors (pixel)
   */
  async createMetaPixelAudience({ name, pixelId, rule, retentionDays = 30 }) {
    const params = {
      name,
      subtype: 'WEBSITE',
      rule: JSON.stringify(rule || {
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: pixelId || process.env.META_PIXEL_ID, type: 'pixel' }],
            retention_seconds: retentionDays * 86400,
          }],
        },
      }),
    };

    const result = await this.meta.account.createCustomAudience([], params);
    const audienceId = result._data?.id;

    this._saveAudience({
      platform: 'meta', platformId: audienceId, name, type: 'custom',
      source: 'pixel', targeting: params,
    });

    logger.info('Meta pixel audience created', { audienceId, name });
    return { audienceId, name };
  }

  /**
   * Create a Meta Custom Audience from customer email list
   */
  async createMetaCustomerListAudience({ name, emails, phones }) {
    const schema = [];
    const data = [];

    if (emails?.length) {
      schema.push('EMAIL_SHA256');
      emails.forEach(e => data.push([hashPII(e)]));
    }
    if (phones?.length) {
      schema.push('PHONE_SHA256');
      phones.forEach(p => data.push([hashPII(p.replace(/\D/g, ''))]));
    }

    const audience = await this.meta.account.createCustomAudience([], {
      name,
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
    });

    // Add users to the audience
    await audience.createUser([], {
      payload: { schema, data },
    });

    this._saveAudience({
      platform: 'meta', platformId: audience._data?.id, name, type: 'custom',
      source: 'customer_list', targeting: { count: data.length },
    });

    logger.info('Meta customer list audience created', { name, count: data.length });
    return { audienceId: audience._data?.id, name, usersAdded: data.length };
  }

  /**
   * Create Meta Lookalike Audience
   */
  async createMetaLookalikeAudience({ name, sourceAudienceId, country = 'KR', ratio = 0.01 }) {
    const params = {
      name,
      subtype: 'LOOKALIKE',
      origin_audience_id: sourceAudienceId,
      lookalike_spec: JSON.stringify({
        type: 'similarity',
        country,
        ratio, // 0.01 = top 1%
      }),
    };

    const result = await this.meta.account.createCustomAudience([], params);
    const audienceId = result._data?.id;

    this._saveAudience({
      platform: 'meta', platformId: audienceId, name, type: 'lookalike',
      source: `lookalike_${sourceAudienceId}`, targeting: params,
    });

    logger.info('Meta lookalike audience created', { audienceId, name, ratio });
    return { audienceId, name };
  }

  // ═══════════════════════════════════════════════════════════
  //  Google Audiences
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a Google Ads remarketing user list
   */
  async createGoogleRemarketingList({ name, visitedUrls, membershipDays = 30 }) {
    const result = await this.google.customer.userLists.create({
      name,
      membership_life_span: membershipDays,
      membership_status: 'OPEN',
      rule_based_user_list: {
        prepopulation_status: 'REQUESTED',
        flexible_rule_user_list: {
          inclusive_rule_operator: 'AND',
          inclusive_operands: [{
            rule: {
              rule_item_groups: [{
                rule_items: visitedUrls.map(url => ({
                  name: 'url__',
                  string_rule_item: {
                    operator: 'CONTAINS',
                    value: url,
                  },
                })),
              }],
            },
          }],
        },
      },
    });

    const resourceName = result.results?.[0]?.resource_name;

    this._saveAudience({
      platform: 'google', platformId: resourceName, name, type: 'remarketing',
      source: 'website', targeting: { visitedUrls, membershipDays },
    });

    logger.info('Google remarketing list created', { resourceName, name });
    return { resourceName, name };
  }

  /**
   * Create Google Customer Match list from emails
   */
  async createGoogleCustomerMatchList({ name, emails }) {
    const userList = await this.google.customer.userLists.create({
      name,
      membership_life_span: 10000,
      crm_based_user_list: {
        upload_key_type: 'CONTACT_INFO',
        data_source_type: 'FIRST_PARTY',
      },
    });

    const resourceName = userList.results?.[0]?.resource_name;

    // Upload customer data (SHA-256 hashed per Google API requirements)
    const operations = emails.map(email => ({
      create: {
        user_identifiers: [{
          hashed_email: hashPII(email),
        }],
      },
    }));

    // Create offline data job and upload hashed customer data
    const job = await this.google.customer.offlineUserDataJobs.create({
      type: 'CUSTOMER_MATCH_USER_LIST',
      customer_match_user_list_metadata: {
        user_list: resourceName,
      },
    });

    const jobResourceName = job.results?.[0]?.resource_name;
    if (jobResourceName && operations.length > 0) {
      await this.google.customer.offlineUserDataJobs.addOperations(
        jobResourceName,
        { operations }
      );
      await this.google.customer.offlineUserDataJobs.run(jobResourceName);
    }

    this._saveAudience({
      platform: 'google', platformId: resourceName, name, type: 'custom',
      source: 'customer_list', targeting: { count: emails.length },
    });

    logger.info('Google customer match list created', { resourceName, name, count: emails.length });
    return { resourceName, name, count: emails.length };
  }

  // ═══════════════════════════════════════════════════════════
  //  Targeting Presets (ready-to-use targeting configs)
  // ═══════════════════════════════════════════════════════════

  /**
   * Get pre-built targeting presets for Korean market
   */
  getTargetingPresets() {
    return {
      'kr-broad-18-44': {
        name: 'KR 18-44 Broad',
        platform: 'meta',
        targeting: {
          geo_locations: { countries: ['KR'] },
          age_min: 18,
          age_max: 44,
          publisher_platforms: ['facebook', 'instagram'],
          facebook_positions: ['feed', 'story', 'reels'],
          instagram_positions: ['stream', 'story', 'reels'],
        },
      },
      'kr-young-female': {
        name: 'KR 18-34 Female',
        platform: 'meta',
        targeting: {
          geo_locations: { countries: ['KR'] },
          age_min: 18,
          age_max: 34,
          genders: [2],
          publisher_platforms: ['instagram'],
          instagram_positions: ['stream', 'story', 'reels', 'explore'],
        },
      },
      'kr-professionals': {
        name: 'KR 25-54 Professionals',
        platform: 'meta',
        targeting: {
          geo_locations: { countries: ['KR'] },
          age_min: 25,
          age_max: 54,
          targeting_optimization: 'none',
          publisher_platforms: ['facebook', 'instagram'],
        },
      },
      'kr-seoul-metro': {
        name: 'Seoul Metropolitan Area',
        platform: 'meta',
        targeting: {
          geo_locations: {
            regions: [{ key: '3865' }],  // Seoul
            cities: [
              { key: '1036829', radius: 25, distance_unit: 'kilometer' },  // Gangnam
            ],
          },
          age_min: 18,
          age_max: 65,
        },
      },
    };
  }

  /**
   * Apply a targeting preset + custom audience to an ad set
   */
  async applyTargetingToAdSet({ adSetId, platform, presetId, customAudienceIds = [] }) {
    const preset = this.getTargetingPresets()[presetId];
    if (!preset) throw new Error(`Preset "${presetId}" not found`);

    const targeting = { ...preset.targeting };

    // Add custom audiences
    if (customAudienceIds.length > 0) {
      targeting.custom_audiences = customAudienceIds.map(id => ({ id }));
    }

    if (platform === 'meta') {
      // Meta: update ad set targeting directly (AdSet imported at top of file)
      const adSet = new AdSet(adSetId);
      await adSet.update([], { targeting });
    }

    logger.info('Targeting applied', { adSetId, presetId, audiences: customAudienceIds.length });
    return { adSetId, targeting };
  }

  // ═══════════════════════════════════════════════════════════
  //  DB Helpers
  // ═══════════════════════════════════════════════════════════

  _saveAudience({ platform, platformId, name, type, source, targeting, sizeEstimate }) {
    const id = `aud_${randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO audiences (id, platform, platform_id, name, type, source, size_estimate, targeting_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, platform, platformId, name, type, source, sizeEstimate || 0, JSON.stringify(targeting));
    return id;
  }

  getAudiences(platform) {
    if (platform) {
      return db.prepare(`SELECT * FROM audiences WHERE platform = ? ORDER BY created_at DESC`).all(platform);
    }
    return db.prepare(`SELECT * FROM audiences ORDER BY platform, created_at DESC`).all();
  }

  getAudienceById(id) {
    return db.prepare(`SELECT * FROM audiences WHERE id = ?`).get(id);
  }
}

export default AudienceManager;
