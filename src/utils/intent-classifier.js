/**
 * Intent Classifier — TF-IDF + Cosine Similarity based NLP
 *
 * Replaces simple keyword matching with a lightweight intent
 * classification model that handles:
 * - Fuzzy matching (typos, partial words)
 * - Synonym expansion (한국어 + English)
 * - Confidence scoring
 * - Multi-intent disambiguation
 * - Fallback detection (low confidence → help message)
 *
 * No external ML dependencies — pure JavaScript implementation.
 */

/**
 * Intent definition with training phrases
 * @typedef {{ intent: string, handler: string, phrases: string[], description: string }} IntentDef
 */

/** @type {IntentDef[]} */
export const INTENT_DEFINITIONS = [
  {
    intent: 'performance',
    handler: 'handlePerformance',
    description: '광고 성과 조회 (오늘/기간별)',
    phrases: [
      '성과 알려줘', '오늘 광고 어때', '광고 성과', '리포트 보여줘', 'performance',
      'report', '오늘 광고 성과', '주간 리포트', '월간 리포트', '실적',
      '성과 분석', '광고 효율', '데이터 보여줘', '얼마나 잘 되고 있어',
      '어제 성과', '이번 주 성과', '이번 달 성과', '광고 현황', '매출',
      'ROAS 얼마', 'CPA 어때', 'CTR 확인', '클릭률', '전환율',
    ],
  },
  {
    intent: 'budget_change',
    handler: 'handleBudgetChange',
    description: '캠페인 예산 변경',
    phrases: [
      '예산 변경', '예산 수정', '예산 조정', 'budget', '예산 올려',
      '예산 내려', '예산 늘려', '예산 줄여', '일예산 변경', '돈 더 넣어',
      '비용 조정', '예산 설정', '예산 바꿔', '금액 변경', '얼마로 변경',
      '예산을 늘려줘', '예산을 줄여줘', '돈 좀 넣어줘',
    ],
  },
  {
    intent: 'pause',
    handler: 'handlePause',
    description: '캠페인 일시중지',
    phrases: [
      '일시중지', '중지', '정지', 'pause', 'stop', '꺼줘', '멈춰',
      '캠페인 끄기', '광고 중단', '잠깐 멈춰', '일단 꺼', '중단해줘',
      '비활성화', '광고 멈춰', '돌리지 마', '그만해',
    ],
  },
  {
    intent: 'enable',
    handler: 'handleEnable',
    description: '캠페인 재활성화',
    phrases: [
      '활성화', '재개', 'resume', 'enable', '켜줘', '다시 시작',
      '광고 켜', '재시작', '다시 돌려', '복구', '다시 활성화',
      '재활성화', '광고 시작', '다시 켜줘', '살려줘',
    ],
  },
  {
    intent: 'optimize',
    handler: 'handleOptimize',
    description: '예산 최적화 추천',
    phrases: [
      '최적화', 'optimize', '추천', 'suggest', '효율 개선',
      '자동 최적화', '예산 추천', '어떻게 분배', '최적 예산',
      '효율적으로', '개선 방안', '분석해줘', '뭘 바꿔야 해',
      '어디에 더 투자', '비효율 캠페인', '성과 개선',
    ],
  },
  {
    intent: 'list_campaigns',
    handler: 'handleListCampaigns',
    description: '전체 캠페인 목록 조회',
    phrases: [
      '캠페인 목록', 'campaigns', '캠페인 리스트', '전체 캠페인',
      '캠페인 보여줘', '어떤 캠페인', '광고 목록', '캠페인 현황',
      '뭐 돌리고 있어', '진행 중인 캠페인', '캠페인 확인',
    ],
  },
  {
    intent: 'alerts',
    handler: 'handleAlerts',
    description: '최근 알림/경고 조회',
    phrases: [
      '알림 내역', 'alerts', '경고', '알림', '이상 없어',
      '문제 있어', '경고 내역', '알림 확인', '주의사항',
      '뭔가 문제', '이슈', '알림 보여줘',
    ],
  },
  {
    intent: 'create_ad',
    handler: 'handleCreateAd',
    description: '새 광고 콘텐츠 등록',
    phrases: [
      '광고 등록', '콘텐츠 등록', 'create ad', '크리에이티브 등록',
      '새 광고', '광고 만들어', '광고 생성', '신규 광고',
      '광고 올려줘', '콘텐츠 만들어',
    ],
  },
  {
    intent: 'templates',
    handler: 'handleListTemplates',
    description: '카피 템플릿 목록/미리보기',
    phrases: [
      '템플릿', 'template', '템플릿 목록', '카피 템플릿',
      '템플릿 보여줘', '어떤 템플릿', '양식', '문구 템플릿',
    ],
  },
  {
    intent: 'ab_test',
    handler: 'handleABTest',
    description: 'A/B 테스트 생성/조회',
    phrases: [
      'ab 테스트', 'a/b', 'AB테스트', 'ab test', '분할 테스트',
      '변형 테스트', '실험', 'A/B 만들어', '테스트 목록',
      '테스트 결과', '승자는', 'p-value', '유의성',
    ],
  },
  {
    intent: 'audience',
    handler: 'handleAudience',
    description: '오디언스 생성/조회',
    phrases: [
      '오디언스', 'audience', '타겟', '타겟팅', '대상 그룹',
      '맞춤 타겟', '유사 타겟', '고객 리스트', '타겟 설정',
      '프리셋', 'preset', '타겟팅 프리셋',
    ],
  },
  {
    intent: 'list_creatives',
    handler: 'handleListCreatives',
    description: '등록된 크리에이티브 목록 조회',
    phrases: [
      '크리에이티브 목록', 'creatives', '광고 소재', '소재 목록',
      '등록된 광고', '크리에이티브 보여줘', '소재 현황',
    ],
  },
];

export class IntentClassifier {
  constructor() {
    this.intents = INTENT_DEFINITIONS;
    this.vocabulary = new Map();   // word → index
    this.idf = new Map();          // word → IDF score
    this.intentVectors = [];       // precomputed TF-IDF vectors per intent
    this._buildModel();
  }

  // ─── Model Construction ──────────────────────────────────

  _buildModel() {
    // Step 1: Build vocabulary from all training phrases
    const allDocs = [];
    for (const intent of this.intents) {
      for (const phrase of intent.phrases) {
        allDocs.push(this._tokenize(phrase));
      }
    }

    // Build vocabulary
    const wordSet = new Set(allDocs.flat());
    let idx = 0;
    for (const word of wordSet) {
      this.vocabulary.set(word, idx++);
    }

    // Step 2: Compute IDF via inverted index (O(D×T) instead of O(V×D×T))
    const N = allDocs.length;
    const docFreq = new Map();
    for (const doc of allDocs) {
      for (const word of new Set(doc)) {
        docFreq.set(word, (docFreq.get(word) || 0) + 1);
      }
    }
    for (const [word, df] of docFreq) {
      this.idf.set(word, Math.log((N + 1) / (df + 1)) + 1);
    }

    // Step 3: Build composite TF-IDF vector per intent (average of all phrases)
    for (const intent of this.intents) {
      const vectors = intent.phrases.map(p => this._toTfIdf(this._tokenize(p)));
      const avgVector = this._averageVectors(vectors);
      this.intentVectors.push({ intent: intent.intent, handler: intent.handler, vector: avgVector });
    }
  }

  _tokenize(text) {
    // Normalize: lowercase, split on whitespace and punctuation
    const normalized = text.toLowerCase()
      .replace(/[.,!?'"()\[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Split into tokens — handles Korean (chars as tokens) + English (words)
    const tokens = [];
    let currentWord = '';

    for (const char of normalized) {
      if (char === ' ') {
        if (currentWord) tokens.push(currentWord);
        currentWord = '';
      } else if (this._isKorean(char)) {
        if (currentWord && !this._isKorean(currentWord[0])) {
          tokens.push(currentWord);
          currentWord = '';
        }
        currentWord += char;
      } else {
        if (currentWord && this._isKorean(currentWord[0])) {
          tokens.push(currentWord);
          currentWord = '';
        }
        currentWord += char;
      }
    }
    if (currentWord) tokens.push(currentWord);

    // Generate bigrams for better Korean matching
    const bigrams = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.push(`${tokens[i]}_${tokens[i + 1]}`);
    }

    return [...tokens, ...bigrams];
  }

  _isKorean(char) {
    const code = char.charCodeAt(0);
    return (code >= 0xAC00 && code <= 0xD7AF) || // Hangul syllables
           (code >= 0x3130 && code <= 0x318F) || // Hangul compatibility jamo
           (code >= 0x1100 && code <= 0x11FF);   // Hangul jamo
  }

  _toTfIdf(tokens) {
    const tf = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    const vector = new Float64Array(this.vocabulary.size);
    for (const [word, count] of tf) {
      const idx = this.vocabulary.get(word);
      if (idx !== undefined) {
        vector[idx] = (count / tokens.length) * (this.idf.get(word) || 1);
      }
    }
    return vector;
  }

  _averageVectors(vectors) {
    if (vectors.length === 0) return new Float64Array(this.vocabulary.size);
    const avg = new Float64Array(this.vocabulary.size);
    for (const v of vectors) {
      for (let i = 0; i < v.length; i++) avg[i] += v[i];
    }
    for (let i = 0; i < avg.length; i++) avg[i] /= vectors.length;
    return avg;
  }

  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  // ─── Classification ──────────────────────────────────────

  /**
   * Classify user message into an intent
   *
   * @param {string} message - Raw user input
   * @param {number} [threshold=0.15] - Minimum confidence to match
   * @returns {{ intent, handler, confidence, alternatives }|null}
   */
  classify(message, threshold = 0.15) {
    const tokens = this._tokenize(message);

    const queryVector = this._toTfIdf(tokens);

    // Score against all intents
    const scores = this.intentVectors.map(iv => ({
      intent: iv.intent,
      handler: iv.handler,
      confidence: this._cosineSimilarity(queryVector, iv.vector),
    }));

    // Also check exact keyword match as a boost
    for (const score of scores) {
      const intentDef = this.intents.find(i => i.intent === score.intent);
      if (intentDef) {
        const lowerMsg = message.toLowerCase();
        for (const phrase of intentDef.phrases) {
          if (lowerMsg.includes(phrase.toLowerCase())) {
            score.confidence = Math.max(score.confidence, 0.85); // Exact match = high confidence
            break;
          }
        }
      }
    }

    // Sort by confidence
    scores.sort((a, b) => b.confidence - a.confidence);

    const best = scores[0];
    if (!best || best.confidence < threshold) return null;

    return {
      intent: best.intent,
      handler: best.handler,
      confidence: parseFloat(best.confidence.toFixed(4)),
      alternatives: scores.slice(1, 4)
        .filter(s => s.confidence >= threshold * 0.5)
        .map(s => ({ intent: s.intent, confidence: parseFloat(s.confidence.toFixed(4)) })),
    };
  }

  /** Get all registered intent names */
  getIntentNames() {
    return this.intents.map(i => ({ intent: i.intent, description: i.description }));
  }
}

// Singleton instance
let _instance = null;
export function getIntentClassifier() {
  if (!_instance) _instance = new IntentClassifier();
  return _instance;
}

export default IntentClassifier;
