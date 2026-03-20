/**
 * OpenClaw Skill: Ad Manager
 *
 * Registers natural-language commands for managing ads
 * via Slack, Telegram, or any OpenClaw-connected channel.
 *
 * Usage in chat:
 *   "오늘 광고 성과 알려줘"
 *   "Meta 캠페인 예산 50만원으로 변경해줘"
 *   "Google Ads 캠페인 일시중지 해줘"
 *   "주간 리포트 보여줘"
 *   "예산 최적화 제안해줘"
 *
 * Content Commands:
 *   "봄 세일 광고 등록해줘"
 *   "A/B 테스트 만들어줘"
 *   "템플릿 목록 보여줘"
 *   "오디언스 만들어줘"
 *   "크리에이티브 목록"
 */
import { getOptimizer, getPipeline, getABTestEngine, getAudienceManager, getTemplateEngine } from '../utils/services.js';
import { getAdapter } from '../utils/platform-adapter.js';
import { getIntentClassifier, INTENT_DEFINITIONS } from '../utils/intent-classifier.js';
import { krwFmt } from '../utils/format.js';
import db from '../utils/db.js';
import logger from '../utils/logger.js';

/** Pre-compiled platform detection patterns (avoid per-call regex compilation) */
const PLATFORM_PATTERNS = [
  { pattern: /tiktok|틱톡/i, platform: 'tiktok' },
  { pattern: /meta|메타/i, platform: 'meta' },
  { pattern: /google|구글/i, platform: 'google' },
];

export const SKILL_MANIFEST = {
  name: 'ad-manager',
  description: '광고 캠페인 관리 및 성과 분석',
  version: '1.1.0',
  // Commands auto-derived from the single source of truth (INTENT_DEFINITIONS)
  commands: INTENT_DEFINITIONS.map(i => ({
    intent: i.intent,
    handler: i.handler,
    description: i.description,
  })),
};

export class AdManagerSkill {
  constructor() {
    this.optimizer = getOptimizer();
    this.pipeline = getPipeline();
    this.abEngine = getABTestEngine();
    this.audiences = getAudienceManager();
    this.templates = getTemplateEngine();
  }

  /** Route incoming message via intent classification (TF-IDF + cosine similarity) */
  async handleMessage(message, context) {
    const classifier = getIntentClassifier();
    const result = classifier.classify(message);

    if (result && result.confidence >= 0.15 && typeof this[result.handler] === 'function') {
      logger.info('Intent classified', {
        intent: result.intent,
        confidence: result.confidence,
        alternatives: result.alternatives?.length || 0,
      });
      return this[result.handler](message, context);
    }

    // Fallback: show available commands with intent descriptions
    const intents = classifier.getIntentNames();
    const cmdList = intents.map(i => `• ${i.description}`).join('\n');
    return `죄송합니다, 요청을 이해하지 못했습니다.\n\n사용 가능한 명령어:\n${cmdList}\n\n예시: "오늘 광고 성과 알려줘", "예산 50만원으로 변경", "캠페인 일시중지"`;
  }

  /** 성과 조회 */
  async handlePerformance(message, context) {
    const days = this._extractDays(message) || 1;
    const report = await this.optimizer.generateReport(days);
    return report;
  }

  /** 예산 변경 */
  async handleBudgetChange(message, context) {
    const { campaignName, amount, platform } = this._parseBudgetCommand(message);
    if (!campaignName || !amount) {
      return '형식: "[캠페인명] 예산 [금액]원으로 변경" (예: "봄 프로모션 예산 50만원으로 변경")';
    }

    // Find campaign in DB
    const campaign = db.prepare(
      `SELECT * FROM campaigns WHERE name LIKE ? ${platform ? "AND platform = ?" : ""}`
    ).get(`%${campaignName}%`, ...(platform ? [platform] : []));

    if (!campaign) return `"${campaignName}" 캠페인을 찾을 수 없습니다.`;

    // Execute budget change via platform adapter
    try {
      await getAdapter(campaign.platform).updateBudget(campaign.platform_id, amount);

      // Log the change
      db.prepare(
        `INSERT INTO budget_history (campaign_id, old_budget, new_budget, reason, triggered_by)
         VALUES (?, ?, ?, ?, ?)`
      ).run(campaign.id, campaign.daily_budget, amount, 'chat_command', context?.user || 'unknown');

      return `✅ ${campaign.name} (${campaign.platform}) 예산: ₩${krwFmt.format(campaign.daily_budget || 0)} → ₩${krwFmt.format(amount)}`;
    } catch (err) {
      logger.error('Budget change failed', { error: err.message });
      return `❌ 예산 변경 실패: ${err.message}`;
    }
  }

  /** 캠페인 일시중지 */
  async handlePause(message) {
    return this._setCampaignStatus(message, 'PAUSED', '⏸️', '일시중지됨');
  }

  /** 캠페인 활성화 */
  async handleEnable(message) {
    return this._setCampaignStatus(message, 'ACTIVE', '▶️', '활성화됨');
  }

  /** 공통 캠페인 상태 변경 헬퍼 */
  async _setCampaignStatus(message, status, icon, label) {
    const campaignName = this._extractCampaignName(message);
    const campaign = db.prepare(`SELECT * FROM campaigns WHERE name LIKE ?`).get(`%${campaignName}%`);
    if (!campaign) return `"${campaignName}" 캠페인을 찾을 수 없습니다.`;

    try {
      await getAdapter(campaign.platform).setStatus(campaign.platform_id, status);
      db.prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(status, campaign.id);
      return `${icon} ${campaign.name} (${campaign.platform}) ${label}`;
    } catch (err) {
      return `❌ ${label} 실패: ${err.message}`;
    }
  }

  /** 예산 최적화 추천 */
  async handleOptimize(message) {
    const totalBudget = this._extractAmount(message) || this._getCurrentTotalBudget();
    const plan = this.optimizer.getReallocationPlan(totalBudget);

    if (plan.campaigns.length === 0) return '활성 캠페인이 없어 최적화를 수행할 수 없습니다.';

    let response = `💡 *예산 최적화 추천* (총 ₩${krwFmt.format(totalBudget)})\n\n`;
    for (const c of plan.campaigns) {
      const arrow = c.change > 0 ? '⬆️' : c.change < 0 ? '⬇️' : '➡️';
      response += `${arrow} ${c.name} (${c.platform})\n`;
      response += `   현재: ₩${krwFmt.format(c.currentBudget)} → 추천: ₩${krwFmt.format(c.recommendedBudget)} (ROAS: ${c.roas})\n`;
    }
    response += '\n적용하시겠습니까? "적용" 이라고 답변해주세요.';

    return response;
  }

  /** 캠페인 목록 */
  async handleListCampaigns() {
    const campaigns = db.prepare(
      `SELECT * FROM campaigns ORDER BY platform, status, name`
    ).all();

    if (campaigns.length === 0) return '등록된 캠페인이 없습니다.';

    let response = `📋 *전체 캠페인 (${campaigns.length}개)*\n\n`;
    let currentPlatform = '';
    for (const c of campaigns) {
      if (c.platform !== currentPlatform) {
        currentPlatform = c.platform;
        const platformLabel = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' }[currentPlatform] || currentPlatform;
        response += `*${platformLabel} Ads*\n`;
      }
      const statusIcon = c.status === 'ACTIVE' ? '🟢' : '🟡';
      response += `${statusIcon} ${c.name} | ₩${krwFmt.format(c.daily_budget || 0)}/일\n`;
    }
    return response;
  }

  /** 최근 알림 조회 */
  async handleAlerts() {
    const alerts = db.prepare(
      `SELECT a.*, c.name as campaign_name FROM alerts a
       LEFT JOIN campaigns c ON a.campaign_id = c.id
       ORDER BY a.created_at DESC LIMIT 10`
    ).all();

    if (alerts.length === 0) return '최근 알림이 없습니다.';

    let response = `🔔 *최근 알림 (${alerts.length}건)*\n\n`;
    for (const a of alerts) {
      const icon = a.severity === 'critical' ? '🚨' : a.severity === 'warning' ? '⚠️' : 'ℹ️';
      response += `${icon} ${a.message}\n   ${a.created_at}\n\n`;
    }
    return response;
  }

  // ─── Content Commands ──────────────────────────────────────

  /** 새 광고 등록 */
  async handleCreateAd(message) {
    const platform = this._detectPlatform(message);
    if (!platform) {
      return '플랫폼을 지정해주세요. 예: "Meta 봄 세일 광고 등록해줘"\n\n사용 가능한 템플릿:\n' + this._templateList();
    }

    return `광고 등록을 진행하려면 아래 정보를 알려주세요:\n\n` +
      `1. 템플릿: ${this._templateList()}\n` +
      `2. 캠페인명 (기존 캠페인에 연결)\n` +
      `3. 랜딩 URL\n` +
      `4. 이미지 파일 경로 (선택)\n\n` +
      `예: "meta-sale 템플릿으로, 봄 프로모션 캠페인에, product=운동화 discount=30 benefit=무료배송, 랜딩 https://shop.com/spring"`;
  }

  /** 템플릿 목록/미리보기 */
  async handleListTemplates(message) {
    const templates = this.templates.listTemplates();
    if (templates.length === 0) return '등록된 템플릿이 없습니다.';

    let response = `📝 *카피 템플릿 (${templates.length}개)*\n\n`;
    for (const t of templates) {
      const vars = JSON.parse(t.variables_json || '[]');
      response += `*${t.id}* (${t.platform})\n`;
      response += `  ${t.name}\n`;
      response += `  변수: ${vars.join(', ')}\n\n`;
    }

    // If specific template mentioned, show preview
    const templateMatch = message.match(/(?:미리보기|preview)\s+(\S+)/);
    if (templateMatch) {
      const preview = this.templates.preview(templateMatch[1]);
      if (preview) {
        response += `\n---\n📋 *${templateMatch[1]} 미리보기*\n`;
        response += `제목: ${preview.headline}\n`;
        response += `설명: ${preview.description}\n`;
        response += `본문: ${preview.bodyText}\n`;
      }
    }

    return response;
  }

  /** A/B 테스트 */
  async handleABTest(message) {
    if (message.includes('목록') || message.includes('list')) {
      const tests = this.abEngine.getTests();
      if (tests.length === 0) return '진행 중인 A/B 테스트가 없습니다.';

      let response = `🔬 *A/B 테스트 (${tests.length}개)*\n\n`;
      for (const t of tests) {
        const variants = JSON.parse(t.variants_json || '[]');
        const icon = t.status === 'RUNNING' ? '🟢' : t.status === 'COMPLETED' ? '✅' : '⏸️';
        response += `${icon} ${t.name} (${t.platform})\n`;
        response += `   변형: ${variants.length}개 | 상태: ${t.status}\n`;
        if (t.winner_id) response += `   승자: ${t.winner_id}\n`;
        response += '\n';
      }
      return response;
    }

    return `A/B 테스트를 만들려면 아래 정보를 알려주세요:\n\n` +
      `1. 테스트명\n` +
      `2. 기본 템플릿 (예: meta-sale)\n` +
      `3. 테스트할 변형 (예: discount=20,30,40 benefit=무료배송,사은품)\n` +
      `4. 타겟 캠페인/애드셋\n\n` +
      `예: "A/B 테스트 '봄 할인율 테스트' meta-sale discount=20,30,40"`;
  }

  /** 오디언스 관리 */
  async handleAudience(message) {
    if (message.includes('목록') || message.includes('list')) {
      const audiences = this.audiences.getAudiences();
      if (audiences.length === 0) return '등록된 오디언스가 없습니다.';

      let response = `👥 *오디언스 (${audiences.length}개)*\n\n`;
      for (const a of audiences) {
        const pIcon = { meta: '🔵', google: '🟡', tiktok: '🎵' }[a.platform] || '⚪';
        response += `${pIcon} ${a.name}\n`;
        response += `   유형: ${a.type} | 소스: ${a.source}\n\n`;
      }
      return response;
    }

    if (message.includes('프리셋') || message.includes('preset')) {
      const presets = this.audiences.getTargetingPresets();
      let response = `🎯 *타겟팅 프리셋*\n\n`;
      for (const [id, p] of Object.entries(presets)) {
        response += `*${id}*: ${p.name}\n`;
      }
      return response;
    }

    return `오디언스를 만들려면 유형을 선택해주세요:\n\n` +
      `1. *픽셀 기반*: "픽셀 오디언스 만들어줘 [이름] [기간일수]"\n` +
      `2. *고객 리스트*: "고객리스트 오디언스 [이름]" + 이메일 목록\n` +
      `3. *유사 타겟*: "유사 오디언스 [원본ID] [비율]"\n` +
      `4. *프리셋 조회*: "타겟팅 프리셋"`;
  }

  /** 크리에이티브 목록 */
  async handleListCreatives(message) {
    const platform = this._detectPlatform(message);
    const creatives = this.pipeline.getCreatives(platform ? { platform } : {});

    if (creatives.length === 0) return '등록된 크리에이티브가 없습니다.';

    let response = `🎨 *크리에이티브 (${creatives.length}개)*\n\n`;
    for (const c of creatives) {
      const icon = c.status === 'ACTIVE' ? '🟢' : c.status === 'UPLOADED' ? '🔵' : c.status === 'DRAFT' ? '📝' : '⏸️';
      response += `${icon} ${c.name} (${c.platform})\n`;
      response += `   제목: ${c.headline || '-'}\n`;
      response += `   상태: ${c.status}${c.ab_group ? ` | A/B: ${c.ab_group}` : ''}\n\n`;
    }
    return response;
  }

  _templateList() {
    const templates = this.templates.listTemplates();
    return templates.map(t => `\`${t.id}\``).join(', ') || '(없음)';
  }

  // ─── Helper Parsers ────────────────────────────────────────

  _extractDays(message) {
    const match = message.match(/(\d+)\s*(일|days?)/i);
    if (match) return parseInt(match[1]);
    if (message.includes('주간') || message.includes('week')) return 7;
    if (message.includes('월간') || message.includes('month')) return 30;
    return null;
  }

  _extractAmount(message) {
    const match = message.match(/([\d,]+)\s*(만\s*)?원/);
    if (!match) return null;
    const num = parseInt(match[1].replace(/,/g, ''));
    return match[2] ? num * 10000 : num;
  }

  _extractCampaignName(message) {
    // Remove command keywords and extract the campaign name
    return message
      .replace(/(일시중지|중지|정지|활성화|재개|pause|enable|resume)/gi, '')
      .replace(/(meta|google|tiktok|메타|구글|틱톡)/gi, '')
      .trim()
      .replace(/['"]/g, '');
  }

  /** Detect platform from message text */
  _detectPlatform(message) {
    for (const { pattern, platform } of PLATFORM_PATTERNS) {
      if (pattern.test(message)) return platform;
    }
    return null;
  }

  _parseBudgetCommand(message) {
    const amount = this._extractAmount(message);
    const platform = this._detectPlatform(message);

    // Try structured patterns first:
    //   "[캠페인명] 예산 [금액]원으로 변경"
    //   "예산 [금액]원으로 [캠페인명]"
    //   Quoted campaign name: "'봄 프로모션' 예산 변경 50만원"
    const quotedMatch = message.match(/['"]([^'"]+)['"]/);
    if (quotedMatch) {
      return { campaignName: quotedMatch[1].trim(), amount, platform };
    }

    // Pattern: [캠페인명] 예산 ...
    const beforeBudget = message.match(/^(.+?)\s*예산/);
    if (beforeBudget) {
      const name = beforeBudget[1]
        .replace(/(meta|google|tiktok|메타|구글|틱톡)/gi, '')
        .trim();
      if (name.length > 0) {
        return { campaignName: name, amount, platform };
      }
    }

    // Fallback: strip all known keywords and amounts
    const campaignName = message
      .replace(/(예산|변경|수정|조정|으로|해줘|해주세요|부탁)/g, '')
      .replace(/([\d,]+)\s*(만\s*)?원/g, '')
      .replace(/(meta|google|tiktok|메타|구글|틱톡)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { campaignName: campaignName || null, amount, platform };
  }

  _getCurrentTotalBudget() {
    const result = db.prepare(
      `SELECT SUM(daily_budget) as total FROM campaigns WHERE status = 'ACTIVE'`
    ).get();
    return result?.total || 1000000;
  }
}

export default AdManagerSkill;
