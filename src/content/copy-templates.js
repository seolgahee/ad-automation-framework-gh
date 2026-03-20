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

// ─── P.D.A Tag Definitions ───────────────────────────────────
// Persona: who is the target
// Desire: what motivation is being addressed
// Awareness: how far along the buyer journey
export const PDA_OPTIONS = {
  persona: [
    { value: 'busy_professional', label: '야근하는 직장인' },
    { value: 'tired_parent',      label: '육아에 지친 부모' },
    { value: 'budget_conscious',  label: '절약형 소비자' },
    { value: 'health_seeker',     label: '건강 관심층' },
    { value: 'trend_follower',    label: '트렌드 팔로워' },
  ],
  desire: [
    { value: 'efficiency',         label: '효율/시간 절약' },
    { value: 'social_recognition', label: '사회적 인정' },
    { value: 'safety_trust',       label: '안전/신뢰' },
    { value: 'saving',             label: '절약/가성비' },
    { value: 'achievement',        label: '성취/자기계발' },
  ],
  awareness: [
    { value: 'unaware',        label: 'Unaware — 문제 인식 전' },
    { value: 'problem_aware',  label: 'Problem-aware — 문제 인식' },
    { value: 'solution_aware', label: 'Solution-aware — 해결책 탐색' },
    { value: 'product_aware',  label: 'Product-aware — 제품 인지' },
    { value: 'ready_to_buy',   label: 'Ready-to-buy — 구매 준비' },
  ],
};

// ─── Built-in Templates (P.D.A 기반 재설계) ─────────────────
// 각 템플릿은 Persona × Desire × Awareness 조합이 고유하게 설계됨
// Andromeda 의미론적 다양성 확보 목적
const BUILT_IN_TEMPLATES = {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Meta — P.D.A 8종 (조합 중복 없음)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // [1] 바쁜 직장인 × 효율 × 문제 인식
  // 프레임: 문제 제기 → 시간 절약 해결책 제시
  'meta-busy-efficiency-problem': {
    name: '{{product}} — 바쁜 일상 솔루션',
    platform: 'meta',
    headline: '{{product}}, 딱 {{time}}분이면 됩니다',
    description: '복잡한 거 필요 없어요. {{benefit}}.',
    bodyText: '하루 종일 바쁘신가요?\n\n{{product}}은 {{time}}분이면 충분합니다.\n\n{{benefit}}\n\n복잡한 과정 없이, 지금 바로 시작하세요.',
    cta: 'LEARN_MORE',
    variables: ['product', 'time', 'benefit'],
    persona_tag: 'busy_professional',
    desire_tag: 'efficiency',
    awareness_stage: 'problem_aware',
    example: {
      product: '스마트 가계부',
      time: '3',
      benefit: '자동 분류로 한 달 지출이 한눈에',
    },
  },

  // [2] 트렌드 팔로워 × 사회적 인정 × 문제 인식 전
  // 프레임: 인지 심기 → "요즘 다들" 사회증거
  'meta-trend-social-unaware': {
    name: '{{product}} — 요즘 뜨는 이유',
    platform: 'meta',
    headline: '요즘 {{target}}들이 선택하는 {{product}}',
    description: '{{count}}명이 먼저 경험했습니다.',
    bodyText: '{{hook}}\n\n{{brand}}의 {{product}}, 이미 {{count}}명이 선택했습니다.\n\n{{social_proof}}',
    cta: 'LEARN_MORE',
    variables: ['product', 'brand', 'target', 'count', 'hook', 'social_proof'],
    persona_tag: 'trend_follower',
    desire_tag: 'social_recognition',
    awareness_stage: 'unaware',
    example: {
      product: '무선 이어버드',
      brand: 'SoundX',
      target: 'MZ세대',
      count: '20만',
      hook: '아직도 유선 이어폰 쓰세요?',
      social_proof: '유튜버 100인 추천 · 올해의 제품 수상',
    },
  },

  // [3] 절약형 소비자 × 가성비 × 해결책 탐색
  // 프레임: 비교 → 동일 품질 더 저렴하게
  'meta-budget-saving-solution': {
    name: '{{product}} — 가격 비교 끝',
    platform: 'meta',
    headline: '{{category}}, {{brand}}이 {{discount}}% 더 저렴한 이유',
    description: '동일 품질, {{discount}}% 저렴하게.',
    bodyText: '{{category}} 찾고 계신가요?\n\n{{brand}} {{product}}은 타 브랜드 대비 {{discount}}% 저렴하면서 {{quality_proof}}.\n\n{{benefit}}',
    cta: 'SHOP_NOW',
    variables: ['product', 'brand', 'category', 'discount', 'quality_proof', 'benefit'],
    persona_tag: 'budget_conscious',
    desire_tag: 'saving',
    awareness_stage: 'solution_aware',
    example: {
      product: '프로틴 쉐이크',
      brand: 'NutriLab',
      category: '운동 보충제',
      discount: '35',
      quality_proof: 'GMP 인증 동일 성분',
      benefit: '무료 배송 + 첫 구매 추가 10% 할인',
    },
  },

  // [4] 육아 부모 × 안전·신뢰 × 해결책 탐색
  // 프레임: 검증/인증 강조 → 안심 구매
  'meta-parent-trust-solution': {
    name: '{{product}} — 검증된 선택',
    platform: 'meta',
    headline: '{{cert}}. 아이도 안심, 부모도 안심',
    description: '{{brand}} {{product}} — {{trust_point}}',
    bodyText: '가족에게 쓸 거라면 확실히 검증된 것만.\n\n{{product}}은 {{cert}}.\n\n{{trust_point}}\n\n{{social_proof}}',
    cta: 'LEARN_MORE',
    variables: ['product', 'brand', 'cert', 'trust_point', 'social_proof'],
    persona_tag: 'tired_parent',
    desire_tag: 'safety_trust',
    awareness_stage: 'solution_aware',
    example: {
      product: '유아 세제',
      brand: 'PureHome',
      cert: 'KC인증 · 피부과 테스트 완료',
      trust_point: '형광증백제 · 방부제 無',
      social_proof: '소아과 의사 98% 추천',
    },
  },

  // [5] 건강 관심층 × 성취 × 문제 인식
  // 프레임: 비포/애프터 → 변화와 성취
  'meta-health-achievement-problem': {
    name: '{{product}} — {{period}} 변화',
    platform: 'meta',
    headline: '{{period}} 후, {{result}}',
    description: '{{product}}로 시작한 변화.',
    bodyText: '{{pain_point}}\n\n{{product}}를 시작한 {{period}} 후,\n\n{{result}}\n\n{{social_proof}}\n\n지금 시작하면 {{benefit}}.',
    cta: 'SIGN_UP',
    variables: ['product', 'period', 'result', 'pain_point', 'social_proof', 'benefit'],
    persona_tag: 'health_seeker',
    desire_tag: 'achievement',
    awareness_stage: 'problem_aware',
    example: {
      product: '인터벌 트레이닝 앱',
      period: '4주',
      result: '체지방 3kg 감량',
      pain_point: '운동 시작이 어려우셨나요?',
      social_proof: '실제 사용자 87%가 목표 달성',
      benefit: '첫 달 무료 체험',
    },
  },

  // [6] 절약형 소비자 × 가성비 × 구매 준비
  // 프레임: 리타겟팅 → 마지막 인센티브로 전환
  'meta-budget-saving-retarget': {
    name: '{{product}} — 마지막 기회',
    platform: 'meta',
    headline: '{{product}}, 아직 고민 중이신가요?',
    description: '지금 결정하시면 {{incentive}}.',
    bodyText: '{{product}}을(를) 살펴보셨군요.\n\n결정이 어려우셨다면, 지금이 바로 그 이유입니다.\n\n{{incentive}}\n\n{{urgency}}',
    cta: 'SHOP_NOW',
    variables: ['product', 'incentive', 'urgency'],
    persona_tag: 'budget_conscious',
    desire_tag: 'saving',
    awareness_stage: 'ready_to_buy',
    example: {
      product: '공기청정기',
      incentive: '추가 10% 할인 + 필터 1년치 증정',
      urgency: '이 혜택은 오늘 자정까지만 유효합니다.',
    },
  },

  // [7] 바쁜 직장인 × 효율 × 해결책 탐색
  // 프레임: 경쟁 비교 → 가장 빠른 방법으로 포지셔닝
  'meta-busy-efficiency-solution': {
    name: '{{product}} — 가장 빠른 방법',
    platform: 'meta',
    headline: '{{category}}, {{product}}이 가장 빠릅니다',
    description: '{{compare_point}}. {{brand}} 검증 완료.',
    bodyText: '{{category}} 방법 찾고 계신가요?\n\n{{product}}은 {{compare_point}}.\n\n{{benefit}}\n\n{{brand}} 사용자 평균 {{time_save}} 절약.',
    cta: 'LEARN_MORE',
    variables: ['product', 'brand', 'category', 'compare_point', 'benefit', 'time_save'],
    persona_tag: 'busy_professional',
    desire_tag: 'efficiency',
    awareness_stage: 'solution_aware',
    example: {
      product: 'AI 일정 관리 앱',
      brand: 'CalSync',
      category: '일정 관리',
      compare_point: '기존 캘린더 앱보다 설정 70% 간소화',
      benefit: '회의 자동 분류 · 알림 자동 설정',
      time_save: '주 3시간',
    },
  },

  // [8] 트렌드 팔로워 × 사회적 인정 × 제품 인지
  // 프레임: 사회증거 집중 → 이미 많이 쓰는데 왜 안 써?
  'meta-trend-social-product': {
    name: '{{product}} — {{count}}명의 선택',
    platform: 'meta',
    headline: '이미 {{count}}명. 아직 안 써보셨나요?',
    description: '{{brand}} {{product}} — {{rating}}점 만족도',
    bodyText: '{{product}}을 경험한 {{count}}명의 공통된 말.\n\n"{{review}}"\n\n{{brand}} {{rating}}점 · {{award}}',
    cta: 'SHOP_NOW',
    variables: ['product', 'brand', 'count', 'rating', 'review', 'award'],
    persona_tag: 'trend_follower',
    desire_tag: 'social_recognition',
    awareness_stage: 'product_aware',
    example: {
      product: '미니멀 다이어리',
      brand: 'Daysign',
      count: '15만',
      rating: '4.9',
      review: '쓰다 보면 하루가 정리돼요',
      award: '2025 굿디자인 수상',
    },
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Google — 검색 의도 기반 2종
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // 절약형 × 가성비 × 해결책 탐색 (검색: "저렴한 ~", "비교")
  'google-budget-search': {
    name: '{{product}} 가성비 검색광고',
    platform: 'google',
    headline: '{{product}} 최저가 {{discount}}%|{{brand}} 공식 최저가 보장|{{benefit}} 포함|무료 배송 오늘 출발',
    description: '{{product}} {{discount}}% 할인 중. {{benefit}}. 타사 대비 {{quality_proof}}.|{{urgency}} — {{brand}} 공식몰 정품 보장, 빠른 배송.',
    bodyText: '',
    cta: '',
    variables: ['product', 'brand', 'discount', 'benefit', 'quality_proof', 'urgency'],
    persona_tag: 'budget_conscious',
    desire_tag: 'saving',
    awareness_stage: 'solution_aware',
    example: {
      product: '러닝화',
      brand: 'SpeedRun',
      discount: '30',
      benefit: '사은품 증정',
      quality_proof: '동일 스펙 30% 저렴',
      urgency: '오늘만 이 가격',
    },
  },

  // 건강 관심층 × 성취 × 제품 인지 (검색: "~ 효과", "~ 추천")
  'google-health-achievement-pmax': {
    name: '{{product}} 성과 기반 광고',
    platform: 'google',
    headline: '{{product}} {{period}} 효과|{{count}}명 검증 완료|{{result}} 달성|{{brand}} 공식몰',
    description: '{{product}} 사용 {{period}} 후 {{result}}. {{count}}명 실사용 후기. {{brand}} 공식몰에서 정품 구매.|{{social_proof}} — 지금 시작하면 {{benefit}}.',
    bodyText: '',
    cta: '',
    variables: ['product', 'brand', 'period', 'result', 'count', 'social_proof', 'benefit'],
    persona_tag: 'health_seeker',
    desire_tag: 'achievement',
    awareness_stage: 'product_aware',
    example: {
      product: '마그네슘 보충제',
      brand: 'NutriMax',
      period: '2주',
      result: '수면 질 개선',
      count: '3만',
      social_proof: '약사 추천 1위',
      benefit: '첫 구매 20% 할인',
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
        persona_tag      TEXT,
        desire_tag       TEXT,
        awareness_stage  TEXT,
        created_at       TEXT DEFAULT (datetime('now'))
      );
    `);
    // Migrate existing DB (adds columns if they don't exist yet)
    for (const col of ['persona_tag', 'desire_tag', 'awareness_stage']) {
      try { db.exec(`ALTER TABLE copy_templates ADD COLUMN ${col} TEXT`); } catch {}
    }
  }

  _seedBuiltIns() {
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO copy_templates
        (id, platform, name, headline, description, body_text, cta, variables_json, example_json, is_builtin, persona_tag, desire_tag, awareness_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const [id, tpl] of Object.entries(BUILT_IN_TEMPLATES)) {
        upsert.run(id, tpl.platform, tpl.name, tpl.headline, tpl.description,
          tpl.bodyText, tpl.cta, JSON.stringify(tpl.variables), JSON.stringify(tpl.example),
          tpl.persona_tag || null, tpl.desire_tag || null, tpl.awareness_stage || null);
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
  createTemplate({ id, platform, name, headline, description, bodyText, cta, variables, example, persona_tag, desire_tag, awareness_stage }) {
    db.prepare(`
      INSERT INTO copy_templates (id, platform, name, headline, description, body_text, cta, variables_json, example_json, is_builtin, persona_tag, desire_tag, awareness_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, platform, name, headline, description, bodyText || '', cta || '',
      JSON.stringify(variables), JSON.stringify(example || {}),
      persona_tag || null, desire_tag || null, awareness_stage || null);

    logger.info('Custom template created', { id, platform, persona_tag, desire_tag, awareness_stage });
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
