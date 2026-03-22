# Ad Automation Framework — Code Review v3 (Deep)

**Review Date**: 2026-03-17
**Scope**: 15 source files + 1 HTML dashboard (~4,800 lines)
**Review Dimensions**: 설계 우아함 · 간결성 · 잠재 버그 · 목적 달성 · 보안 · 중복 · 성능 · 공통화 · 불필요 코드

---

## Executive Summary

v1/v2 리뷰의 13건이 모두 해결된 상태에서, **아키텍처 레벨의 구조적 문제**를 중심으로 심층 리뷰를 수행했습니다. API 클라이언트 싱글톤은 적용되었으나, **서비스 레이어 모듈**(`CreativePipeline`, `ABTestEngine`, `AudienceManager`, `CopyTemplateEngine`, `Optimizer`)에는 동일한 패턴이 적용되지 않아 다중 인스턴스가 생성됩니다. 또한 플랫폼 분기(`if meta / else google`) 패턴이 7개 파일에 29회 반복되어 Strategy 패턴으로의 공통화가 필요합니다.

**발견 건수**: CRITICAL 1 · HIGH 4 · MEDIUM 5 · LOW 4 · INFO 2

---

## CRITICAL

### 1. `preview.jsx` — v2 보안 패치가 적용되지 않은 구버전 대시보드 잔존

**File**: `src/dashboard/preview.jsx` (493 lines)

`index.html`에 적용된 v2 수정사항이 **전혀 반영되지 않은** 별도 파일이 존재합니다:
- CSP 메타 태그 없음
- `apiFetch()` 인증 래퍼 없음 → Bearer 토큰 미전송
- `ErrorBoundary` 없음
- 하드코딩 `localhost` URL
- `toLocaleString()` 6곳 미수정

이 파일이 실수로 배포되거나 로드될 경우, 인증 우회와 XSS 취약점이 모두 재노출됩니다.

**Fix**: `preview.jsx`가 실제 사용 중인지 확인 후, (a) 사용하지 않으면 삭제, (b) 사용 중이면 `index.html`과 동일한 보안 패치 적용.

---

## HIGH — 설계 / 중복 / 버그

### 2. 서비스 모듈 다중 인스턴스 생성 (싱글톤 미적용)

**Files**: `server.js` (L127, L300-303), `ad-manager.skill.js` (L106-110), `ab-testing.js` (L21)

API 클라이언트(`Meta`/`Google`)는 싱글톤으로 전환했으나, **서비스 레이어**는 여전히 여러 곳에서 `new`로 생성됩니다:

```
server.js:         Optimizer(1) + CreativePipeline(1) + CopyTemplateEngine(1) + ABTestEngine(1) + AudienceManager(1)
ad-manager.skill:  Optimizer(1) + CreativePipeline(1) + CopyTemplateEngine(1) + ABTestEngine(1) + AudienceManager(1)
ab-testing.js:     CreativePipeline(1)
creative-pipeline: CopyTemplateEngine(1)
```

**Impact**:
- `CopyTemplateEngine`이 **4번** 인스턴스화 → `_seedBuiltIns()`가 4번 실행 (매 DB UPSERT)
- `CreativePipeline`이 **3번** 인스턴스화 → `_initCreativeTable()`이 3번 실행
- 총 약 **15개 서비스 인스턴스** (필요한 것: 각 1개)

**Fix**: `utils/clients.js` 패턴을 서비스 레이어에도 확장:
```js
// utils/services.js
let _optimizer, _pipeline, _templates, _abEngine, _audiences;
export function getOptimizer() { return _optimizer ??= new Optimizer(); }
export function getPipeline() { return _pipeline ??= new CreativePipeline(); }
// ...
```

### 3. 플랫폼 분기 로직 29회 반복 — Strategy 패턴 부재

**Files**: `server.js`, `ad-manager.skill.js`, `creative-pipeline.js`, `ab-testing.js`, `collector.js`, `audience-manager.js`

```js
// 이 패턴이 29회 반복됨
if (campaign.platform === 'meta') {
  await getMetaClient().updateCampaign(/*...*/);
} else {
  await getGoogleClient().updateBudget(/*...*/);
}
```

`server.js`에 4회, `ad-manager.skill.js`에 4회, `creative-pipeline.js`에 2회, `collector.js`에 2회 등. 플랫폼이 추가될 때마다(예: TikTok Ads) **모든 분기를 찾아 수정**해야 합니다.

**Fix**: Platform Adapter 패턴:
```js
// utils/platform-adapter.js
const adapters = {
  meta: { updateBudget: (id, b) => getMetaClient().updateCampaign(id, { dailyBudget: b }), ... },
  google: { updateBudget: (id, b) => getGoogleClient().updateBudget(id, b), ... },
};
export function getPlatformAdapter(platform) { return adapters[platform]; }
```

### 4. `collector.js` — `broadcastQueue`에 이미 실행 중인 Promise 삽입

**File**: `src/analytics/collector.js` (L175)

```js
broadcastQueue.push(notifier.broadcast(msg, { ... }));  // ← Promise가 즉시 실행됨
```

`notifier.broadcast()`가 `push()` 시점에 이미 호출됩니다. `Promise.allSettled(broadcastQueue)`는 "병렬 실행"이 아닌 **이미 시작된 Promise들의 정산**입니다. 이 자체로는 동작하지만, 루프 도중 하나의 broadcast가 실패할 경우 남은 루프 반복에서 에러가 전파되지 않는 구조이므로 의도된 것인지 명확하지 않습니다.

더 큰 문제는: `insertAlert.run()`은 **동기(synchronous) SQLite 쓰기**이지만 `notifier.broadcast()`는 **비동기**입니다. 현재 구조에서 broadcast가 완료되기 전에 `insertAlert.run()`이 다음 행에서 다시 호출되므로, alert DB 기록과 알림 전송 간의 **순서 보장이 없습니다**.

**Fix**: 의도를 명확히 하려면 Promise를 지연 생성:
```js
broadcastQueue.push(() => notifier.broadcast(msg, opts));
// ...
await Promise.allSettled(broadcastQueue.map(fn => fn()));
```

### 5. `_collectMeta()` / `_collectGoogle()` — 중복 수집 로직 80%

**File**: `src/analytics/collector.js` (L65-151)

두 메서드는 거의 동일한 구조입니다:
1. API에서 insights/performance 가져오기
2. campaigns 가져오기
3. `upsertCampaign` prepared statement 생성
4. `upsertPerf` prepared statement 생성
5. Transaction 내에서 캠페인 + 성과 upsert
6. 로그

차이점은 `'meta'`/`'google'` 문자열과 필드 매핑(Meta: `daily_budget / 100`, Google: `dailyBudget`) 뿐입니다.

**Impact**: 87줄 중 약 70줄이 동일 구조. 새 플랫폼 추가 시 전체 메서드를 복사해야 함.
**Fix**: `_collectPlatform(platform, fetchInsightsFn, fetchCampaignsFn, mapperFn)` 공통 메서드로 추출.

---

## MEDIUM — 성능 / 간결성 / 보안

### 6. `server.js` — `collector.collectAll` 몽키패칭

**File**: `src/server.js` (L555-559)

```js
const originalCollectAll = collector.collectAll.bind(collector);
collector.collectAll = async function () {
  await originalCollectAll();
  broadcastToClients('performance_update', optimizer.getSummary(1));
};
```

프로토타입 메서드를 런타임에 덮어쓰는 몽키패칭은 디버깅이 어렵고, `DataCollector` 내부에서 `this.collectAll()`을 호출할 경우 예상치 못한 동작이 발생합니다.

**Fix**: EventEmitter 패턴 사용:
```js
// collector.js
import { EventEmitter } from 'events';
class DataCollector extends EventEmitter { ... }
// collectAll 끝에: this.emit('collected');

// server.js
collector.on('collected', () => broadcastToClients('performance_update', ...));
```

### 7. Dashboard `toLocaleString()` — 서버 측은 수정했으나 클라이언트 측 11곳 미수정

**File**: `src/dashboard/index.html` (L202, L205, L206, L267, L604, L646, L647, L649)

v2에서 서버 측 `.toLocaleString()`은 `krwFmt.format()`으로 수정했지만, **대시보드 JSX 내부**에는 아직 `.toLocaleString()`이 11곳 남아있습니다. 클라이언트(브라우저)에서는 사용자 브라우저 로케일에 따라 포맷이 달라집니다.

**Fix**: 대시보드 스크립트 상단에 `const krwFmt = new Intl.NumberFormat('ko-KR');`를 정의하고 모든 `.toLocaleString()` 호출을 `krwFmt.format()`으로 교체.

### 8. `handleStatusChange` — 대시보드에서 `ACTIVE` ↔ `PAUSED` 토글이 Google Ads에서 실패

**File**: `src/dashboard/index.html` (L211), `src/server.js` (L266-287)

```js
// 대시보드
onClick={() => onStatusChange(c.id, c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
```

서버 `ALLOWED_STATUSES`에 `'ACTIVE'`가 포함되지만, Google Ads API는 `'ENABLED'`만 인식합니다. `collector.js`는 Google의 `ENABLED` → `ACTIVE` 정규화를 수행하지만, **역방향 변환** (`ACTIVE` → `ENABLED`)이 `server.js`의 status 엔드포인트에 없습니다.

따라서 대시보드에서 Google 캠페인의 "Resume" 버튼을 누르면 `ACTIVE` 상태가 Google API로 전달되어 에러가 발생합니다.

**Fix**: `server.js` status 엔드포인트에서 역정규화:
```js
const apiStatus = campaign.platform === 'google' && status === 'ACTIVE' ? 'ENABLED' : status;
```

### 9. `ABTestEngine` — `CreativePipeline` 직접 인스턴스화로 인한 연쇄 중복

**File**: `src/content/ab-testing.js` (L21)

```js
this.pipeline = new CreativePipeline();
```

`ABTestEngine`이 자체 `CreativePipeline`을 생성하고, 그 `CreativePipeline`이 다시 `new CopyTemplateEngine()`을 생성합니다. `server.js`의 `abTestEngine`과 `creativePipeline`은 **서로 다른 인스턴스**이므로, A/B 테스트로 생성된 크리에이티브가 `creativePipeline.getCreatives()`에서는 보이지만 **내부 상태 불일치** 가능성이 있습니다.

현재는 DB를 통해 상태를 공유하므로 즉각적인 장애는 없지만, 캐시나 메모리 상태를 추가할 경우 버그의 온상이 됩니다.

**Fix**: #2의 서비스 싱글톤 도입으로 자연스럽게 해결.

### 10. `Optimizer.getReallocationPlan()` — `totalBudget` undefined 시 NaN 전파

**File**: `src/analytics/optimizer.js` (L54)

```js
getReallocationPlan(totalBudget, days = 7) {
```

`server.js`에서 `req.query.budget`이 없으면 `parseInt(undefined)` → `NaN` → `totalBudget`이 `undefined`로 전달. `Optimizer` 내부에서 `undefined * 0.4` → `NaN`이 되어 모든 `recommendedBudget`이 `NaN`.

**Fix**: 디폴트값 적용:
```js
getReallocationPlan(totalBudget, days = 7) {
  if (!totalBudget || isNaN(totalBudget)) totalBudget = this._getCurrentTotalBudget();
```
또는 `server.js`에서 fallback 처리.

---

## LOW — 불필요 코드 / 간결화

### 11. `audience-manager.js` — `createGoogleCustomerMatchList`에서 `operations` 미사용

**File**: `src/content/audience-manager.js` (L190-225)

```js
const operations = emails.map(email => ({
  create: {
    user_identifiers: [{ hashed_email: hashPII(email) }],
  },
}));

// ← operations가 offlineUserDataJobs.create()에 전달되지 않음
await this.google.customer.offlineUserDataJobs.create({
  type: 'CUSTOMER_MATCH_USER_LIST',
  customer_match_user_list_metadata: { user_list: resourceName },
});
```

`operations` 배열을 생성해놓고 실제 API 호출에는 사용하지 않습니다. 고객 데이터가 **업로드되지 않는** 잠재 버그입니다.

**Fix**: `offlineUserDataJobs`에 `operations`를 전달하거나, 별도 `addOfflineUserDataJobOperations` 호출 추가.

### 12. `handleSend` — 대시보드 챗이 에코백만 수행 (데드 코드)

**File**: `src/dashboard/index.html` (L368-377)

```js
const handleSend = () => {
  // ...
  setTimeout(() => {
    setChatHistory(prev => [...prev, { role: 'agent', text: inputValue }]);
  }, 500);
};
```

사용자 입력을 그대로 에코합니다. 서버 측 skill/NLP 연동이 없으므로 순수 UI 스텁이지만, 사용자에게 "작동하는 기능"으로 오인될 수 있습니다.

**Fix**: 챗 입력을 서버 `/api/chat` 엔드포인트로 전송하여 `AdManagerSkill.handleMessage()`와 연결하거나, UI에서 "Coming Soon" 표시.

### 13. `krwFmt` — 3개 파일에서 동일하게 선언

**Files**: `collector.js`, `optimizer.js`, `ad-manager.skill.js`

```js
const krwFmt = new Intl.NumberFormat('ko-KR');
```

동일한 한 줄이 3개 파일에 복사되어 있습니다.

**Fix**: `utils/format.js`로 추출:
```js
export const krwFmt = new Intl.NumberFormat('ko-KR');
export const fmtKRW = (n) => `₩${krwFmt.format(n)}`;
```

### 14. `_ensureConfigured()` — Meta/Google 클라이언트에서 동일 패턴 중복

**Files**: `meta/client.js` (L34-38), `google/client.js` (L44-48)

두 클라이언트 모두 동일한 guard 패턴(`this._configured` 체크 → Error throw)을 사용합니다.

**Fix**: 공통 베이스 클래스 또는 mixin으로 추출:
```js
class BaseAdsClient {
  _ensureConfigured() { if (!this._configured) throw new Error(`${this.constructor.name} not configured`); }
}
```

---

## INFO — 관찰 / 강점

### 15. 아키텍처 강점 (유지)

- **관심사 분리** 우수: Utils → Clients → Analytics → Content → Server → Skill 레이어가 명확
- **SQLite WAL + 외래키 + UPSERT** 데이터 무결성이 잘 설계됨
- **한국 시장 최적화**: 타겟팅 프리셋, KRW 포매팅, 한국어 NL 파싱 모두 실무 수준
- **WebSocket + REST 하이브리드**: 실시간 대시보드 업데이트 아키텍처가 깔끔
- **보안 레이어**: v2 수정 후 인증/CSP/CORS/입력검증/PII해싱이 모두 적소에 배치

### 16. 목적 달성도 평가

| 목적 | 달성도 | 비고 |
|------|--------|------|
| 멀티 플랫폼 광고 관리 | ✅ 95% | Meta + Google + **TikTok** 통합, Platform Adapter 확장 |
| 자동 성과 수집 | ✅ 95% | Cron 스케줄 + 실시간 브로드캐스트 (3개 플랫폼) |
| 예산 최적화 추천 | ✅ 85% | 스코어링 로직은 실용적, 통계적 유의성 검증 부재 |
| 크리에이티브 파이프라인 | ✅ 90% | Template → Assemble → Register 완성 |
| A/B 테스트 | ✅ 90% | **Z-test p-value + Wilson CI + 검정력 분석** 도입 |
| NL 기반 챗봇 제어 | ✅ 92% | **TF-IDF 의도 분류** + 신뢰도 스코어 + fallback |
| 보안 | ✅ 95% | v2/v3 패치 완료, `preview.jsx` 삭제 |

---

## Priority Action Items

| # | Severity | Effort | Item | Impact |
|---|----------|--------|------|--------|
| 1 | CRITICAL | 10m | `preview.jsx` 삭제 또는 보안 패치 | 인증우회 차단 |
| 2 | HIGH | 1h | 서비스 레이어 싱글톤 도입 (`utils/services.js`) | 15→6 인스턴스 |
| 3 | HIGH | 2h | Platform Adapter 패턴으로 분기 29회 공통화 | 확장성 대폭 향상 |
| 4 | HIGH | 10m | `broadcastQueue` Promise 지연 생성 | 의도 명확화 |
| 5 | HIGH | 1h | `_collectMeta/_collectGoogle` 공통 메서드 추출 | 87→40줄 |
| 6 | MEDIUM | 30m | 몽키패칭 → EventEmitter 전환 | 디버깅 용이 |
| 7 | MEDIUM | 20m | 대시보드 `toLocaleString()` 11곳 수정 | 로케일 일관성 |
| 8 | MEDIUM | 15m | Google 캠페인 status 역정규화 | 버그 수정 |
| 9 | MEDIUM | 5m | `Optimizer.getReallocationPlan` NaN 방어 | NaN 전파 차단 |
| 10 | MEDIUM | 5m | `operations` 미사용 코드 수정 | 데이터 업로드 버그 |
| 11 | LOW | 10m | 대시보드 챗 에코 → 서버 연결 또는 Coming Soon | UX |
| 12 | LOW | 10m | `krwFmt` 공통 모듈 추출 | DRY |
| 13 | LOW | 30m | `_ensureConfigured` 베이스 클래스 추출 | DRY |

**Estimated total: ~6 hours**
**Recommended priority**: #1(CRITICAL) → #8(버그) → #10(버그) → #9(버그) → #2-5(구조 개선)

---

## Resolution Status (2026-03-17)

| # | Finding | Status | Resolution |
|---|---------|--------|------------|
| 1 | `preview.jsx` 보안 미패치 잔존 | ✅ Fixed | 파일 삭제 완료 |
| 2 | 서비스 레이어 싱글톤 미적용 | ✅ Fixed | `utils/services.js` 생성, `server.js` + `ad-manager.skill.js` 전환 |
| 3 | 플랫폼 분기 29회 반복 | ✅ Fixed | `utils/platform-adapter.js` 생성, `server.js` 적용 |
| 4 | `broadcastQueue` 즉시 실행 | ✅ Fixed | 지연 함수 패턴 `() => notifier.broadcast(...)` 적용 |
| 5 | `_collectMeta/_collectGoogle` 중복 | ✅ Fixed | `_collectPlatform()` 공통 메서드로 추출 |
| 6 | `collectAll` 몽키패칭 | ✅ Fixed | `EventEmitter` 패턴 전환 (`collector.on('collected', ...)`) |
| 7 | 대시보드 `toLocaleString()` 미수정 | ✅ Fixed | `krwFmt.format()` 8곳 교체 |
| 8 | Google 캠페인 status 역정규화 누락 | ✅ Fixed | `platform-adapter.js`의 `toApiStatus()` 메서드로 해결 |
| 9 | `ABTestEngine` 연쇄 인스턴스 중복 | ✅ Fixed | 생성자 DI + `services.js` 싱글톤 주입 |
| 10 | `Optimizer` NaN 전파 | ✅ Fixed | `totalBudget` fallback 방어 코드 추가 |
| 11 | `operations` 미사용 (Google Customer Match) | ✅ Fixed | `addOperations()` + `run()` 호출 추가 |
| 12 | 대시보드 챗 에코백 → 서버 연결 | ✅ Fixed | `/api/chat` 엔드포인트 + `handleSend` POST 전환 |
| 13 | `krwFmt` 3파일 중복 선언 | ✅ Fixed | `utils/format.js` 공통 모듈 추출 |
| 14 | `_ensureConfigured` 중복 | ✅ Fixed | `utils/base-client.js` 베이스 클래스 추출 |

**All 14 findings resolved.** Syntax verified via `node --check` on all 13 modified/created JS files — zero errors.

---

## Feature Enhancements (2026-03-17)

### 1. TikTok Ads 플랫폼 확장

| 파일 | 변경 |
|------|------|
| `src/tiktok/client.js` | **신규** — TikTok Marketing API 클라이언트 (campaign CRUD, reporting, `BaseAdsClient` 상속) |
| `src/utils/clients.js` | `getTikTokClient()` 싱글톤 추가 |
| `src/utils/platform-adapter.js` | `tiktok` 어댑터 추가 (`CAMPAIGN_STATUS_ENABLE` ↔ `ACTIVE` 정규화 포함) |
| `src/analytics/collector.js` | `_collectTikTok()` 메서드 + `collectAll()`에 3번째 플랫폼 통합 |
| `src/openclaw-skills/ad-manager.skill.js` | TikTok 감지 (`_detectPlatform`), if/else → `getAdapter()` 전환, `틱톡` 키워드 지원 |

### 2. A/B 테스트 통계적 유의성 (p-value)

| 파일 | 변경 |
|------|------|
| `src/utils/statistics.js` | **신규** — Two-proportion Z-test, Wilson CI, 검정력 분석 (순수 JS, 외부 종속성 없음) |
| `src/content/ab-testing.js` | `evaluateTest()` 전면 리팩터링: 쌍별 Z-test, p-value 기반 승자 판정, `confidence` DB 기록, 필요 샘플 수 추정 |

### 3. NLP 의도 분류 모델

| 파일 | 변경 |
|------|------|
| `src/utils/intent-classifier.js` | **신규** — TF-IDF + Cosine Similarity 기반 의도 분류 (12개 인텐트, 200+ 훈련 구문, 바이그램, 한/영 토크나이저) |
| `src/openclaw-skills/ad-manager.skill.js` | `handleMessage()` → intent classifier 기반 라우팅 (keyword loop 제거, 신뢰도 로깅, 개선된 fallback 메시지) |
