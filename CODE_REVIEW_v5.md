# Ad Automation Framework — Code Review v5 (Deep)

**Review Date**: 2026-03-17
**Scope**: v4 수정 이후 전체 코드베이스 21개 파일 재검토
**Review Dimensions**: 설계 우아함 · 간결성 · 잠재적 버그 · 목적 달성 · 보안 · 중복 · 성능 · 공통화 · 불필요 코드

---

## Executive Summary

v4에서 9건 전체 수정 완료 후 전체 코드베이스를 재점검했습니다. **가장 심각한 발견은 `server.js`의 `ALLOWED_PLATFORMS` 배열에 `'tiktok'`이 누락**되어 있어, 모든 REST API 엔드포인트가 TikTok 요청을 `400 Invalid platform`으로 거부하는 버그입니다. 또한 `optimizer.js`의 리포트 생성에서 TikTok 데이터가 누락되는 문제가 있습니다. 설계적으로는 `creative-pipeline.js`의 3개 register 메서드가 동일한 패턴을 반복하고 있어 공통화 여지가 있으며, `handlePause`/`handleEnable`도 상태값만 다른 중복 구조입니다.

**발견 건수**: HIGH 1 · MEDIUM 3 · LOW 3 · INFO 2

---

## HIGH — 잠재 버그

### 1. `server.js` — `ALLOWED_PLATFORMS`에 `'tiktok'` 누락 (전체 API 차단)

**File**: `src/server.js` (L77)

```js
const ALLOWED_PLATFORMS = ['meta', 'google'];
```

`validatePlatform()` 함수가 이 배열을 참조합니다. TikTok 플랫폼 확장 후 이 배열이 업데이트되지 않아, **다음 모든 엔드포인트에서 `platform: 'tiktok'` 요청이 400 에러**로 거부됩니다:

- `POST /api/creatives/assemble` (L345)
- `POST /api/creatives/:id/register` (L361)
- `POST /api/creatives/pipeline` (L386)
- `POST /api/ab-tests` (L416)
- `GET /api/performance/timeline` (L175)
- `GET /api/templates` (L299)

**Impact**: REST API를 통한 TikTok 작업이 **전면 차단**됨. 채팅 인터페이스(`/api/chat`)는 `validatePlatform()`을 경유하지 않으므로 영향 없음.
**Fix**: `const ALLOWED_PLATFORMS = ['meta', 'google', 'tiktok'];`

추가로, `POST /api/creatives/:id/register` (L365-374)에서 TikTok 등록 경로도 누락:

```js
if (platform === 'meta') {
  result = await creativePipeline.registerToMeta({ ... });
} else {
  result = await creativePipeline.registerToGoogle({ ... });  // ← TikTok도 여기
}
```

**Fix**: `registrationMap` 패턴으로 교체 (creative-pipeline.js의 `runFullPipeline()` 참조).

---

## MEDIUM — 잠재 버그 / 간결성 / 공통화

### 2. `optimizer.js` — `generateReport()`에서 TikTok 데이터 누락

**File**: `src/analytics/optimizer.js` (L165-177)

```js
const byPlatform = { meta: [], google: [] };
summary.forEach(c => byPlatform[c.platform]?.push(c));
```

`byPlatform` 객체에 `tiktok` 키가 없으므로 `?.push(c)`가 무시되어 **TikTok 캠페인이 리포트에서 완전히 누락**됩니다. L170의 플랫폼 라벨도 2분기:

```js
report += `*${platform === 'meta' ? 'Meta' : 'Google'} Ads*\n`;
```

TikTok 캠페인이 표시될 경우 "Google Ads"로 잘못 표기됩니다.

**Impact**: 성과 리포트에서 TikTok 데이터 누락 + 잘못된 라벨
**Fix**:
```js
const byPlatform = { meta: [], google: [], tiktok: [] };
// ...
const platformLabels = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' };
report += `*${platformLabels[platform] || platform} Ads*\n`;
```

### 3. `creative-pipeline.js` — `assembleCreative()`에 TikTok 미디어 업로드 경로 없음

**File**: `src/content/creative-pipeline.js` (L131-136)

```js
if (platform === 'meta') {
  mediaRef = await this.uploadImageToMeta(mediaPath);
} else {
  mediaRef = await this.uploadImageToGoogle(mediaPath, `creative_${Date.now()}`);
}
```

TikTok 크리에이티브 조립 시 미디어 파일이 있으면 **Google에 업로드**됩니다. TikTok은 비디오 중심 플랫폼이므로 업로드 방식이 다릅니다 (Video Upload API 사용).

**Impact**: TikTok 크리에이티브의 미디어가 잘못된 플랫폼에 업로드
**Fix**: TikTok 비디오 업로드 메서드 추가 + 3분기 분기 또는 `mediaUploadMap` 패턴 적용.

### 4. `ad-manager.skill.js` — `handlePause` / `handleEnable` 중복 구조

**File**: `src/openclaw-skills/ad-manager.skill.js` (L119-146)

두 메서드의 구조가 **거의 동일**합니다:
1. `_extractCampaignName(message)`
2. DB 조회
3. `getAdapter().setStatus()`
4. DB 업데이트
5. 결과 메시지 반환

차이: 상태값(`'PAUSED'` vs `'ACTIVE'`), 아이콘(`⏸️` vs `▶️`), 메시지(`일시중지됨` vs `활성화됨`).

**Impact**: 12줄 중복, 한쪽만 수정 시 불일치 위험
**Fix**: 공통 헬퍼 `_setStatus(message, targetStatus, icon, label)` 추출:
```js
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
handlePause(msg) { return this._setCampaignStatus(msg, 'PAUSED', '⏸️', '일시중지됨'); }
handleEnable(msg) { return this._setCampaignStatus(msg, 'ACTIVE', '▶️', '활성화됨'); }
```

---

## LOW — 간결성 / 공통화 / 불필요 코드

### 5. `creative-pipeline.js` — 3개 register 메서드의 공통 패턴 미추출

**File**: `src/content/creative-pipeline.js` (L165-264)

`registerToMeta()`, `registerToGoogle()`, `registerToTikTok()` 모두 동일한 5단계 패턴:
1. DB에서 creative 조회 + not found guard
2. 플랫폼 API 호출 (유일한 차이)
3. DB 상태 업데이트 (`UPDATE creatives SET ... status = 'UPLOADED'`)
4. 로깅
5. 알림 broadcast

**Impact**: ~30줄 반복 (총 90줄 중 60줄이 공통)
**Fix**: 공통 래퍼 추출:
```js
async _registerCreative(creativeId, campaignId, adSetOrGroup, platform, apiCall) {
  const creative = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get(creativeId);
  if (!creative) throw new Error(`Creative ${creativeId} not found`);
  const result = await apiCall(creative);
  db.prepare(`UPDATE creatives SET campaign_id = ?, ad_set_id = ?, status = 'UPLOADED', updated_at = datetime('now') WHERE id = ?`)
    .run(campaignId, adSetOrGroup, creativeId);
  logger.info(`Creative registered to ${platform}`, { creativeId, adSetOrGroup });
  await notifier.broadcast(`새 광고 등록: ${creative.name} → ${platform} (${adSetOrGroup})`, { severity: 'info' });
  return result;
}
```

### 6. `server.js` — `byPlatform` 응답에 TikTok 누락

**File**: `src/server.js` (L150-153)

```js
byPlatform: {
  meta: summary.filter(c => c.platform === 'meta'),
  google: summary.filter(c => c.platform === 'google'),
},
```

`GET /api/overview` 응답에서 TikTok 캠페인 데이터가 `byPlatform`에 포함되지 않습니다. `totals` 집계에는 포함되지만, 플랫폼별 상세 분석에서 누락.

**Fix**: `tiktok: summary.filter(c => c.platform === 'tiktok')` 추가.

### 7. JSDoc / 주석 미갱신 (3건)

| File | Line | 내용 |
|------|------|------|
| `creative-pipeline.js` | L7 | "Supports both Meta and Google Ads" → TikTok 누락 |
| `creative-pipeline.js` | L119 | `@param {string} params.platform - 'meta' or 'google'` → TikTok 누락 |
| `collector.js` | L2 | "fetches performance data from both Meta and Google" → TikTok 누락 |

**Impact**: 문서와 코드 불일치, 신규 개발자 혼동 가능
**Fix**: JSDoc에 TikTok 포함.

---

## INFO — 관찰 / 강점

### 8. 아키텍처 성숙도 평가

- **Platform Adapter 패턴**: `updateBudget`, `setStatus`에서 일관되게 사용 — 4번째 플랫폼(Kakao Moment, Naver 등) 추가 시 adapter만 구현하면 됨
- **Singleton Registry**: clients.js + services.js 이중 레이어로 인프라/비즈니스 계층 분리가 깔끔함
- **Intent Classifier**: TF-IDF + exact match boost 하이브리드가 한국어 짧은 메시지에 실용적. 외부 의존성 zero.
- **Statistical Testing**: Wilson CI + power analysis까지 구현하여 A/B 테스트 조기 종료 방지
- **Event-driven Architecture**: DataCollector의 EventEmitter → server.js의 WebSocket broadcast 연결이 결합도 낮음
- **Registration Map Pattern**: v4에서 도입한 `registrationMap` 패턴이 ab-testing.js, creative-pipeline.js에 일관 적용

### 9. 목적 달성도 평가 (v5 기준)

| 목적 | 달성도 | v4 대비 | 비고 |
|------|--------|---------|------|
| 멀티 플랫폼 | ⚠️ 85% | -10% | 채팅은 OK, REST API에서 TikTok 차단 (#1) |
| A/B 테스트 | ✅ 92% | +2% | p-value + Wilson CI + power analysis 완비 |
| NL 챗봇 | ✅ 93% | +1% | TF-IDF intent classifier + SSoT |
| 확장성 | ✅ 90% | -3% | Adapter 패턴 우수하나 server.js 하드코딩 잔존 |
| 코드 품질 | ✅ 88% | +5% | v4 9건 수정으로 DRY/성능 개선 |

---

## Priority Action Items

| # | Severity | Effort | Item | Impact |
|---|----------|--------|------|--------|
| 1 | HIGH | 10m | `server.js` ALLOWED_PLATFORMS에 'tiktok' 추가 + register 엔드포인트 3분기 | **TikTok REST API 전면 차단** |
| 2 | MEDIUM | 15m | `optimizer.js` generateReport() TikTok 지원 | 리포트 데이터 누락 |
| 3 | MEDIUM | 30m | `creative-pipeline.js` assembleCreative() TikTok 미디어 업로드 | 미디어 잘못된 플랫폼 |
| 4 | MEDIUM | 10m | `handlePause`/`handleEnable` 공통 헬퍼 추출 | DRY |
| 5 | LOW | 20m | `creative-pipeline.js` register 메서드 공통화 | DRY (60줄 절감) |
| 6 | LOW | 5m | `server.js` overview byPlatform에 tiktok 추가 | 대시보드 데이터 완전성 |
| 7 | LOW | 5m | JSDoc/주석 갱신 (3건) | 문서 정확성 |

**Estimated total: ~1.5 hours**
**Recommended priority**: #1(API 차단 버그) → #2(리포트 누락) → #6(대시보드) → #3(미디어) → #4(DRY) → #5(DRY) → #7(문서)

---

## Resolution Status (2026-03-17)

| # | Severity | Item | Status | Resolution |
|---|----------|------|--------|------------|
| 1 | HIGH | `ALLOWED_PLATFORMS`에 tiktok 누락 + register 엔드포인트 | ✅ Fixed | 배열에 `'tiktok'` 추가 + `registrationMap` 패턴 적용 |
| 2 | MEDIUM | `generateReport()` TikTok 데이터 누락 | ✅ Fixed | `byPlatform`에 tiktok 키 + `platformLabels` 맵 적용 |
| 3 | MEDIUM | `assembleCreative()` TikTok 미디어 업로드 누락 | ✅ Fixed | `mediaUploadMap` 패턴 + TikTok `uploadVideo()` 메서드 추가 |
| 4 | MEDIUM | `handlePause`/`handleEnable` 중복 | ✅ Fixed | `_setCampaignStatus()` 공통 헬퍼로 추출 |
| 5 | LOW | register 메서드 60줄 공통 패턴 | ✅ Fixed | `_registerCreative()` 공통 래퍼 추출 (90줄 → 55줄) |
| 6 | LOW | overview `byPlatform`에 tiktok 누락 | ✅ Fixed | `tiktok` 키 추가 |
| 7 | LOW | JSDoc/주석 미갱신 3건 | ✅ Fixed | creative-pipeline.js (3곳) + collector.js (1곳) 갱신 |

**Result: 7/7 Fixed** — Syntax verified: 21/21 files pass `node --check`

---

## v4 → v5 변화 요약

| 지표 | v4 | v5 | 변화 |
|------|----|----|------|
| 발견 건수 | HIGH 2, MED 4, LOW 3 | HIGH 1, MED 3, LOW 3 | HIGH -1, MED -1 |
| 주요 패턴 | TikTok 경로 누락, 이중 관리 | TikTok REST API 미반영, 중복 메서드 | 비즈니스 로직 → 인프라 계층으로 이동 |
| 코드 품질 | 87/100 | 91/100 | +4pt (v4 수정 효과) |
