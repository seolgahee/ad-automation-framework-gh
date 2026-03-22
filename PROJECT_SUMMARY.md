# Ad Automation Framework — 프로젝트 정리

**최초 작성일**: 2026-03-18
**최종 수정일**: 2026-03-22

## 프로젝트 개요

Meta(Facebook) & Google Ads API를 연동하여 광고 성과 데이터를 자동 수집하고,
실시간 대시보드와 챗봇으로 캠페인을 모니터링/관리하는 자동화 프레임워크.

> 상무님 지시로 Meta API 연결 및 데이터 수집 구현 진행 중

---

## 기술 스택

| 구분 | 기술 |
|---|---|
| 백엔드 | Node.js, Express, WebSocket |
| 데이터베이스 | SQLite (better-sqlite3) |
| 프론트엔드 | React, Recharts, Tailwind CSS |
| Meta API | facebook-nodejs-business-sdk |
| Google API | google-ads-api |
| 스케줄러 | node-cron (15분 주기) |
| 로깅 | Winston (구조화 로그) |
| 알림 | Slack Webhook / Telegram Bot |

---

## 전체 파일 구조 (2026-03-20 ver.)

```
ad-automation-framework/
├── src/
│   ├── server.js                # Express API 서버 + WebSocket (port 3099)
│   ├── analytics/               # ** 이부분 로직 설계가 가장 중요 **
│   │   ├── collector.js         # Meta + Google + TikTok 데이터 수집 (15분 주기)
│   │   └── optimizer.js         # ROAS/CPA 기반 예산 최적화 (캠페인 예산 재분배 - 브랜드 설정 필요)
│   ├── content/
│   │   ├── copy-templates.js    # 광고 카피 템플릿 엔진
│   │   ├── creative-pipeline.js # 소재 조립 → 플랫폼 등록
│   │   ├── ab-testing.js        # A/B 테스트 관리
│   │   └── audience-manager.js  # 오디언스/타겟팅 관리
│   ├── meta/
│   │   └── client.js            # Meta Marketing API 클라이언트 (연동 완료)
│   ├── google/
│   │   └── client.js            # Google Ads API 클라이언트 (연동 완료)
│   ├── tiktok/
│   │   └── client.js            # TikTok Ads API 클라이언트 (자격증명 미설정)
│   ├── openclaw-skills/
│   │   └── ad-manager.skill.js  # 챗봇 스킬 (TF-IDF 의도 분류)
│   ├── utils/
│   │   ├── base-client.js       # 플랫폼 클라이언트 베이스 클래스 (타임아웃 헬퍼)
│   │   ├── clients.js           # 플랫폼 클라이언트 싱글톤
│   │   ├── db.js                # SQLite 스키마 & 초기화
│   │   ├── format.js            # KRW 포맷터
│   │   ├── intent-classifier.js # TF-IDF 의도 분류기 (순수 JS, 외부 AI 미사용)
│   │   ├── logger.js            # Winston 구조화 로거
│   │   ├── notifier.js          # Slack/Telegram 알림 발송
│   │   ├── platform-adapter.js  # 3-플랫폼 통합 어댑터
│   │   ├── services.js          # 서비스 싱글톤 레지스트리
│   │   └── statistics.js        # 통계 엔진 (Z-test, Wilson CI)
│   └── dashboard/
│       └── index.html           # React 대시보드 (port 3100)
├── scripts/
│   ├── setup.js                 # 초기 설정 스크립트
│   ├── collect-data.js          # 수동 데이터 수집
│   ├── collect-historical.js    # 과거 데이터 백필 (Meta + Google 지원)
│   └── sync-campaigns.js        # 캠페인 동기화
├── config/
│   └── default.env              # 환경변수 템플릿
├── .env                         # 실제 환경변수 (API 키 등)
└── package.json
```

---

## 데이터 흐름

```
Meta API / Google API / TikTok API
   ↓ (15분마다 자동 수집 — collector.js)
SQLite (data/ads.db) — WAL 모드
   ↓
Express API 서버 (port 3099)
   ↓              ↓              ↓
대시보드        챗봇 (Ask)    WebSocket (실시간)
(차트/KPI)    (성과 조회)    (자동 갱신)
                              ↓
                         Slack / Telegram 알림
```

---

## 수집 데이터 (SQLite 테이블 — 11개)

| 테이블 | 내용 |
|---|---|
| `campaigns` | 캠페인 마스터 (Meta/Google 통합, platform 컬럼으로 구분) |
| `ad_groups` | 광고그룹/광고세트 계층 |
| `ads` | 개별 광고 계층 |
| `performance` | 캠페인별 성과 스냅샷 (15분 주기, ROAS/CPA/CTR/지출) |
| `ad_performance` | 소재(Ad) 레벨 성과 |
| `alerts` | ROAS/CPA 임계값 초과 알림 이력 |
| `budget_history` | 예산 변경 감사 이력 |
| `creatives` | 광고 소재 정보 (템플릿 기반 조립) |
| `creative_performance` | 소재 성과 (크리에이티브 파이프라인용) |
| `ab_tests` | A/B 테스트 메타데이터 |
| `audiences` | 오디언스/타겟팅 레지스트리 |
| `copy_templates` | 광고 카피 템플릿 |

---

## 알림 임계값 (.env 설정)

| 지표 | 기본값 | 환경변수 |
|---|---|---|
| ROAS | < 1.5 | `ALERT_ROAS_THRESHOLD` |
| CPA | > ₩50,000 | `ALERT_CPA_THRESHOLD` |
| 예산 소진율 | > 85% | `ALERT_BUDGET_BURN_RATE` |

---

## 챗봇 명령어 (대시보드 Ask)

| 입력 | 동작 |
|---|---|
| `캠페인 목록` | 전체 캠페인 리스트 |
| `오늘 광고 성과 알려줘` | 오늘 성과 리포트 |
| `예산 최적화 추천해줘` | ROAS 기반 예산 재배분 제안 |
| `알림 확인` | 최근 알림 조회 |
| `템플릿 목록 보여줘` | 광고 카피 템플릿 |

> 키워드 기반 규칙 엔진 (외부 AI 미사용)

---

## 서버 실행 방법

```bash
cd ad-automation-framework
npm run dev
```

- API 서버: http://localhost:3099
- 대시보드: http://localhost:3100
- WebSocket: ws://localhost:3099/ws

---

## 2026-03-18 작업 내역

### 환경 세팅
- [x] Visual Studio Build Tools 설치 (C++ 컴파일러 — better-sqlite3 빌드용)
- [x] `npm install` 의존성 설치
- [x] `.env` 파일 생성 (Meta 토큰, Ad Account ID: `act_1077101447901781`)

### 버그 수정
- [x] 대시보드 흰 화면 문제 — `prop-types` 라이브러리 누락 수정
- [x] Meta 캠페인 조회 오류 — `filtering` → `effective_status` 파라미터 수정
- [x] Meta 액세스 토큰 만료 — 신규 토큰으로 갱신 (두 .env 파일 모두 업데이트)

### 기능 추가
- [x] 소재(Ad) 레벨 데이터 수집 추가
  - `src/meta/client.js` — `getAdInsights()` 메서드 추가
  - `src/analytics/collector.js` — `_collectMetaAdLevel()` 메서드 추가
  - `src/utils/db.js` — `ad_performance` 테이블 추가

### 수집 결과
- 캠페인 25개 수집 완료
- 성과 데이터 13개 수집 완료
- 소재 레벨 데이터 수집 준비 완료 (재시작 후 활성화)

---

## 2026-03-19~20 작업 내역

### 버그 수정
- [x] Performance Overview 플랫폼 필터 수정 — All/Meta/Google 전환 시 동일 수치 표시 문제
  - `src/server.js` — `/api/overview` 엔드포인트에 `platform` 쿼리 파라미터 필터링 추가

### 코드 품질 개선 (CODE_REVIEW_v8 Action Plan 적용)
- [x] **외부 API 호출 30초 타임아웃** 추가
  - `src/utils/base-client.js` — `_withTimeout()` 헬퍼 메서드 추가
  - `src/meta/client.js` — 8곳 모든 API 호출에 타임아웃 적용
  - `src/google/client.js` — 9곳 모든 API 호출에 타임아웃 적용
  - (TikTok은 이미 AbortController로 구현되어 있어 변경 불필요)
- [x] **환경변수 유효성 검증** 추가
  - `src/server.js` — 서버 시작 시 `validateEnv()` 실행, 필수 변수 누락 시 명확한 warning 출력
- [x] **에러 메시지 클라이언트 분리**
  - `src/server.js` — `safeError()` 헬퍼 추가, 13곳의 내부 에러 직접 노출 제거
  - 서버 로그에만 상세 에러, 클라이언트에는 일반 메시지 반환

### 문서 작성
- [x] CODE_REVIEW_v8.md 작성 (전체 코드 리뷰, 20개 이슈 분류, 로컬/프로덕션 단계별 Action Plan)
- [x] INSTALL_GUIDE.md 최신화 (파일 구조, 날짜 추가, 누락 파일 반영)
- [x] PROJECT_SUMMARY.md 최신화 (테이블 목록, 파일 구조, 데이터 흐름, 작업 내역)

### 테스트 결과
- 94개 테스트 전체 통과 (637ms)

### 수집 현황
- Meta 캠페인 25개, 성과 11건, 소재 레벨 25건 수집 중
- Google 캠페인 174개, 성과 174건 수집 중
- TikTok 자격증명 미설정으로 스킵

### Google 과거 데이터 백필
- [x] `scripts/collect-historical.js` Google 백필 지원 추가
  - 기존 Meta 전용 → Meta + Google 통합 스크립트로 확장
  - 플랫폼 선택 인자 추가: `node scripts/collect-historical.js <since> <until> [meta|google]`
  - 인자 생략 시 Meta + Google 모두 백필
- [x] Google 3월분 백필 실행 완료
  - 기간: 2026-03-01 ~ 2026-03-20 (20일간)
  - 매일 174개 캠페인 × 20일 = **총 3,480건** 성과 데이터 저장
  - 전체 날짜 오류 없이 수집 완료

---

## 2026-03-20 작업 내역 (2)

### `ad_performance` 테이블 스키마 수정
- [x] UNIQUE 제약조건에 `platform` 추가 — 다른 플랫폼 동일 `ad_id` 충돌 방지
- [x] `platform` CHECK 제약조건 추가 — `('meta', 'google', 'tiktok')` 허용
- [x] `idx_adperf_ad` 인덱스에 `platform` 컬럼 추가
- [x] `collector.js` ON CONFLICT 절 수정 — `ON CONFLICT(ad_id, platform, date_start)`
- [x] SQLite 마이그레이션 로직 추가 — rename-copy-drop 패턴, 트랜잭션 안전
  - `src/utils/db.js` — `migrateAdPerformance()` 함수 추가 (기존 DB 자동 감지 및 마이그레이션)

### 소재 성과 갤러리 (Creatives) 구현
- [x] **API 엔드포인트 2개 추가** (`src/server.js`)
  - `GET /api/ad-performance` — 소재별 성과 데이터 조회 (platform/sort/days 필터, GROUP BY ad_id+platform)
  - `GET /api/ad-performance/summary` — 갤러리 상단 KPI 집계 (총 소재 수, 총 지출, 평균 ROAS/CTR/CPA)
- [x] **대시보드 Creatives 갤러리 뷰 구현** (`src/dashboard/index.html`)
  - Perplexity Marketing Automation 스타일 참고 (카드 갤러리형)
  - 사이드바 Content > Creatives 클릭 시 전용 화면으로 전환
  - 상단 KPI 카드 5개 (총 소재 수, 총 지출, 평균 ROAS, 평균 CTR, 평균 CPA)
  - 필터바: 매체별(All/Meta/Google), 성과 등급(전체/Best/Good/Low, ROAS 기준), 정렬(지출/ROAS/CTR/노출수/전환수/CPA)
  - 기간 선택: 1일/7일/14일/30일/전체
  - 4열 카드 그리드: 그라디언트 썸네일 + 매체 배지 + 성과 등급 + 6개 지표
  - 이미지 미수집 상태 hover 오버레이 표시
  - WebSocket 연동 — 데이터 수집 시 자동 갱신
- [x] 현재 수집 데이터: Meta 소재 59개 (3/18~3/19), 지출 합계 ₩193,889

### Google 소재 레벨 수집 구현
- [x] **`src/google/client.js` — `getAdInsights()` 메서드 추가**
  - Google Ads는 캠페인 유형에 따라 ad-level 리소스가 다름:
    - `ad_group_ad`: SEARCH, DISPLAY, VIDEO, SHOPPING 등 일반 캠페인
    - `asset_group`: Performance Max(PMAX) 캠페인 (ad_group_ad 없음)
  - 두 GAQL 쿼리를 `Promise.all`로 병렬 실행, 결과 병합
  - PMAX asset_group의 `ad_id`에 `ag_` prefix 부여하여 충돌 방지
  - PMAX의 CTR/CPC/CPM은 API 미제공 → 직접 계산
- [x] **`src/analytics/collector.js` — `_collectGoogleAdLevel()` 메서드 추가**
  - `_collectGoogle()` 끝에서 자동 호출 (Meta와 동일 구조)
  - `ad_performance` 테이블에 `platform='google'`로 upsert

### 소재 레벨 수집 점검 결과

| 항목 | Meta | Google |
|------|------|--------|
| 클라이언트 메서드 | `getAdInsights()` | `getAdInsights()` (신규) |
| Collector 호출 | `_collectMetaAdLevel()` | `_collectGoogleAdLevel()` (신규) |
| 수집 건수 | 99건 (59개 소재) | 7,602건 (standard 7,478 + PMAX 124) |
| 지출 합계 | ₩564,806 | ₩165,303 |

**Google 특이사항**:
- 이 계정의 174개 캠페인 중 **PMAX가 69개로 가장 많음** (channel type 14)
- 실제 지출은 거의 전부 PMAX 2개 asset group에서 발생 (₩165,275 + ₩27)
- 나머지 7,478개 standard ad(DISPLAY/SEARCH 등)는 오늘 기준 노출/지출 0 — 현재 운영 중이지 않거나 예산 미배정 상태

### 테스트 결과
- 94개 테스트 전체 통과

---

## 2026-03-22 작업 내역

### Creatives 갤러리 디벨롭 (Date Picker + 캠페인/광고그룹 필터)

- [x] **기간 선택 — Date Picker 교체** (`src/dashboard/index.html`)
  - 기존 일수 버튼(1일/7일/14일/30일/전체) 제거
  - Overview 패널과 동일한 시작일~종료일 Date Picker 추가
  - 퀵셀렉트 버튼(7일/14일/30일) 병행 — 클릭 시 자동 날짜 계산
  - `adPerfDays` state → `adPerfDateRange { since, until }` state로 변경
  - API 호출: `days=N` → `since=YYYY-MM-DD&until=YYYY-MM-DD` 파라미터로 전환

- [x] **캠페인/광고그룹 Cascading 필터 추가** (`src/server.js`, `src/dashboard/index.html`)
  - **신규 API**: `GET /api/ad-performance/filters?platform=&campaign_id=`
    - 응답: `{ campaigns: [{campaign_id, campaign_name}], adsets: [{adset_id, adset_name, campaign_id}] }`
    - `campaign_id` 전달 시 해당 캠페인의 adset만 반환 (cascading)
  - **기존 API 확장**: `/api/ad-performance`, `/api/ad-performance/summary`에 `campaign_id`, `adset_id` 쿼리 파라미터 추가
  - **UI**: 필터바에 캠페인/광고그룹 `<select>` 드롭다운 2개 추가
    - 캠페인 변경 → 광고그룹 초기화 + 필터 옵션 리페치
    - 플랫폼 변경 → 캠페인 + 광고그룹 모두 초기화

- [x] **semantic diversity 엔드포인트 추가** (`src/server.js`)
  - `GET /api/creatives/diversity?campaignId=` — P.D.A 의미론적 다양성 체크

### Remote 코드 Merge 및 Creative Upload 복원

- [x] **remote `origin/main`과 merge** — 15개 충돌 파일 해결
  - 로컬 우선 (Google API 연동, safeError, 환경검증 등 최신 코드 유지)
  - remote에만 있던 코드 수동 복원:
    - Creative Upload 탭 전체 (PDA 태그 포함)
    - `upload` 아이콘, upload state 변수, `PDA_OPTIONS` 객체
    - `handleCreativeUpload` 함수
    - `awareness_stage` 뱃지 (creative 카드)
    - `creatives/diversity` 엔드포인트

- [x] **사이드바 Content 메뉴 네비게이션 수정**
  - 문제: Templates/A/B Tests/Audiences/Creative Upload 클릭 시 `contentTab`만 변경되고 `activeView`가 변경되지 않아 화면 전환 안 됨
  - 수정: 모든 Content 메뉴에 `setActiveView('dashboard')` 추가
  - Creative Upload 탭: `scrollIntoView` 자동 스크롤 추가 (DashboardPanel 하단에 위치하므로)

### 테스트 결과
- 94개 테스트 전체 통과 (모든 변경 후 확인)

### Meta 소재 이미지 URL 수집 및 Creatives 갤러리 이미지 표시

- [x] **DB 스키마 확장** (`src/utils/db.js`)
  - `ad_performance` 테이블에 `image_url TEXT` 컬럼 추가
  - `migrateAddImageUrl()` 마이그레이션 함수 추가 — `PRAGMA table_info`로 컬럼 존재 여부 확인 후 조건부 `ALTER TABLE`
- [x] **Meta Client 이미지 URL 조회 메서드** (`src/meta/client.js`)
  - `getAdCreativeImages(adIds)` 신규 메서드 추가
  - Ad → Creative → `image_hash` 추출 (우선순위: `asset_feed_spec.images[0].hash` → `image_hash` → `object_story_spec` 하위 필드)
  - AdImage API로 hash → `permalink_url` 일괄 변환 (50개씩 배치)
  - `permalink_url`은 302 리다이렉트이므로, `fetch(HEAD, redirect:manual)`로 `Location` 헤더의 CDN 직접 URL(`scontent-*.fbcdn.net`) 추출하여 저장
  - Fallback: hash 없는 소재는 `thumbnail_url` 사용
- [x] **Collector 연동** (`src/analytics/collector.js`)
  - `_collectMetaAdLevel()` — `getAdInsights()` 후 `getAdCreativeImages()` 호출
  - UPSERT에 `image_url` 추가, `COALESCE(excluded.image_url, ad_performance.image_url)`로 기존 값 보존
- [x] **API 수정** (`src/server.js`)
  - `/api/ad-performance` SELECT에 `MAX(image_url) as image_url` 추가
  - `POST /api/collect` 수동 수집 트리거 엔드포인트 추가
- [x] **대시보드 UI** (`src/dashboard/index.html`)
  - `row.image_url` 존재 시 `<img>` 태그로 실제 이미지 표시 (`object-cover`, `aspect-square`)
  - 이미지 없는 소재: 기존 그라디언트 placeholder + "이미지 미수집" hover 유지
  - `<img> onerror` 처리: 로드 실패 시 그라디언트 fallback
  - CSP `img-src`에 `https://*.fbcdn.net https://*.facebook.com` 추가
  - 썸네일 레이아웃 `h-40` → `aspect-square` (1:1 정방형) 변경

**수집 결과**: Meta 소재 25개 중 25개 이미지 URL 수집 성공 (CDN-direct)

---

## 기술 노트

### 챗봇 의도 분류기 (TF-IDF) 한계 및 확장 방안

현재 TF-IDF는 **챗봇 의도 분류**(사용자 입력 → 12개 고정 의도로 라우팅)에만 사용되며, 수집 데이터 분석과는 무관하다.

**TF-IDF로 충분한 경우**: "성과 보여줘", "예산 변경해줘" 등 정해진 기능을 실행하는 단순 명령

**TF-IDF로 불가능한 경우**:
- "이번 달 Meta ROAS가 낮은 캠페인의 공통점이 뭐야?" — 분석적 질문
- "경쟁사 대비 CPC가 어떤 수준이야?" — 외부 인사이트 요구
- "예산을 이렇게 조정하면 결과가 어떨까?" — 예측/추론

**확장 방안**: LLM(Claude API 등) 연동 시, 수집된 성과 데이터를 컨텍스트로 넘기고 자연어로 분석 결과를 받을 수 있음. 단계적 전환 권장:
1. TF-IDF로 의도를 먼저 분류
2. 단순 조회는 기존 로직 실행
3. 복잡한 분석 질문만 LLM으로 전달 (비용 효율적 하이브리드 구조)

### 매체별 API → 통일 스키마 매핑 현황

`db.js`의 스키마는 전 매체 통일이며, 각 클라이언트가 API 응답을 변환하는 위치는 다음과 같다:

| 매체 | 변환 위치 | 핵심 매핑 |
|------|----------|----------|
| Meta | `meta/client.js:186-206` | `data.spend` → `spend`, `actions[purchase]` → `conversions` |
| Google | `google/client.js:259-272` | `metrics.cost_micros / 1,000,000` → `spend`, `metrics.conversions` → `conversions` |
| TikTok | `tiktok/client.js:244-258` | `m.spend` → `spend`, `m.conversion` → `conversions` |

**알려진 불일치**:
- TikTok `conversionValue`가 항상 0으로 하드코딩됨 (`tiktok/client.js:254`). TikTok API가 전환값을 별도 필드로 제공하기 때문이며, 매핑이 아직 안 된 상태
- Google `conversion_value`가 0인 캠페인이 많음 — API 매핑 문제가 아닌, 전환 추적 미설정 또는 해당 기간 전환 없음일 가능성. Google Ads 대시보드에서 같은 기간 전환값과 비교하여 확인 필요

**점검 방법** (DB에서 직접 확인):
```sql
SELECT platform,
  COUNT(*) as rows,
  SUM(CASE WHEN spend IS NULL OR spend = 0 THEN 1 ELSE 0 END) as missing_spend,
  SUM(CASE WHEN impressions IS NULL THEN 1 ELSE 0 END) as missing_impressions,
  SUM(CASE WHEN conversion_value IS NULL THEN 1 ELSE 0 END) as missing_value
FROM performance
GROUP BY platform;
```

---

## 다음 작업 예정

- [x] 과거 데이터 백필 — Google 3월분 완료 (3,480건), 스크립트 Meta+Google 통합
- [ ] DB Browser로 수집 데이터 팀 분석
- [ ] TikTok API 자격증명 설정 및 연동
- [x] `db.js` CHECK 제약조건에 `'tiktok'` 추가 — `ad_performance` 테이블에 `('meta', 'google', 'tiktok')` 적용 완료
- [ ] TikTok `conversionValue` 매핑 수정 (별도 필드에서 가져오도록)
- [ ] Google 전환값 0인 캠페인 — Google Ads 대시보드와 비교 점검
- [ ] Google 수집 데이터 vs 실제 매체 대시보드 수치 얼라인 검증
- [x] `ad_performance` 테이블 스키마 점검 완료 — UNIQUE/CHECK/인덱스/ON CONFLICT 수정 + 마이그레이션 로직
- [x] 크리에이티브 관리 대시보드 UI 구현 — 소재 성과 갤러리 (Creatives 뷰)
- [ ] 소재(Ad) 레벨 **과거 데이터 백필** 점검 — 현재 3/18~3/19만 수집됨. `collect-historical.js`에 ad-level 백필 지원 추가 또는 별도 스크립트 필요
- [x] 소재 성과 갤러리 **달력(Date Picker) 기간 선택** 구현 — 퀵셀렉트(7/14/30일) + 시작일~종료일 달력 + 캠페인/광고그룹 cascading 필터 추가 완료
- [x] 소재 이미지 URL 수집 구현 완료 — `ad_performance.image_url` 컬럼 추가, Meta AdCreative API → AdImage API → CDN URL 변환 파이프라인, 대시보드 이미지 표시 + CSP 수정
- [ ] ads/ad_groups FK 연결 보류 — 비정규화 설계 유지 (성과 조회는 `ad_performance` 단독으로 충분)
- [x] 소재(Ad) 레벨 데이터 수집 — Meta `getAdInsights` + Google `getAdInsights` (ad_group_ad + PMAX asset_group 병행) 구현 완료
- [ ] Google standard ad(DISPLAY/SEARCH) 소재 데이터 0건 원인 — 운영 중단/예산 미배정인지, API 이슈인지 Google Ads 대시보드에서 확인 필요
- [ ] 분석적 질문 대응을 위한 LLM 연동 검토
