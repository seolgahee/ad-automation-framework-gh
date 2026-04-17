# Claude API 채팅 어시스턴트 구조

## 개요

대시보드 채팅창에서 자연어 질문을 하면 Claude AI가 DB 데이터를 직접 조회해서 답변합니다.

---

## 흐름

```
사용자 질문 (대시보드 채팅)
    ↓
POST /api/chat  (server.js)
    ↓
AdManagerSkill.handleMessage()  (ad-manager.skill.js)
    ↓
Claude API 호출 (claude-haiku-4-5-20251001)
    ↓
Claude가 query_db 도구로 DB 직접 조회 (Tool Use)
    ↓
조회 결과 기반으로 답변 생성
    ↓
사용자에게 텍스트 반환
```

---

## 오늘 변경 이력

### 1단계: 고정 컨텍스트 방식 (변경 전)

`_buildContext()` 함수가 미리 정해진 데이터를 Claude 프롬프트에 넣어줬습니다.

```
system prompt에 포함된 데이터:
- 최근 7일 캠페인 합산 성과
- Meta 소재 상위 15개 (2일 기준)
- 최근 알림 5건
```

**문제점:**
- "4월 1일 데이터가 없습니다" → 날짜별 데이터가 프롬프트에 없었기 때문
- 서버가 미리 골라준 데이터만 볼 수 있어 유연성 부족
- `campaigns WHERE status='ACTIVE'` 로 PAUSED 캠페인 제외됨

---

### 2단계: Tool Use 방식 (변경 후)

Claude에게 `query_db` 도구를 주어 스스로 필요한 SQL을 실행하도록 변경.

```js
// Claude에게 제공하는 도구
tools: [{
  name: 'query_db',
  description: 'SQLite 광고 DB에서 SELECT 쿼리를 실행합니다.',
  input_schema: {
    properties: { sql: { type: 'string' } }
  }
}]
```

**동작 방식 (Agentic Loop):**
```
Claude: "날짜별 Meta 데이터가 필요하다"
    → query_db("SELECT date_start, SUM(spend), ... FROM ad_performance WHERE platform='meta' AND date_start IN ('2026-03-31','2026-04-01') GROUP BY date_start")
    → 결과 수신
    → 최종 답변 생성
```

**안전 장치:**
- SELECT 쿼리만 허용 (INSERT/UPDATE/DELETE 차단)
- 최대 200행 반환 (토큰 폭발 방지)
- 최대 5회 tool call 반복 (무한루프 방지)

---

### 3단계: 시스템 프롬프트 테이블 용도 명시

Meta 질문 시 `performance` 테이블 대신 `ad_performance` 를 쓰도록 안내 추가.

**이유:** `performance` 테이블은 수집기(collector)가 별도로 sync해야 채워지는데,
오늘 같은 당일 데이터는 비어있을 수 있음. Meta 원천 데이터는 `ad_performance`에 있음.

```
- ad_performance → Meta 소재/캠페인 성과 원천. Meta 질문은 반드시 이 테이블 사용.
- performance    → Google 캠페인 성과 원천. Meta는 ad_performance에서 GROUP BY 집계.
```

---

## 결과

| 질문 | 변경 전 | 변경 후 |
|------|--------|--------|
| "4월1일 메타 ROAS 알려줘" | "데이터 없음" | ROAS 2.84 정확히 반환 |
| "3월31일 대비 개선 이유" | conversion_value=0으로 비교 불가 | ROAS 1.61→2.84 (75% 개선) 분석 |
| PAUSED 캠페인 성과 | 제외됨 | 포함됨 |

---

## 비용

| 방식 | 질문당 토큰 | 비용 |
|------|-----------|------|
| 고정 컨텍스트 | ~2,000~3,000 | ~$0.001 |
| Tool Use | ~5,000~15,000 | ~$0.003~0.01 |

하루 10~20회 질문 기준 월 몇백원 차이로 무시 가능한 수준.

---

## 관련 파일

- `src/openclaw-skills/ad-manager.skill.js` — Claude API 연동 및 Tool Use 구현
- `src/server.js` — `POST /api/chat` 엔드포인트
- `.env` — `ANTHROPIC_API_KEY` 설정
