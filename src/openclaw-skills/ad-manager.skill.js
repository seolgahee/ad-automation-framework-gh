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
import Anthropic from '@anthropic-ai/sdk';

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

  /** Claude API로 자연어 메시지 처리 (tool use 지원) */
  async handleMessage(message, context) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return this._keywordFallback(message, context);
    }

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const today = new Date().toISOString().split('T')[0];

      const tools = [
        {
          name: 'get_overview',
          description: '특정 기간/플랫폼의 KPI 요약 (지출, ROAS, 전환수 등). 전체 성과 파악에 사용.',
          input_schema: {
            type: 'object',
            properties: {
              since: { type: 'string', description: 'YYYY-MM-DD 시작일' },
              until: { type: 'string', description: 'YYYY-MM-DD 종료일' },
              platform: { type: 'string', enum: ['meta', 'google', 'naver'], description: '플랫폼' },
            },
            required: ['since', 'until', 'platform'],
          },
        },
        {
          name: 'get_daily_timeline',
          description: '일별 성과 시계열 데이터. 날짜별 추이 비교, ROAS 변동 분석에 사용.',
          input_schema: {
            type: 'object',
            properties: {
              since: { type: 'string', description: 'YYYY-MM-DD 시작일' },
              until: { type: 'string', description: 'YYYY-MM-DD 종료일' },
              platform: { type: 'string', enum: ['meta', 'google', 'naver'] },
            },
            required: ['since', 'until', 'platform'],
          },
        },
        {
          name: 'get_ad_performance',
          description: '소재(Ad)별 성과 데이터. 소재 비교, 상위/하위 소재 분석에 사용. 특정 상품코드나 소재명이 언급된 경우 반드시 name_filter를 지정할 것.',
          input_schema: {
            type: 'object',
            properties: {
              since: { type: 'string', description: 'YYYY-MM-DD 시작일' },
              until: { type: 'string', description: 'YYYY-MM-DD 종료일' },
              platform: { type: 'string', enum: ['meta', 'google'] },
              sort: { type: 'string', enum: ['spend', 'roas', 'ctr', 'conversions'], description: '정렬 기준' },
              name_filter: { type: 'string', description: '소재명 키워드 필터 (예: "DXSH5336N"). 지정 시 해당 키워드가 포함된 소재만 반환.' },
            },
            required: ['since', 'until', 'platform'],
          },
        },
        {
          name: 'get_campaign_performance',
          description: '캠페인별 성과 데이터 조회 (노출, 클릭, 지출, 전환, ROAS, CPA 등). 예산 조정 추천 시 반드시 이 툴을 사용할 것. get_overview 대신 사용.',
          input_schema: {
            type: 'object',
            properties: {
              since:    { type: 'string', description: 'YYYY-MM-DD 시작일' },
              until:    { type: 'string', description: 'YYYY-MM-DD 종료일' },
              platform: { type: 'string', enum: ['meta', 'google'], description: '플랫폼' },
            },
            required: ['since', 'until', 'platform'],
          },
        },
        {
          name: 'get_campaigns',
          description: '캠페인 목록과 현재 예산 조회. campaign_id 확인 시 사용.',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'update_budget',
          description: '캠페인 일일예산 변경. 반드시 get_campaigns로 campaign_id를 먼저 확인한 후 호출할 것.',
          input_schema: {
            type: 'object',
            properties: {
              platform:      { type: 'string', enum: ['meta'], description: '플랫폼 (현재 Meta만 지원)' },
              campaign_id:   { type: 'string', description: '변경할 캠페인 ID' },
              campaign_name: { type: 'string', description: '변경할 캠페인명 (응답 확인용)' },
              daily_budget:  { type: 'number', description: '새 일일예산 (원 단위, 예: 500000)' },
            },
            required: ['platform', 'campaign_id', 'campaign_name', 'daily_budget'],
          },
        },
      ];

      const messages = [{ role: 'user', content: message }];
      const systemPrompt = `당신은 광고 성과 분석 AI 어시스턴트입니다. 오늘은 ${today}입니다.
질문에 답하기 위해 필요한 데이터를 tool을 통해 먼저 조회하세요.
답변은 간결하고 핵심만 전달하세요. 숫자는 한국어 형식(₩, 쉼표 구분)으로 표기하세요.
데이터 없이 추측하지 말고, tool 조회 결과를 기반으로 답변하세요.

[광고 소재 네이밍 규칙]
소재명 형식: [상품코드]_[소재타입]_[버전] 또는 [상품코드]가 포함된 형태
예: DXSH5336N_이미지_v1, DXSH3115N_동영상_A, [상품코드]_카탈로그

[필터링 규칙 — 반드시 준수]
- 사용자가 특정 상품코드(예: DXSH5336N, DXSH3115N 등 영문+숫자 조합)를 언급하면
  get_ad_performance 호출 시 name_filter에 해당 코드를 반드시 지정할 것
- tool 결과에서 name_filter와 무관한 소재 데이터를 섞어서 집계하지 말 것
- 필터링 후 결과가 없으면 "해당 상품코드의 소재를 찾을 수 없습니다"로 답변할 것
- 전체 계정 합산 수치를 특정 상품의 성과로 오인하여 답변하지 말 것

[예산 변경 규칙 — 반드시 준수]
- 예산 변경 요청 시 반드시 get_campaigns를 먼저 호출해 campaign_id를 확인한 후 update_budget을 호출할 것
- 캠페인명이 부정확하거나 여러 개 일치하는 경우 사용자에게 확인을 요청할 것
- 변경 완료 후 "캠페인명 / 기존예산 → 새예산" 형태로 결과를 명확히 알릴 것
- 예산 단위는 항상 원(₩) 기준이며, "50만원" = 500000원으로 해석할 것

[캠페인별 예산 조정 추천 워크플로우]
사용자가 "캠페인별 성과 요약 + 예산 조정 추천"을 요청하면:
1. get_campaign_performance로 기간별 캠페인 성과 조회
2. 각 캠페인의 ROAS, 전환수, 지출 기준으로 아래 기준 적용:
   - ROAS 3.0 이상 & 전환 5건 이상 → 예산 20~30% 증액 추천
   - ROAS 2.0~3.0 → 현행 유지 추천
   - ROAS 1.5 미만 또는 지출 10만 이상 & 전환 0 → 감액 또는 중단 추천
3. 추천 결과를 표 형태로 제시: 캠페인명 | 현재예산 | ROAS | 추천액 | 사유
4. 마지막에 "적용할 캠페인을 말씀해주세요" 안내
5. 사용자가 적용 요청 시 update_budget 실행`;

      // tool use 루프
      let response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        tools,
        messages,
      });

      while (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(b => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = await Promise.all(toolUses.map(async tu => {
          let result;
          try {
            result = await this._executeTool(tu.name, tu.input);
          } catch (e) {
            result = { error: e.message };
          }
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          };
        }));

        messages.push({ role: 'user', content: toolResults });

        response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: systemPrompt,
          tools,
          messages,
        });
      }

      return response.content.find(b => b.type === 'text')?.text || '응답을 받지 못했습니다.';
    } catch (e) {
      logger.error('Claude API error', { error: e.message });
      return this._keywordFallback(message, context);
    }
  }

  /** Tool 실행 */
  async _executeTool(name, input) {
    const { getMetaClient, getGoogleClient, getNaverClient } = await import('../utils/clients.js');
    const today = new Date().toISOString().split('T')[0];
    const since = input.since || today;
    const until = input.until || today;

    if (name === 'get_overview') {
      const platform = input.platform;
      if (platform === 'meta') {
        const meta = getMetaClient();
        const rows = await meta.getInsights({ level: 'campaign', timeRange: { since, until } });
        const t = rows.reduce((a, r) => ({
          spend: a.spend + r.spend, conversions: a.conversions + r.conversions,
          value: a.value + r.conversionValue, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks,
        }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });
        return { platform, since, until, ...t,
          roas: t.spend > 0 ? t.value / t.spend : 0,
          cpc: t.clicks > 0 ? t.spend / t.clicks : 0,
          ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
        };
      }
      if (platform === 'google') {
        const google = getGoogleClient();
        const rows = await google.getPerformance({ dateFrom: since, dateTo: until });
        const t = rows.reduce((a, r) => ({
          spend: a.spend + r.spend, conversions: a.conversions + r.conversions,
          value: a.value + r.conversionValue, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks,
        }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });
        return { platform, since, until, ...t,
          roas: t.spend > 0 ? t.value / t.spend : 0,
        };
      }
      if (platform === 'naver') {
        const naver = getNaverClient();
        const rows = await naver.getInsights({ dateFrom: since, dateTo: until });
        const t = rows.reduce((a, r) => ({
          spend: a.spend + r.spend, conversions: a.conversions + r.conversions,
          value: a.value + r.conversionValue, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks,
        }), { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });
        return { platform, since, until, ...t };
      }
    }

    if (name === 'get_daily_timeline') {
      const platform = input.platform;
      if (platform === 'meta') {
        const meta = getMetaClient();
        const rows = await meta.getInsights({ level: 'campaign', timeRange: { since, until }, timeIncrement: 1 });
        const byDate = new Map();
        for (const r of rows) {
          const date = r.dateStart || until;
          if (!byDate.has(date)) byDate.set(date, { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });
          const d = byDate.get(date);
          d.spend += r.spend; d.conversions += r.conversions; d.value += r.conversionValue;
          d.impressions += r.impressions; d.clicks += r.clicks;
        }
        return [...byDate.entries()].sort().map(([date, d]) => ({
          date, platform, ...d,
          roas: d.spend > 0 ? d.value / d.spend : 0,
          cpc:  d.clicks > 0 ? d.spend / d.clicks : 0,
          ctr:  d.impressions > 0 ? (d.clicks / d.impressions) * 100 : 0,
        }));
      }
      if (platform === 'google') {
        const google = getGoogleClient();
        const rows = await google.getPerformance({ dateFrom: since, dateTo: until });
        const byDate = new Map();
        for (const r of rows) {
          const date = r.date || until;
          if (!byDate.has(date)) byDate.set(date, { spend: 0, conversions: 0, value: 0, impressions: 0, clicks: 0 });
          const d = byDate.get(date);
          d.spend += r.spend; d.conversions += r.conversions; d.value += r.conversionValue;
          d.impressions += r.impressions; d.clicks += r.clicks;
        }
        return [...byDate.entries()].sort().map(([date, d]) => ({
          date, platform, ...d,
          roas: d.spend > 0 ? d.value / d.spend : 0,
        }));
      }
    }

    if (name === 'get_ad_performance') {
      const platform = input.platform;
      const sort = input.sort || 'spend';
      const nameFilter = input.name_filter ? input.name_filter.toLowerCase() : null;

      if (platform === 'meta') {
        const meta = getMetaClient();
        let rows = await meta.getAdInsights({ timeRange: { since, until } });
        if (nameFilter) rows = rows.filter(r => r.adName?.toLowerCase().includes(nameFilter));
        rows.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
        return rows.slice(0, 30).map(r => ({
          ad_name: r.adName, campaign_name: r.campaignName,
          spend: r.spend, roas: r.roas, ctr: r.ctr, cpc: r.cpc,
          conversions: r.conversions, impressions: r.impressions,
        }));
      }
      if (platform === 'google') {
        const google = getGoogleClient();
        let rows = await google.getAdInsights({ dateFrom: since, dateTo: until });
        if (nameFilter) rows = rows.filter(r => r.adName?.toLowerCase().includes(nameFilter));
        rows.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
        return rows.slice(0, 30).map(r => ({
          ad_name: r.adName, campaign_name: r.campaignName,
          spend: r.spend, roas: r.roas, ctr: r.ctr, conversions: r.conversions,
        }));
      }
    }

    if (name === 'get_campaign_performance') {
      const platform = input.platform;
      if (platform === 'meta') {
        const meta = getMetaClient();
        const rows = await meta.getInsights({ level: 'campaign', timeRange: { since, until } });
        // campaign 목록과 조인해서 현재 예산도 포함
        const campaigns = meta._configured ? await meta.getCampaigns(['ACTIVE', 'PAUSED']).catch(() => []) : [];
        const budgetMap = new Map(campaigns.map(c => [c.id, c.daily_budget ? c.daily_budget : null]));
        return rows
          .filter(r => r.impressions > 0)
          .sort((a, b) => b.spend - a.spend)
          .map(r => ({
            campaign_id:    r.campaignId,
            campaign_name:  r.campaignName,
            daily_budget:   budgetMap.get(r.campaignId) || null,
            impressions:    r.impressions,
            clicks:         r.clicks,
            spend:          r.spend,
            conversions:    r.conversions,
            conversion_value: r.conversionValue,
            roas:           parseFloat((r.roas || 0).toFixed(2)),
            ctr:            parseFloat((r.ctr || 0).toFixed(2)),
            cpc:            parseFloat((r.cpc || 0).toFixed(0)),
            cpa:            r.conversions > 0 ? parseFloat((r.spend / r.conversions).toFixed(0)) : null,
          }));
      }
      if (platform === 'google') {
        const google = getGoogleClient();
        const rows = await google.getPerformance({ dateFrom: since, dateTo: until });
        const byId = new Map();
        for (const r of rows) {
          if (!byId.has(r.campaignId)) {
            byId.set(r.campaignId, { campaign_id: r.campaignId, campaign_name: r.campaignName, impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 });
          }
          const c = byId.get(r.campaignId);
          c.impressions += r.impressions; c.clicks += r.clicks;
          c.spend += r.spend; c.conversions += r.conversions; c.conversionValue += r.conversionValue;
        }
        return [...byId.values()]
          .filter(c => c.impressions > 0)
          .sort((a, b) => b.spend - a.spend)
          .map(c => ({
            ...c,
            roas: parseFloat((c.spend > 0 ? c.conversionValue / c.spend : 0).toFixed(2)),
            ctr:  parseFloat((c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0).toFixed(2)),
            cpa:  c.conversions > 0 ? parseFloat((c.spend / c.conversions).toFixed(0)) : null,
          }));
      }
      return { error: '지원하지 않는 플랫폼입니다.' };
    }

    if (name === 'update_budget') {
      const { platform, campaign_id, campaign_name, daily_budget } = input;
      if (platform === 'meta') {
        const meta = getMetaClient();
        await meta.updateCampaign(campaign_id, { dailyBudget: daily_budget });
        logger.info('Budget updated via chat', { campaign_id, campaign_name, daily_budget });
        return {
          success: true,
          campaign_name,
          new_daily_budget: daily_budget,
          message: `${campaign_name} 일일예산이 ₩${daily_budget.toLocaleString()}으로 변경되었습니다.`,
        };
      }
      return { error: '현재 Meta 캠페인만 예산 변경을 지원합니다.' };
    }

    if (name === 'get_campaigns') {
      const meta = getMetaClient();
      const google = getGoogleClient();
      const [mc, gc] = await Promise.allSettled([
        meta._configured  ? meta.getCampaigns(['ACTIVE', 'PAUSED'])   : Promise.resolve([]),
        google._configured ? google.getCampaigns(['ENABLED', 'PAUSED']) : Promise.resolve([]),
      ]);
      return [
        ...(mc.value || []).map(c => ({ platform: 'meta',   campaign_id: c.id, name: c.name, status: c.effective_status || c.status, daily_budget: c.daily_budget || null })),
        ...(gc.value || []).map(c => ({ platform: 'google', campaign_id: String(c.id || ''), name: c.name, status: c.status, daily_budget: c.dailyBudget || null })),
      ];
    }

    return { error: `Unknown tool: ${name}` };
  }

  /** Claude API 키 없을 때 기존 키워드 방식 */
  async _keywordFallback(message, context) {
    const classifier = getIntentClassifier();
    const result = classifier.classify(message);
    if (result && result.confidence >= 0.15 && typeof this[result.handler] === 'function') {
      return this[result.handler](message, context);
    }
    const intents = classifier.getIntentNames();
    const cmdList = intents.map(i => `• ${i.description}`).join('\n');
    return `죄송합니다, 요청을 이해하지 못했습니다.\n\n사용 가능한 명령어:\n${cmdList}`;
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
