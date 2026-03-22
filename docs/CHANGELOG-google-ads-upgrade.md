# Google Ads API 업그레이드 로그 (2026-03-19)

## 배경

`npm run sync-campaigns` 실행 시 Google 데이터만 동기화 실패, Meta는 정상.

---

## 발생한 에러와 수정 내역 (시간순)

### 1. `GRPC UNIMPLEMENTED: GRPC target method can't be resolved`
- **원인:** `google-ads-api@16.0.0`이 사용하는 Google Ads API v16이 2025-01 sunset됨
- **수정:** `npm install google-ads-api@latest` → v23.0.0 설치
- **파일:** `package.json`

### 2. `USER_PERMISSION_DENIED`
- **원인:** OAuth 인증에 사용한 Google 계정이 광고 고객 계정(743-657-8905)에 접근 권한 없었음
- **수정:** Google Ads 관리자 콘솔에서 해당 계정에 권한 수동 추가 (코드 변경 없음)

### 3. `BAD_ENUM_CONSTANT: Invalid enum values '2', '3'`
- **원인:** v16에서는 GAQL WHERE절에 enum 숫자값(2, 3)을 사용 가능했으나, v23에서는 문자열 enum 이름만 허용
- **수정:** `src/google/client.js` `getCampaigns()`
- **Before:** `WHERE campaign.status IN (${statusValues.join(',')})` → 숫자 2,3
- **After:** `WHERE campaign.status IN ('${safeFilter.join("','")}')` → 문자열 'ENABLED','PAUSED'

### 4. `Unrecognized fields: 'campaign.start_date', 'campaign.end_date'`
- **원인:** API v23에서 필드명 변경
- **수정:** `src/google/client.js` `getCampaigns()` GAQL SELECT절 및 응답 매핑
- **Before:** `campaign.start_date`, `campaign.end_date`
- **After:** `campaign.start_date_time`, `campaign.end_date_time`

### 5. 에러 로깅 개선
- **원인:** v23 에러 객체에 `.message`가 없고 `.errors` 배열에 상세 정보가 담기는 구조 → `err.message`가 `undefined` 출력
- **수정:** `scripts/sync-campaigns.js`
- **Before:** `console.error('Google sync failed:', err.message)`
- **After:** `console.error('Google sync failed:', err.message || JSON.stringify(err.errors || err, null, 2))`

---

## 수정된 파일 목록
| 파일 | 변경 내용 |
|---|---|
| `package.json` | google-ads-api ^16.0.0 → ^23.0.0 |
| `src/google/client.js` | GAQL enum 형식 변경, 필드명 변경 |
| `scripts/sync-campaigns.js` | 에러 로깅 개선 |

---

## Merging 시 주의사항
- 다른 팀원 환경이 v16 기반이면 `src/google/client.js`의 GAQL 쿼리 부분에서 충돌 가능
- **반드시 v23 기준으로 resolve할 것** — v16은 sunset되어 동작 불가
- `getPerformance()` 메서드의 GAQL은 문자열 enum을 직접 사용하고 있어 현재 문제없음
- 다른 메서드에서 숫자 enum(`enums.XXX[key]`)을 GAQL에 넣는 곳이 있다면 같은 패턴으로 수정 필요
