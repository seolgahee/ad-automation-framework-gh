# Ad Automation Framework — Code Review v7 (Deep)

**Review Date**: 2026-03-17
**Scope**: v6 수정 이후 전체 코드베이스 21개 파일 재검토
**Review Dimensions**: 설계 우아함 · 간결성 · 잠재적 버그 · 목적 달성 · 보안 · 중복 · 성능 · 공통화 · 불필요 코드

---

## Executive Summary

v6에서 5건 전체 수정 후 전체를 재점검했습니다. v5의 REST API 차단 → v6의 데이터 타입 오류 → v7에서는 **스키마 무결성과 미완성 플랫폼 지원** 계층의 이슈로 전환되었습니다. 가장 주목할 발견은 `db.js`의 `CHECK(platform IN ('meta', 'google'))` 제약 조건에서 **TikTok이 제외**되어, 수집기(collector)가 TikTok 캠페인 데이터를 DB에 삽입할 때 CHECK 위반 에러가 발생하는 점입니다.

**발견 건수**: HIGH 1 · MEDIUM 0 · LOW 3 · INFO 2

---

## HIGH — 데이터 무결성

### 1. `db.js` — `campaigns` 테이블 CHECK 제약조건에서 TikTok 누락

**File**: `src/utils/db.js` (L21)

```js
platform TEXT NOT NULL CHECK(platform IN ('meta', 'google')),
```

`collector.js`의 `_collectPlatform('tiktok', ...)`이 TikTok 캠페인을 `INSERT INTO campaigns`할 때, SQLite CHECK 제약조건 위반으로 **삽입이 실패**합니다. TikTok 데이터 수집 자체가 작동하지 않는 심각한 버그입니다.

**Impact**: TikTok 캠페인 데이터가 DB에 저장되지 않음 → 대시보드, 리포트, 최적화 모두 TikTok 데이터 누락
**Fix**:
```js
platform TEXT NOT NULL CHECK(platform IN ('meta', 'google', 'tiktok')),
```

> **Note**: 이미 DB가 생성된 환경에서는 `CREATE TABLE IF NOT EXISTS`로 인해 스키마가 자동 변경되지 않습니다. 마이그레이션 전략 필요: (1) 새 테이블 생성 + 데이터 이전, 또는 (2) 개발 환경에서 DB 파일 삭제 후 재시작.

---

## LOW — 미완성 지원 / 간결성

### 2. `audience-manager.js` — TikTok 오디언스 미지원

**File**: `src/content/audience-manager.js` (전체)

JSDoc에 "Unified audience creation and management across Meta and Google"로 명시하고, 생성자에서 `this.meta`와 `this.google`만 초기화합니다. `createCustomAudience()`, `createLookalike()` 등 모든 메서드가 Meta/Google만 처리합니다.

**Impact**: TikTok 오디언스 타겟팅 불가 (기능적 제한, 런타임 에러는 아님)
**Fix**: TikTok 오디언스 API 연동 추가. 단, TikTok Marketing API의 오디언스 엔드포인트 사용 가능 여부 확인 필요.

### 3. `copy-templates.js` — TikTok 전용 템플릿 부재

**File**: `src/content/copy-templates.js` (내장 템플릿 목록)

`meta-sale`, `meta-launch`, `google-search`, `google-display` 등 Meta/Google 전용 템플릿만 있고, TikTok 특성(짧은 비디오 카피, 해시태그, CTA 스타일)에 맞는 템플릿이 없습니다.

**Impact**: TikTok 크리에이티브 생성 시 범용 템플릿 사용 → 플랫폼 최적화 부족
**Fix**: `tiktok-video`, `tiktok-spark` 등 TikTok 전용 템플릿 추가.

### 4. `statistics.js` — `twoProportionZTest` 입력 검증 부재

**File**: `src/utils/statistics.js` (L46-49)

```js
export function twoProportionZTest(conversionsA, trialsA, conversionsB, trialsB) {
  if (trialsA <= 0 || trialsB <= 0) {
    return { zScore: 0, pValue: 1, significant: false, ... };
  }
```

`conversions > trials` (전환 수 > 시도 수) 케이스를 검증하지 않습니다. 잘못된 데이터가 들어오면 `rate > 1.0`이 계산되어 무의미한 통계 결과가 생성됩니다.

**Impact**: 데이터 입력 오류 시 잘못된 유의성 판정 가능 (garbage-in → garbage-out)
**Fix**:
```js
if (conversionsA > trialsA || conversionsB > trialsB) {
  throw new Error('Conversions cannot exceed trials');
}
```

---

## INFO — 관찰 / 강점

### 5. 아키텍처 성숙도 — v3→v7 진화 추적

| 패턴 | v3 도입 | v4 확장 | v5 정제 | v6 정리 | v7 상태 |
|------|---------|---------|---------|---------|---------|
| Platform Adapter | `getAdapter()` | +TikTok adapter | — | — | 안정 (3 platforms) |
| Registration Map | — | `registrationMap` 패턴 | — | — | 일관 적용 완료 |
| Singleton Registry | clients.js | +services.js | — | 데드 참조 제거 | 클린 상태 |
| SSoT | — | INTENT_DEFINITIONS | — | — | 단일 소스 유지 |
| Common Wrapper | — | — | `_registerCreative()`, `_setCampaignStatus()` | — | DRY 달성 |
| Statistical Testing | — | Z-test + Wilson CI | +power analysis guard | — | 수학적 완결 |
| Intent Classifier | — | TF-IDF + bigram | +inverted index IDF | — | 최적화 완료 |
| Media Type Logic | — | — | — | platform별 type 분기 | 정확성 확보 |
| Import Hygiene | — | — | — | 데드 임포트/속성 제거 | 클린 상태 |

### 6. 목적 달성도 평가 (v7 기준)

| 목적 | 달성도 | v6 대비 | 비고 |
|------|--------|---------|------|
| 멀티 플랫폼 | ✅ 93% | -3% | DB 스키마 차단으로 TikTok 데이터 저장 불가 발견 |
| A/B 테스트 | ✅ 93% | ±0% | 통계 엔진 안정, 입력 검증 보완 필요 |
| NL 챗봇 | ✅ 94% | ±0% | 12 intent SSoT 유지 |
| 확장성 | ✅ 95% | ±0% | 어댑터/레지스트리/래퍼 패턴 일관 |
| 코드 품질 | ✅ 95% | +1% | v6 데드 코드 전체 정리, import 위생 확보 |

**코드 품질 점수: 95/100** (v6: 94 → v7: 95, +1pt)

> 멀티 플랫폼 달성도가 v6(96%) 대비 하락한 이유: v6에서 런타임 동작으로만 검증했으나 v7에서 스키마 레벨까지 심층 검증하면서 CHECK 제약조건 이슈를 발견했기 때문입니다. 실제 코드 품질은 지속 향상 중이며, 스키마 수정 후 98%+ 달성 가능합니다.

---

## Priority Action Items

| # | Severity | Effort | Item | Impact |
|---|----------|--------|------|--------|
| 1 | HIGH | 3m | `db.js` CHECK 제약조건에 `'tiktok'` 추가 | TikTok 데이터 저장 가능 |
| 2 | LOW | 30m+ | `audience-manager.js` TikTok 오디언스 지원 | 기능 완성도 |
| 3 | LOW | 15m | `copy-templates.js` TikTok 전용 템플릿 | 콘텐츠 최적화 |
| 4 | LOW | 2m | `statistics.js` conversions > trials 검증 | 데이터 무결성 |

**Estimated total**: #1(3m) + #4(2m) = **5분** (코드 수정) / #2-3은 기능 확장 (별도 스프린트 권장)
**Recommended priority**: #1(스키마 — 즉시) → #4(검증) → #2-3(기능 확장)
