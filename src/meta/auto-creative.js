/**
 * Claude Vision 기반 Meta 광고 카피 자동 생성
 *
 * DB의 creative_library BLOB 이미지를 Claude Vision으로 분석하여
 * 광고 카피(본문, 헤드라인, 설명)를 자동 생성합니다.
 */
import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';

const SYSTEM_PROMPT = `당신은 한국 Meta(Facebook/Instagram) 광고 전문 카피라이터입니다.
이미지를 분석하여 광고 소재 카피를 한국어로 작성하세요.

반드시 아래 JSON 형식으로만 응답하고, 다른 텍스트는 절대 출력하지 마세요:
{
  "message": "광고 본문 — 감성적이고 클릭을 유도, 125자 이내",
  "headline": "헤드라인 — 핵심 메시지, 40자 이내",
  "description": "부가 설명 — 30자 이내"
}

작성 원칙:
- 상품/서비스의 핵심 가치를 즉시 전달
- 구매 욕구를 자극하는 감성 언어 사용
- 지나친 과장 없이 신뢰감 있게 작성
- 타겟 고객이 공감할 수 있는 표현 선택`;

/**
 * 이미지 버퍼 + 컨텍스트로 Meta 광고 카피 자동 생성
 *
 * @param {Buffer} imageBuffer - JPEG 이미지 버퍼
 * @param {string} [brandContext] - 브랜드/상품 설명 (선택)
 * @returns {Promise<{message: string, headline: string, description: string}>}
 */
export async function generateCopyFromImage(imageBuffer, brandContext = '') {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const base64 = imageBuffer.toString('base64');

  const userText = brandContext?.trim()
    ? `이 광고 이미지를 분석해서 카피를 작성해주세요.\n\n[브랜드/상품 정보]\n${brandContext.trim()}`
    : '이 광고 이미지를 분석해서 카피를 작성해주세요.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  const raw = response.content[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('Claude 응답에서 JSON 파싱 실패', { raw });
    throw new Error('카피 생성 실패: JSON 응답을 파싱할 수 없습니다');
  }

  const copy = JSON.parse(jsonMatch[0]);
  if (!copy.message || !copy.headline) {
    throw new Error('카피 생성 실패: message 또는 headline 누락');
  }

  logger.info('Claude Vision 카피 생성 완료', {
    headline: copy.headline,
    messageLen: copy.message.length,
  });

  return {
    message:     copy.message.trim(),
    headline:    copy.headline.trim(),
    description: (copy.description || '').trim(),
  };
}
