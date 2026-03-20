# Ad Automation Framework — Code Review v2

**Review Date**: 2026-03-17
**Scope**: 18 source files (~3,800 lines) — full re-review after v1 fixes
**Severity Scale**: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Executive Summary

v1 리뷰에서 발견된 24건 중 대부분이 올바르게 수정되었습니다. SQL 인젝션(SQLite), 인증, PII 해싱, 싱글톤 패턴, 레이트 리밋, 입력 검증, WS 하트비트 등 핵심 보안/성능 이슈가 해소되었습니다. 그러나 후속 리뷰에서 **13건의 신규/잔여 이슈**를 발견했습니다. 특히 GAQL 인젝션 1건(CRITICAL), 싱글톤 미적용 모듈 3건(HIGH), 레이트 리밋 메모리 누수 1건(HIGH)이 프로덕션 배포 전 수정이 필요합니다.

---

## CRITICAL — Must Fix Before Production

### 1. GAQL Injection in `getPerformance()` (Residual from v1)

**File**: `src/google/client.js` (L224, L246)

```js
WHERE segments.date BETWEEN '${from}' AND '${to}'
```

`dateFrom`/`dateTo`는 메서드 파라미터로 전달되며, `collector.js`에서는 기본값을 사용하지만, `server.js`의 `/api/performance/timeline`에서는 이 메서드가 직접 호출되지 않더라도 향후 엔드포인트 추가 시 위험합니다. `updateBudget`은 수정되었으나 `getPerformance`는 여전히 문자열 보간을 사용합니다.

**Risk**: 사용자 입력이 `dateFrom`/`dateTo`로 전달될 경우, 임의의 GAQL 쿼리 실행 가능.
**Fix**: 날짜 형식 검증 추가:
```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateDate(d) {
  if (!DATE_RE.test(d)) throw new Error(`Invalid date format: ${d}`);
  return d;
}
```

---

## HIGH — Should Fix Before Launch

### 2. Singleton Pattern Not Applied to 3 Content Modules

**Files**: `src/content/creative-pipeline.js` (L11-12), `src/content/audience-manager.js` (L11-12), `src/analytics/collector.js` (L14-15)

```js
// creative-pipeline.js — creates NEW instances, bypassing singleton
this.meta = new MetaAdsClient();
this.google = new GoogleAdsClient();

// audience-manager.js — same pattern
this.meta = new MetaAdsClient();
this.google = new GoogleAdsClient();

// collector.js — same pattern
this.meta = new MetaAdsClient();
this.google = new GoogleAdsClient();
```

`server.js`와 `ad-manager.skill.js`는 `getMetaClient()`/`getGoogleClient()` 싱글톤으로 전환했으나, `CreativePipeline`, `AudienceManager`, `DataCollector`는 여전히 직접 인스턴스를 생성합니다. `ABTestEngine`은 내부에서 `CreativePipeline`을 생성하므로 연쇄적으로 2개의 추가 클라이언트가 생성됩니다.

**Impact**: 프로세스 내 최대 8개의 중복 API 클라이언트 인스턴스 존재.
**Fix**: 모든 모듈에서 `import { getMetaClient, getGoogleClient } from '../utils/clients.js'`로 교체.

### 3. Rate Limiter Memory Leak

**File**: `src/server.js` (L46-64)

```js
const rateLimitStore = new Map();
```

`rateLimitStore`는 IP별 엔트리를 생성하지만 만료된 엔트리를 삭제하지 않습니다. 장시간 운영 시 메모리가 무한 증가합니다.

**Fix**: 주기적 클린업 추가:
```js
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > 300000) rateLimitStore.delete(key); // 5분 후 삭제
  }
}, 60000);
```

### 4. CPA Threshold Fallback Mismatch

**File**: `src/analytics/collector.js` (L19)

```js
cpaMax: parseFloat(process.env.ALERT_CPA_THRESHOLD || '50'),
```

`default.env`는 `ALERT_CPA_THRESHOLD=50000`으로 수정되었으나, `.env` 파일이 없거나 해당 변수가 누락된 경우 폴백값이 `50`(₩50)입니다. KRW 기준 비현실적인 임계값으로, 모든 캠페인에 대해 잘못된 경고가 발생합니다.

**Fix**: 폴백값을 `'50000'`으로 변경:
```js
cpaMax: parseFloat(process.env.ALERT_CPA_THRESHOLD || '50000'),
```

### 5. Dashboard API 호출에 Auth Token 미포함

**File**: `src/dashboard/index.html` (L254, L283-285 등)

```js
fetch(`${API}/campaigns/${id}/status`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status }),
});
```

서버에 `API_AUTH_TOKEN`이 설정된 경우, 대시보드의 모든 `fetch()` 호출이 401 에러를 반환합니다. `Authorization: Bearer <token>` 헤더가 포함되어 있지 않습니다.

**Fix**: API 래퍼 함수 생성:
```js
const API_TOKEN = ''; // 환경변수 또는 입력으로 받기
function apiFetch(url, options = {}) {
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  return fetch(url, { ...options, headers });
}
```

---

## MEDIUM — Improve Before Scale

### 6. `toLocaleString()` 잔여 사용 (Locale-Unsafe)

**Files**:
- `src/openclaw-skills/ad-manager.skill.js` (L158, L210, L214, L237)
- `src/analytics/collector.js` (L173)

v1 리뷰에서 `optimizer.js`는 `Intl.NumberFormat('ko-KR')`로 수정되었으나, `ad-manager.skill.js`와 `collector.js`에는 여전히 `.toLocaleString()`이 5곳 남아있습니다.

**Fix**: 모든 파일에서 `krwFmt.format()` 사용으로 통일.

### 7. Dashboard Hardcoded `localhost` URL

**File**: `src/dashboard/index.html` (L62-63)

```js
const API = 'http://localhost:3099/api';
const WS_URL = 'ws://localhost:3099/ws';
```

개발 환경에서만 동작합니다. 배포 환경에서는 다른 호스트/포트를 사용해야 합니다.

**Fix**: `window.location` 기반 동적 URL 생성:
```js
const API = `${window.location.protocol}//${window.location.hostname}:3099/api`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3099/ws`;
```

### 8. CORS Origin Unrestricted

**File**: `src/server.js` (L25)

```js
app.use(cors());
```

모든 오리진에서의 요청을 허용합니다. Bearer 토큰 인증이 있더라도, 토큰이 노출된 경우 제한 없이 사용 가능합니다.

**Fix**: 프로덕션에서는 허용 오리진을 명시:
```js
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3100' }));
```

### 9. Audience ID Collision Risk

**File**: `src/content/audience-manager.js` (L318)

```js
const id = `aud_${platform}_${Date.now()}`;
```

밀리초 단위 타임스탬프 기반 ID는 동시 요청 시 충돌 가능성이 있습니다. 다른 모듈(`creative-pipeline.js`, `ab-testing.js`)은 `crypto.randomBytes(6)`를 사용합니다.

**Fix**: `crypto.randomBytes` 패턴으로 통일:
```js
const id = `aud_${crypto.randomBytes(6).toString('hex')}`;
```

### 10. React Dashboard Error Boundary 부재

**File**: `src/dashboard/index.html`

789라인의 단일 HTML 파일에서 React 에러 바운더리가 없습니다. API 응답이 예상과 다른 경우(예: `null.toLocaleString()`) 전체 대시보드가 크래시됩니다.

**Fix**: 최상위 ErrorBoundary 클래스 컴포넌트 추가.

---

## LOW — Nice to Have

### 11. `fetchContentData` 정의 전 참조

**File**: `src/dashboard/index.html` (L276 vs L297)

```js
// L276 — onmessage에서 fetchContentData 참조
if (['creative_assembled', ...].includes(msg.type)) fetchContentData();

// L297 — fetchContentData 정의
const fetchContentData = useCallback(async () => { ... }, []);
```

`useCallback`으로 정의된 함수를 같은 컴포넌트 내 다른 `useEffect`에서 참조합니다. JavaScript hoisting 규칙상 `const`는 hoisted되지 않으므로, WebSocket `onmessage`가 초기 렌더링 시 실행되면 `fetchContentData`가 `undefined`일 수 있습니다. 실제로는 `useEffect`의 `fetchData` 의존성 때문에 `ws.current.onmessage`가 설정되는 시점에 `fetchContentData`가 이미 정의되어 있지만, 코드 순서가 혼란을 줍니다.

**Fix**: `fetchContentData` 선언을 `fetchData` 위로 이동.

### 12. `Content-Security-Policy` 헤더 부재

**File**: `src/dashboard/index.html`

CDN에서 5개의 외부 스크립트를 로드하지만 CSP 헤더가 없습니다. XSS 공격 시 방어 계층이 부족합니다.

**Fix**: `<meta http-equiv="Content-Security-Policy">` 태그 또는 서버 측 헤더 추가.

### 13. `collector.js` 알림 중 `await` 순차 실행

**File**: `src/analytics/collector.js` (L171-193)

```js
for (const row of latestPerf) {
  // ...
  await notifier.broadcast(msg, { severity: 'warning' });
  // ...
  await notifier.broadcast(msg, { severity: 'critical' });
}
```

루프 내에서 `await`로 알림을 순차 전송합니다. 알림 수가 많으면 수집 사이클이 지연됩니다.

**Fix**: 알림을 배열에 수집 후 `Promise.allSettled`로 병렬 전송:
```js
const alertPromises = [];
for (const row of latestPerf) {
  if (condition) alertPromises.push(notifier.broadcast(msg, opts));
}
await Promise.allSettled(alertPromises);
```

---

## INFO — Observations

### 14. v1 리뷰 수정 상태 (양호)

- **SQL Injection (SQLite)**: 모든 파라미터화 완료 — `optimizer.js`, `server.js` ✅
- **GAQL Injection (updateBudget)**: 숫자 검증 적용 ✅
- **Bearer Token Auth**: `authMiddleware` 올바르게 구현 ✅
- **PII Hashing**: `hashPII()` SHA-256 적용, 스키마 `EMAIL_SHA256`/`PHONE_SHA256` ✅
- **WebSocket Heartbeat**: ping/pong 30초 주기 + 데드 커넥션 정리 ✅
- **Data Dedup**: UPSERT + unique index `idx_perf_dedup` ✅
- **Graceful Shutdown**: SIGTERM/SIGINT 핸들러 + 10초 타임아웃 ✅
- **Input Validation**: `validateRequired`/`validatePlatform`/`validateDays` ✅
- **Budget Regex**: 구조화된 패턴 매칭 + 인용 캠페인명 지원 ✅
- **Singleton (partial)**: `server.js`, `ad-manager.skill.js`에 적용 ✅

### 15. 아키텍처 강점

- Express + WebSocket 하이브리드 서버가 잘 구조화됨
- 콘텐츠 모듈 (Pipeline → Template → A/B → Audience) 관심사 분리 우수
- `better-sqlite3` WAL 모드 + 외래키 + 적절한 인덱스
- OpenClaw 스킬의 한국어 NL 파싱이 실용적
- Perplexity Computer 스타일 대시보드 구현 완성도 높음

---

## Resolution Status (2026-03-17)

| # | Severity | Finding | Status | File(s) Modified |
|---|----------|---------|--------|-----------------|
| 1 | CRITICAL | GAQL Injection — `getPerformance()` 날짜 검증 | ✅ Fixed | `google/client.js` — `_validateDate()` + status whitelist |
| 2 | HIGH | 3개 모듈 싱글톤 미적용 | ✅ Fixed | `collector.js`, `creative-pipeline.js`, `audience-manager.js` |
| 3 | HIGH | Rate Limiter 메모리 누수 | ✅ Fixed | `server.js` — 60s cleanup interval + shutdown 시 clearInterval |
| 4 | HIGH | CPA 임계값 폴백 `'50'` → `'50000'` | ✅ Fixed | `collector.js` |
| 5 | HIGH | Dashboard API Auth 미포함 | ✅ Fixed | `dashboard/index.html` — `apiFetch()` wrapper + URL param token |
| 6 | MEDIUM | `toLocaleString()` 잔여 5곳 | ✅ Fixed | `ad-manager.skill.js`, `collector.js` — `krwFmt.format()` |
| 7 | MEDIUM | Dashboard Hardcoded `localhost` | ✅ Fixed | `dashboard/index.html` — `window.location` 기반 동적 URL |
| 8 | MEDIUM | CORS Origin 무제한 | ✅ Fixed | `server.js` — `CORS_ORIGIN` env var |
| 9 | MEDIUM | Audience ID 충돌 위험 | ✅ Fixed | `audience-manager.js` — `crypto.randomBytes(6)` |
| 10 | MEDIUM | React Error Boundary 부재 | ✅ Fixed | `dashboard/index.html` — `ErrorBoundary` class component |
| 11 | LOW | `fetchContentData` 정의 전 참조 | ✅ Fixed | `dashboard/index.html` — 선언 순서 재배치 + 중복 제거 |
| 12 | LOW | CSP 헤더 부재 | ✅ Fixed | `dashboard/index.html` — `<meta http-equiv="Content-Security-Policy">` |
| 13 | LOW | `collector.js` 알림 순차 실행 | ✅ Fixed | `collector.js` — `broadcastQueue` + `Promise.allSettled` |

**All 13 findings resolved. ✅**
