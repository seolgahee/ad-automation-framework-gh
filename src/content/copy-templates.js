/**
 * Copy Template Engine
 *
 * Template-based ad copy generation system.
 * Define templates with {{variables}}, then render with actual values.
 *
 * Supports: Meta (headline + body + description + CTA)
 *           Google (multiple headlines | multiple descriptions)
 */
import db from '../utils/db.js';
import logger from '../utils/logger.js';

// ─── Built-in Templates ──────────────────────────────────────
const BUILT_IN_TEMPLATES = {
  // ─── Meta Templates ─────────────────────────────
  'meta-sale': {
    name: '{{product}} 할인 프로모션',
    platform: 'meta',
    headline: '{{product}} {{discount}}% 할인',
    description: '지금 주문하면 {{benefit}}! {{product}} 최대 {{discount}}% 할인 중.',
    bodyText: '{{season}} 한정 특가! {{product}}을(를) {{discount}}% 할인된 가격에 만나보세요.\n\n{{benefit}}\n\n{{urgency}}',
    cta: 'SHOP_NOW',
    variables: ['product', 'discount', 'benefit', 'season', 'urgency'],
    example: {
      product: '프리미엄 운동화',
      discount: '30',
      benefit: '무료 배송 + 추가 쿠폰',
      season: '봄 시즌',
      urgency: '3월 31일까지만 진행됩니다!',
    },
  },

  'meta-awareness': {
    name: '{{brand}} 브랜드 인지도',
    platform: 'meta',
    headline: '{{brand}} — {{tagline}}',
    description: '{{value_prop}}. {{brand}}와 함께하세요.',
    bodyText: '{{hook}}\n\n{{brand}}는 {{value_prop}}.\n\n{{social_proof}}',
    cta: 'LEARN_MORE',
    variables: ['brand', 'tagline', 'value_prop', 'hook', 'social_proof'],
    example: {
      brand: 'FitLife',
      tagline: '건강한 일상의 시작',
      value_prop: '100만 고객이 선택한 건강 관리 솔루션',
      hook: '바쁜 일상 속에서도 건강을 챙기고 싶으신가요?',
      social_proof: '앱스토어 건강 카테고리 1위',
    },
  },

  'meta-retarget': {
    name: '{{product}} 리타겟팅',
    platform: 'meta',
    headline: '아직 고민 중이신가요?',
    description: '{{product}} — {{incentive}}',
    bodyText: '{{product}}을(를) 살펴보셨군요!\n\n지금 구매하시면 {{incentive}}.\n\n{{urgency}}',
    cta: 'SHOP_NOW',
    variables: ['product', 'incentive', 'urgency'],
    example: {
      product: '무선 이어버드 Pro',
      incentive: '10% 추가 할인 쿠폰 적용 가능',
      urgency: '오늘 자정까지만 유효합니다.',
    },
  },

  'meta-lead': {
    name: '{{service}} 리드 수집',
    platform: 'meta',
    headline: '{{benefit}} — 무료 상담 신청',
    description: '{{service}} 전문가가 직접 상담해드립니다.',
    bodyText: '{{hook}}\n\n{{service}} 전문 {{company}}에서 무료 상담을 진행합니다.\n\n{{benefits_list}}\n\n지금 바로 신청하세요!',
    cta: 'SIGN_UP',
    variables: ['service', 'benefit', 'company', 'hook', 'benefits_list'],
    example: {
      service: '세무 컨설팅',
      benefit: '세금 30% 절약',
      company: '스마트택스',
      hook: '절세 방법, 아직도 모르시나요?',
      benefits_list: '✓ 1:1 맞춤 컨설팅\n✓ 신고 대행 무료\n✓ 환급금 극대화',
    },
  },

  // ─── Google Templates ───────────────────────────
  'google-search': {
    name: '{{product}} 검색 광고',
    platform: 'google',
    headline: '{{product}} {{discount}}% 할인|{{brand}} 공식 스토어|지금 구매하면 {{benefit}}|무료 배송 진행 중',
    description: '{{product}} {{discount}}% 특가 세일 중. {{benefit}}. {{brand}} 공식몰에서 정품을 만나보세요.|{{urgency}} {{brand}} 인기 상품 {{product}} — 최저가 보장, 빠른 배송.',
    bodyText: '',
    cta: '',
    variables: ['product', 'brand', 'discount', 'benefit', 'urgency'],
    example: {
      product: '에어 조던 1',
      brand: 'NikeKR',
      discount: '25',
      benefit: '사은품 증정',
      urgency: '이번 주말까지만!',
    },
  },

  'google-pmax': {
    name: '{{product}} Performance Max',
    platform: 'google',
    headline: '{{product}} 베스트셀러|{{brand}} 인기 상품|{{discount}}% 할인 특가|고객 만족도 {{rating}}점',
    description: '{{brand}}의 {{product}} — {{value_prop}}. 지금 {{discount}}% 할인 중.|{{social_proof}} {{urgency}}',
    bodyText: '',
    cta: '',
    variables: ['product', 'brand', 'discount', 'value_prop', 'rating', 'social_proof', 'urgency'],
    example: {
      product: '올인원 청소기',
      brand: 'CleanPro',
      discount: '20',
      value_prop: '한 대로 청소 끝',
      rating: '4.8',
      social_proof: '누적 판매 50만 대',
      urgency: '재고 한정!',
    },
  },
};

export class CopyTemplateEngine {
  constructor() {
    this._initTemplateTable();
    this._seedBuiltIns();
  }

  _initTemplateTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS copy_templates (
        id               TEXT PRIMARY KEY,
        platform         TEXT NOT NULL,
        name             TEXT NOT NULL,
        headline         TEXT,
        description      TEXT,
        body_text        TEXT,
        cta              TEXT,
        variables_json   TEXT,
        example_json     TEXT,
        is_builtin       INTEGER DEFAULT 0,
        created_at       TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  _seedBuiltIns() {
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO copy_templates (id, platform, name, headline, description, body_text, cta, variables_json, example_json, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const tx = db.transaction(() => {
      for (const [id, tpl] of Object.entries(BUILT_IN_TEMPLATES)) {
        upsert.run(id, tpl.platform, tpl.name, tpl.headline, tpl.description,
          tpl.bodyText, tpl.cta, JSON.stringify(tpl.variables), JSON.stringify(tpl.example));
      }
    });
    tx();
  }

  /**
   * Render a template with given variables
   * @param {string} templateId
   * @param {object} variables - key/value pairs to inject
   * @returns {{ name, headline, description, bodyText, cta }}
   */
  render(templateId, variables) {
    const tpl = BUILT_IN_TEMPLATES[templateId]
      || db.prepare(`SELECT * FROM copy_templates WHERE id = ?`).get(templateId);

    if (!tpl) throw new Error(`Template "${templateId}" not found`);

    const replace = (str) => {
      if (!str) return '';
      return str.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
    };

    return {
      name: replace(tpl.name),
      headline: replace(tpl.headline),
      description: replace(tpl.description),
      bodyText: replace(tpl.body_text || tpl.bodyText || ''),
      cta: tpl.cta || 'LEARN_MORE',
    };
  }

  /** Create a custom template */
  createTemplate({ id, platform, name, headline, description, bodyText, cta, variables, example }) {
    db.prepare(`
      INSERT INTO copy_templates (id, platform, name, headline, description, body_text, cta, variables_json, example_json, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, platform, name, headline, description, bodyText || '', cta || '',
      JSON.stringify(variables), JSON.stringify(example || {}));

    logger.info('Custom template created', { id, platform });
    return { id, platform };
  }

  /** List all templates */
  listTemplates(platform) {
    if (platform) {
      return db.prepare(`SELECT * FROM copy_templates WHERE platform = ? ORDER BY is_builtin DESC, name`).all(platform);
    }
    return db.prepare(`SELECT * FROM copy_templates ORDER BY platform, is_builtin DESC, name`).all();
  }

  /** Preview with example data (supports both built-in and custom templates) */
  preview(templateId) {
    const builtIn = BUILT_IN_TEMPLATES[templateId];
    if (builtIn) {
      return this.render(templateId, builtIn.example);
    }

    // Fall back to DB-stored custom template with its example data
    const dbTemplate = db.prepare(`SELECT * FROM copy_templates WHERE id = ?`).get(templateId);
    if (!dbTemplate) return null;

    const exampleData = dbTemplate.example_json ? JSON.parse(dbTemplate.example_json) : {};
    if (Object.keys(exampleData).length === 0) return null;

    return this.render(templateId, exampleData);
  }
}

export default CopyTemplateEngine;
