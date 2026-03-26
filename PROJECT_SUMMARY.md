# Ad Automation Framework — 프로젝트 정리

**최초 작성일**: 2026-03-18
**최종 수정일**: 2026-03-24

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

- [x] **이미지 URL 백필 스크립트** (`scripts/backfill-image-urls.js`)
  - DB에서 `image_url IS NULL`인 Meta ad_id를 조회하여 `getAdCreativeImages()` 호출 후 UPDATE만 수행
  - `--all` 옵션으로 기존 URL 재수집 가능
  - 이미지 조회 불가 소재 목록 출력 (ad_name, spend 포함)

**수집 결과**: Meta 소재 72개 중 67개 이미지 URL 수집 성공 (93%), 5개 조회 불가 (아카이브/삭제 또는 다이나믹 소재)

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

## 2026-03-24 작업 내역

### 과거 데이터 백필
- [x] `scripts/collect-historical.js` 실행 — Meta + Google 2026-03-01 ~ 2026-03-23 데이터 수집
  - Meta: 297건 저장
  - Google: 0건 (네트워크 미연결 환경)

### Meta 광고 소재 셋팅 탭 신규 구현

#### 신규 탭 추가
- [x] 사이드바에 **"Meta 소재 셋팅"** 메뉴 추가 → `activeView = 'meta-creative'`
- [x] `MetaCreativeSettingsPanel` 컴포넌트 — 서브탭: 소재 등록 / 템플릿
  - 소재 목록 탭은 이후 요청으로 제거됨

#### Meta API 직접 소재 등록 폼 (`MetaDirectUploadForm`)
- [x] **기본 정보 섹션**
  - 소재명(광고 이름) 입력
  - 캠페인 드롭다운 (Meta 캠페인만 필터)
  - Ad Set 드롭다운 — 캠페인 선택 시 Meta API로 동적 로드
  - Instagram / Threads 계정 드롭다운 — 비즈니스 계정 owned_accounts API
  - 전환 이벤트 드롭다운 — 10개 표준 이벤트 (구매/결제시작/장바구니 등)
  - Facebook 페이지 드롭다운 — business owned_pages API
- [x] **이미지 섹션** — 파일 업로드 / 이미지 URL / 로컬 경로 3가지 모드
  - 드래그앤드롭 업로드 존 구현 (multer memoryStorage → base64 → Meta AdImage API)
  - 업로드 성공 시 썸네일 + hash 표시
- [x] **광고 문구 섹션** — 주요 텍스트(Primary Text) 입력 (Headline/Description 제거)
- [x] **링크 & CTA 섹션** — 랜딩 URL, CTA 버튼(10종), 광고 상태(PAUSED/ACTIVE)

#### Meta API 신규 엔드포인트 (`src/server.js`)
| 엔드포인트 | 설명 |
|---|---|
| `GET /api/meta/pages` | Facebook 페이지 목록 (me/accounts → business owned_pages 폴백) |
| `GET /api/meta/instagram-accounts` | Instagram 계정 목록 (business owned_accounts) |
| `GET /api/meta/pixels` | Meta 픽셀 목록 (adspixels) |
| `GET /api/meta/campaigns/:id/adsets` | 캠페인별 Ad Set 목록 (platform_id DB 조회 후 Meta API 호출) |
| `POST /api/meta/upload-image` | 이미지 업로드 → Meta AdImage hash 반환 |
| `POST /api/meta/creative/direct` | AdCreative + Ad 생성 → DB 저장 |

#### Meta Client 신규 메서드 (`src/meta/client.js`)
- `getPages()` — me/accounts 시도 후 실패 시 business owned_pages 폴백
- `getInstagramAccounts()` — business owned instagram_accounts
- `getPixels()` — adspixels API
- `getAdSets(campaignId)` — Campaign SDK object로 adsets 조회
- `createCreative()` — imageHash / imageUrl(picture) / instagramAccountId / headline / description 지원
- `createAd()` — tracking_specs(pixelId + custom_event_type) 지원

#### DB 스키마 추가 (`src/utils/db.js`)
- `creatives` 테이블 추가 (platform, campaign_id, ad_set_id, name, type, status, headline, body_text, cta, media_url, landing_url, ab_group, metadata_json)
- `meta_pages` 테이블 추가

### 버그 수정

- [x] **React 컴포넌트 리렌더링 시 폼 초기화 버그**
  - 원인: `MetaDirectUploadForm`, `MetaCreativeSettingsPanel`이 `App()` 함수 안에 `const`로 정의되어 App 리렌더마다 새 함수 참조 생성 → React가 매번 언마운트/리마운트
  - 수정: 두 컴포넌트를 `App()` 밖으로 이동, `campaigns`를 prop으로 명시적 전달

- [x] **Rate Limiter 이미지 업로드 차단**
  - 원인: `app.post('/api/*', mutationLimiter)` catch-all이 upload-image 엔드포인트에도 적용됨 (분당 20→60으로 증가해도 동일)
  - 수정: `req.originalUrl.includes('/meta/upload-image')` 조건으로 upload-image를 rate limit에서 제외

- [x] **Ad Set 드롭다운 빈 값**
  - 원인: DB 내부 ID(`meta_120241553714580409`)를 Meta API에 전달 — Meta는 플랫폼 ID(`120241553714580409`) 필요
  - 수정: 서버에서 `campaigns` 테이블의 `platform_id` 조회 후 Meta API 호출

- [x] **`safeError` Meta 에러 상세 미출력**
  - `FacebookRequestError.response`가 직접 파싱된 에러 body임을 확인 (`err.response.error` 아님)
  - `err.response.message`, `err.response.code`, `err.response.type`, `err.response.fbtrace_id` 추출하여 클라이언트에 전달

### 알려진 이슈

- **광고 등록 불가 — Meta 앱 개발 모드**
  - 오류: `[code 100] 광고 크리에이티브 게시물이 개발 모드인 앱에서 만들어졌습니다 (OAuthException)`
  - 해결: [developers.facebook.com/apps](https://developers.facebook.com/apps) → 해당 앱 → "개발 중" 토글을 **"라이브"** 로 전환 필요

---

## 2026-03-26 작업 내역

### Google Ads 기능 테스트 계획 (ad1278 담당)

> 상무님 확인용: Meta 테스트는 youngwooknyw가 완료, Google은 ad1278가 아래 순서로 검증
> 우선순위: 빠르게 체크 가능한 것부터

---

#### 1단계: KPI View 정합성 체크

**이미 데이터 로딩 확인됨 → 수치 정확도만 검증하면 완료**

- [x] **대시보드 vs Google Ads 대시보드 수치 비교**
  - 방법: `http://localhost:3100` → Overview → Platform "Google" 필터
  - Google Ads 관리자(ads.google.com)에서 동일 기간 Spend/Impressions/Clicks/Conversions 비교
  - 기대 결과: Spend/Impressions/Clicks 오차 < 1% (micros → 원 변환 반올림 허용)
  - 관련: `src/server.js` (GET /api/overview), `src/google/client.js`

- [x] **PMAX 캠페인 수치 정합성 별도 점검**
  - 방법: PMAX 캠페인 2개(지출 발생 중)를 Google Ads 대시보드에서 확인 후 DB와 비교
  - DB 쿼리: `SELECT * FROM performance WHERE platform='google' AND campaign_name LIKE '%PMAX%' ORDER BY date_start DESC LIMIT 5;`
  - 관련: `src/google/client.js` (getAdInsights — PMAX asset_group 쿼리)

- [x] **conversion_value 0 문제 원인 확인**
  - 방법: Google Ads 대시보드 → 해당 캠페인 → 전환 → 전환 가치 컬럼 확인
  - 기대 결과: (A) API 매핑 문제 → 코드 수정 필요, 또는 (B) 실제로 전환값 미설정 → 정상 동작 확인
  - DB 쿼리: `SELECT campaign_name, SUM(spend), SUM(conversions), SUM(conversion_value) FROM performance WHERE platform='google' AND spend > 0 GROUP BY campaign_name;`

---

#### 2단계: Google 소재 세팅 (광고 생성)

**실제 Google Ads API로 소재 생성 가능 여부 확인 — Meta 직접 등록(`MetaDirectUploadForm`)과 대응되는 Google 버전**

##### 현재 구현 상태

| 기능 | 구현 여부 | 위치 |
|---|---|---|
| 캠페인 생성 (Search) | ✅ 코드 있음, 미테스트 | `src/google/client.js:82-109` (`createCampaign`) |
| 광고 그룹 생성 | ✅ 코드 있음, 미테스트 | `src/google/client.js:148-161` (`createAdGroup`) |
| 반응형 검색 광고(RSA) 생성 | ✅ 코드 있음, 미테스트 | `src/google/client.js:164-180` (`createResponsiveSearchAd`) |
| 키워드 추가 | ✅ 코드 있음, 미테스트 | `src/google/client.js:183-194` (`addKeywords`) |
| Creative Pipeline → Google 등록 | ✅ 코드 있음, 미테스트 | `src/content/creative-pipeline.js:211-219` (`registerToGoogle`) |
| PMAX 캠페인+Asset Group 일괄 생성 | ✅ 구현+테스트 완료 | `src/google/client.js` (`createPmaxCampaign`) — mutateResources 사용 |
| PMAX 캠페인 삭제 (REMOVED) | ✅ 테스트 완료 | `campaigns.update` status=REMOVED |
| 대시보드 UI (Google 소재 셋팅 탭) | ❌ 미구현 | Meta는 `MetaDirectUploadForm` 있음, Google 버전 없음 |

##### PMAX vs Standard 광고 구조 차이

| 구분 | Standard (Search/Display) | PMAX |
|---|---|---|
| 광고 단위 | Campaign → Ad Group → Ad | Campaign → Asset Group → Asset |
| 소재 구성 | headline + description + URL | 텍스트/이미지/동영상 에셋을 묶어서 Asset Group에 할당 |
| 타겟팅 | 키워드/오디언스 직접 설정 | Google 머신러닝이 자동 최적화 (Signal만 제공) |
| 게재 지면 | Search/Display/YouTube 개별 | 모든 Google 지면 자동 (Search+Display+YouTube+Gmail+Maps) |
| API 소재 생성 | `ads.create` (RSA 등) | `assetGroups.create` + `assetGroupAssets.create` |
| 현재 코드 | `createResponsiveSearchAd()` 구현됨 | ✅ `createPmaxCampaign()` 구현 완료 — `mutateResources` 일괄 생성 |

##### 테스트 항목

- [ ] **Standard 광고: RSA 생성 테스트 (creative-pipeline 경유)**
  - 방법: `POST /api/creatives/:id/register` (platform=google) 또는 직접 `createResponsiveSearchAd()` 호출
  - 전제: `creatives` 테이블에 Google용 소재 레코드 필요 (headline, description을 `|` 구분자로 입력)
  - 기대 결과: Google Ads 대시보드에서 해당 Ad Group에 RSA 생성 확인
  - 관련: `src/content/creative-pipeline.js:211-219`, `src/google/client.js:164-180`

- [ ] **Standard 광고: 캠페인 + 광고그룹 + 키워드 + RSA 전체 플로우**
  - `createCampaign()` → `createAdGroup()` → `addKeywords()` → `createResponsiveSearchAd()`
  - 기대 결과: Google Ads 대시보드에서 전체 계층 구조 확인 (PAUSED 상태로 생성)

- [x] **PMAX 캠페인+소재 일괄 생성 테스트**
  - `createPmaxCampaign()` — `mutateResources`로 아래 리소스를 원자적(atomic) 일괄 생성:
    - Campaign Budget (₩1) + Campaign (PAUSED) + Business Name Asset + Logo Image Asset
    - Asset Group (PAUSED) + Marketing Image + Square Image + Long Headline + Headlines(5) + Descriptions(4)
  - 테스트 캠페인: `TEST_PMAX_API_테스트_삭제예정` (ID: 23697395401)
  - 결과: ✅ Google Ads 대시보드에서 캠페인 + Asset Group + 모든 에셋 정상 확인
  - 관련: `src/google/client.js` (`createPmaxCampaign`), `scripts/test-pmax-creation.js`

- [x] **PMAX 캠페인 삭제(REMOVED) 테스트**
  - `campaigns.update` → status를 `REMOVED`로 변경
  - 결과: ✅ 즉시 삭제 완료, Google Ads 대시보드에서 비노출 확인

##### PMAX 생성 시 필수 에셋 (테스트로 확인된 최소 요구사항)

| 에셋 | 최소 개수 | 비고 |
|---|---|---|
| Headline (30자) | 5개 | 3개로는 에러 발생 |
| Long Headline (90자) | 1개 | 필수 |
| Description (90자) | 4개 | 2개로는 에러 발생 |
| Marketing Image (1200x628) | 1개 | 가로형 |
| Square Marketing Image (1200x1200) | 1개 | 정사각형 |
| Logo (128x128+) | 1개 | 정사각형, CampaignAsset으로 연결 |
| Business Name | 1개 | CampaignAsset으로 연결 (Brand Guidelines 필수) |
| Final URL | 1개 | Asset Group에 설정 |
| EU Political Advertising 선언 | 필수 | `DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING` |

##### 구현 중 발견된 기술 이슈

- `google-ads-api` 라이브러리의 `create()` 메서드는 **배열**을 인자로 받음 (단일 객체 X)
- PMAX는 개별 `create()` 호출이 아닌 **`mutateResources()`로 일괄 생성** 필요 — 캠페인/에셋/연결이 원자적으로 처리
- `mutateResources` 형식: `{ entity: 'campaign', operation: 'create', resource: {...} }`
- 임시 리소스명(`customers/{id}/campaigns/-2`)으로 아직 생성 안 된 리소스를 참조 가능
- 입찰 전략은 `bidding_strategy_type` enum이 아닌 실제 전략 객체(`maximize_conversions: {}`) 사용 필요

---

#### 3단계: Campaign Alerts — Slack/Telegram 알림 확인

**KPI 임계값 초과/미달 시 Slack/Telegram으로 자동 알림 전송되는 기능 검증**

##### 알림 아키텍처 (Bot Token 방식으로 전환 완료)

```
collector.js (_analyzeAndAlert)
  → DB alerts 테이블 INSERT
  → notifier.broadcast()
    → Slack Bot Token: chat.postMessage (기본 — 삭제 가능)
    → Slack Webhook (fallback — Bot Token 미설정 시)
    → Telegram Bot API (선택)
```

##### Slack Bot 멘션 답변 (Socket Mode)

```
Slack @멘션 → slack-bot.js (Socket Mode)
  → AdManagerSkill.handleMessage()
    → DB 쿼리 → 응답 생성 → 스레드 답변
```

- `@봇이름 성과 보여줘` → 최근 성과 리포트 답변
- `@봇이름 캠페인 목록` → 활성 캠페인 리스트 답변
- 멘션 없이는 응답하지 않음

##### 환경변수

| 변수 | 용도 |
|---|---|
| `SLACK_BOT_TOKEN` | xoxb-... Bot Token (알림 전송 + 멘션 답변) |
| `SLACK_APP_TOKEN` | xapp-... App Token (Socket Mode 연결) |
| `SLACK_ALERT_CHANNEL` | 알림 전송 채널 ID |
| `SLACK_ALERTS_PAUSED` | `true`로 설정 시 알림 일시정지 |
| `ALERT_ROAS_THRESHOLD` | ROAS 임계값 (기본 1.5) |
| `ALERT_CPA_THRESHOLD` | CPA 임계값 (기본 50000) |
| `ALERT_BUDGET_BURN_RATE` | 예산 소진율 임계값 (기본 0.85) |

##### 테스트 결과

- [x] **Slack Bot Token 방식 전환**
  - Webhook → Bot Token(`chat.postMessage`)으로 전환 완료
  - Bot Token으로 보낸 메시지는 삭제 가능 (Webhook 메시지는 삭제 불가)
  - 관련: `src/utils/notifier.js` (Webhook fallback 유지)

- [x] **Slack 알림 전송 + 삭제 테스트**
  - ROAS < 1.5 캠페인 알림 전송 → Slack 채널 수신 확인
  - Bot Token으로 보낸 메시지 일괄 삭제 성공
  - 현재 상태: `SLACK_ALERTS_PAUSED=true` (일시정지 중)

- [x] **Slack Bot 멘션 답변 구현**
  - `@slack/bolt` Socket Mode로 구현 → `src/slack-bot.js`
  - 서버 시작 시 자동 연결 (`src/server.js`에서 `startSlackBot()` 호출)
  - `@봇이름 성과 보여줘` 등 멘션 시 AdManagerSkill 라우팅 → 스레드 답변

- [x] **대시보드 Chat UI 개선**
  - 빠른 명령어 버튼 6개 추가 (성과 보여줘/캠페인 목록/예산 늘려줘/최적화 추천/캠페인 일시정지/알림 확인)
  - placeholder 한국어 변경
  - chat 응답 서식 개선 (pre-wrap)
  - `generateReport()` 개선: spend > 0 캠페인만 표시, 소수점 정리, 플랫폼간 ROAS 비교 인사이트 추가

---

#### 4단계: Contents/Creatives View — Google 소재

**Google 소재 데이터 표시 여부 확인 + PMAX 구조 특수성 분석**

##### PMAX Creatives View 설계 이슈

PMAX는 Meta/NaverGFA와 근본적으로 구조가 다름:

| 구분 | Meta / NaverGFA | Google PMAX |
|---|---|---|
| 소재 단위 | 1 Ad = 1 Creative (이미지+텍스트+CTA) | 1 Asset Group = N Assets (이미지/동영상/텍스트 조합) |
| 성과 귀속 | Ad별 성과 직접 조회 가능 | Asset Group 단위 성과만 제공 (개별 Asset 성과 제한적) |
| 이미지 조회 | AdCreative → AdImage → CDN URL | `asset_group_asset` → `asset.image_asset.full_size.url` |
| 갤러리 표시 | 1 카드 = 1 광고 소재 | **1 카드 = 1 Asset Group?** 또는 **1 카드 = 1 Asset?** 결정 필요 |

현재 코드에서는 PMAX asset_group을 `ag_` prefix 붙여서 ad_performance 테이블에 저장 중 (`src/google/client.js:359`).
→ Creatives 갤러리에서 `ag_`로 시작하는 항목이 PMAX 소재.

##### 테스트 항목

- [ ] **Creatives 갤러리에서 Google 소재 표시 확인**
  - 방법: 대시보드 → Creatives → Platform "Google" 필터
  - 기대 결과: Google 소재 카드 표시 (이미지는 placeholder)
  - 확인 포인트:
    - PMAX asset_group(`ag_` prefix)과 standard ad 모두 표시되는지
    - PMAX 소재 카드에 asset_group 이름이 표시되는지
    - standard ad 7,478건 중 지출 0인 항목들이 필터링/정렬되는지

- [ ] **Google 소재 성과 수치 정합성**
  - Creatives 갤러리 → Google → PMAX 소재의 Spend/Impressions/ROAS를 Google Ads와 비교
  - DB 쿼리: `SELECT ad_id, ad_name, SUM(spend), SUM(impressions), SUM(clicks) FROM ad_performance WHERE platform='google' AND spend > 0 GROUP BY ad_id ORDER BY SUM(spend) DESC LIMIT 10;`

- [ ] **PMAX 소재 구조 분석 및 Creatives View 개선 방향 결정**
  - 조사: Google Ads API에서 asset_group 내 개별 asset 목록 + 이미지 URL 가져오기 가능한지
  - API: `asset_group_asset` 리소스 → `asset.image_asset.full_size.url` (이미지), `asset.text_asset.text` (텍스트)
  - 결정 필요:
    - (A) Asset Group 단위로 카드 표시 (현재 방식) — 대표 이미지 1장 + 성과 요약
    - (B) 개별 Asset별 카드 표시 — 이미지/텍스트 각각 성과 확인 (API 지원 제한적)
  - 참고: `asset_group_asset_performance_view` 리소스로 개별 에셋 성과 조회 가능하나 제한적

- [ ] **Google 소재 이미지 URL 수집 파이프라인 설계**
  - 현황: Meta는 AdCreative → AdImage → CDN URL 파이프라인 완료, Google은 미구현
  - 구현 방안:
    - PMAX: `asset_group_asset` 쿼리 → `asset.image_asset.full_size.url`
    - Display: `ad_group_ad.ad.image_ad.image_url`
    - Search(RSA): 이미지 없음 (텍스트 광고) — placeholder 유지
  - 향후 작업으로 등록

---

#### 보류: 캠페인 On/Off 토글

> 실제 운영 중인 캠페인을 끄고 켜는 리스크가 있어 우선 배제. 코드 자체는 구현 완료 상태.
> - 관련 코드: `src/google/client.js:136-143` (`setCampaignStatus`), `src/utils/platform-adapter.js`
> - 나중에 테스트용 캠페인을 별도 생성한 후 테스트 진행 가능

---

#### 테스트 결과 요약

| 테스트 항목 | 상태 | 비고 |
|---|---|---|
| **1단계: KPI View** | | |
| 대시보드 vs Google Ads 수치 비교 | ✅ | 비용/클릭 완벽 일치, 전환 0.7% 차이 (귀속 지연) |
| PMAX 수치 정합성 | ✅ | new/rt 캠페인 모두 검증 완료 |
| conversion_value 0 원인 | ✅ | cron 중단 + 전환 귀속 지연이 원인, API 매핑 정상 |
| **2단계: 소재 세팅** | | |
| PMAX 캠페인+소재 일괄 생성 | ✅ | mutateResources 원자적 생성 성공 |
| PMAX 캠페인 삭제 (REMOVED) | ✅ | 즉시 삭제 확인 |
| Search: 캠페인+광고그룹+키워드+RSA | ✅ | 4단계 모두 성공 (캠페인 ID: 23689723392) |
| Demand Gen 캠페인+소재 일괄 생성 | ✅ | 2단계 방식 (Budget+Campaign → Assets → Ad) 성공 |
| Demand Gen UI 세팅 폼 | ✅ | 캠페인 목표/제품 피드/광고 유형(이미지/동영상)/소재 등록 |
| Video 캠페인 생성 | ❌ 차단 | Developer Token 권한 부족 (MUTATE_NOT_ALLOWED) |
| Display: 캠페인+광고그룹+에셋+반응형 디스플레이 | ✅ | 4단계 모두 성공 (캠페인 ID: 23689757277) |
| Google 광고 세팅 UI — 전용 폼 4개 | ✅ | Search(파랑)/Display(초록)/DemandGen(남색)/PMAX(보라) 전용 폼 완성 |
| Google 광고 세팅 UI — Video/Shopping | ⬜ 보류 | Video: Developer Token 권한, Shopping: GMC ID 필요 |
| **3단계: Alerts + Slack Bot** | | |
| Slack Bot Token 전환 | ✅ | Webhook → Bot Token, 삭제 가능 |
| Slack 알림 전송 + 삭제 | ✅ | 전송/삭제 모두 확인, 현재 일시정지 중 |
| Slack Bot 멘션 답변 | ✅ | Socket Mode, @멘션 → 스레드 답변 |
| 대시보드 Chat UI 개선 | ✅ | 빠른 명령어 버튼 + 성과 리포트 개선 |
| **4단계: Creatives View** | | |
| Creatives 갤러리 Google 표시 | ⬜ | |
| Creatives 성과 수치 정합성 | ⬜ | |
| PMAX 구조 분석 + View 개선 방향 | ⬜ | |
| Google 이미지 URL 파이프라인 설계 | ⬜ | |

### 2026-03-27 Google 광고 세팅 개발 로그

#### 캠페인 타입별 API 생성 방식 (검증 완료)

| 캠페인 타입 | 생성 방식 | Ad Group Type | Ad 생성 | 상태 |
|---|---|---|---|---|
| **PMAX** | `mutateResources` 원자적 일괄 | Asset Group (자동) | asset_group_asset 링크 | ✅ |
| **Demand Gen** | Phase1: `mutateResources`(Budget+Campaign) → Phase2: `adGroups.create` → `assets.create` → `adGroupAds.create` | 타입 지정 불가 (Google 자동) | `demand_gen_multi_asset_ad` 또는 `demand_gen_video_responsive_ad` | ✅ |
| **Search** | `createCampaign` → `createAdGroup(SEARCH_STANDARD)` → `addKeywords` → `adGroupAds.create(RSA)` | SEARCH_STANDARD | responsive_search_ad | ✅ |
| **Display** | `createCampaign` → `createAdGroup(DISPLAY_STANDARD)` → `createImageAsset` → `adGroupAds.create(RDA)` | DISPLAY_STANDARD | responsive_display_ad (square_logo_images 사용) | ✅ |
| **Video** | ❌ 모든 방식 실패 (`mutateResources`, `campaigns.create`) | - | - | ❌ Developer Token 권한 필요 |
| **Shopping** | `createCampaign(merchantId)` → `createAdGroup` → `createShoppingProductAd` | SHOPPING_PRODUCT_ADS | shopping_product_ad (빈 구조, MC 자동) | ⬜ GMC ID 필요 |

#### Google 광고 세팅 전용 UI 폼 구성

| 캠페인 타입 | 테마 색상 | 섹션 구성 |
|---|---|---|
| **Search** | 파란색 | 캠페인 설정 → 키워드 → 광고 문구(RSA: 제목 3+/30자, 설명 2+/90자) → 링크 |
| **Display** | 초록색 | 캠페인 설정(+비즈니스명) → 이미지(가로+정사각형+로고) → 광고 문구(제목 5/30자, 긴제목/90자, 설명 5/90자) → 링크 |
| **Demand Gen** | 남색 | 캠페인 설정(목표/피드/CPA/날짜) → 광고 유형(이미지/동영상) → 미디어(이미지20개/동영상5개+로고5개) → 텍스트(제목40자/설명90자/CTA/업체명25자) → 링크 |
| **PMAX** | 보라색 | 캠페인 설정(+비즈니스명) → 이미지(로고+마케팅+정사각형) → 광고 문구(제목 5+/30자, 긴제목/90자, 설명 4+/90자) → 링크 |
| **Video** | - | 보류 (Developer Token 권한) |
| **Shopping** | - | 보류 (GMC ID 필요) |

#### google-ads-api 라이브러리 공통 규칙 (모든 캠페인 타입)

1. **모든 `.create()` 메서드는 배열 필수** — `campaigns.create([...])`, `adGroups.create([...])`, `adGroupAds.create([...])`, `assets.create([...])`
2. **`ads.create()` 없음** — `adGroupAds.create()` 사용해야 함
3. **`contains_eu_political_advertising` 필수** — 모든 캠페인 생성 시 EU 정치 광고 선언 필요

#### Display 개발 시 발견된 API 규칙

1. **`square_marketing_images` 필수** — 최소 1개 (정사각형 이미지)
2. **로고는 `square_logo_images` 필드 사용** — 128x128 1:1 비율. `logo_images`는 가로형(4:1) 로고용
3. **1200x1200 이미지는 `logo_images`에 사용 불가** — `media_upload_error: 11 (aspect ratio mismatch)` 발생

#### Search 개발 시 발견된 API 규칙

1. **`adGroups.create()` 배열 필수** — 단일 객체 전달 시 `entities.map is not a function` 에러
2. **`adGroupAds.create()` 배열 필수** — `ads.create()`는 존재하지 않음
3. **`campaigns.create()` 배열 필수** — google-ads-api 라이브러리 공통 규칙

#### Demand Gen 개발 시 발견된 API 규칙

1. **Ad Group에 `type` 지정 불가** — Demand Gen은 Google이 자동 할당. `DISPLAY_STANDARD` 지정 시 `context_error` 발생
2. **`ads.create()` 메서드 없음** — `adGroupAds.create([...])` 배열로 전달해야 함
3. **`adGroups.create()`도 배열** — 단일 객체 전달 시 `entities.map is not a function` 에러
4. **이미지 에셋은 별도 업로드** — `mutateResources`에 이미지+광고를 함께 넣으면 `duplicate assets` 에러
5. **텍스트는 Ad에 인라인** — PMAX와 달리 별도 text asset 생성 불필요, `{ text: '...' }` 직접 전달
6. **headline 40자** (Search 30자와 다름), **업체명 25자**

#### Video 캠페인 차단 상세

- **에러**: `mutate_error: 9 (MUTATE_NOT_ALLOWED)` — `mutateResources`, `campaigns.create` 모두 실패
- **시도한 방법**: `target_cpv`, `target_cpm`, `maximize_conversions`, `VIDEO_ACTION` sub-type — 전부 실패
- **원인 추정**: Developer Token이 Basic Access 수준으로, VIDEO 캠페인 API 생성 권한 없음
- **해결 방법**: Google Ads API 센터에서 Standard Access 승인 요청 필요 (2~7일 소요)
- **관련 스크립트**: `scripts/test-video-creation.js` (단계별 fallback 테스트)
- **향후 작업**: 승인 후 스크립트 재실행 → 성공하는 방식 확인 → `createVideoCampaign()` 구현 → UI 연동

#### 테스트 스크립트 목록

| 스크립트 | 용도 |
|---|---|
| `scripts/test-pmax-creation.js` | PMAX 캠페인+소재 일괄 생성 (✅ 검증 완료) |
| `scripts/test-standard-creation.js` | Search 캠페인+RSA 전체 플로우 (✅ 검증 완료) |
| `scripts/test-display-creation.js` | Display 캠페인+반응형 디스플레이 광고 (✅ 검증 완료) |
| `scripts/test-demandgen-creation.js` | Demand Gen 단계별 검증 (✅ 4단계 모두 성공) |
| `scripts/test-demandgen-ui-api.js` | Demand Gen API 엔드포인트 검증 (✅ 성공) |
| `scripts/test-video-creation.js` | Video 캠페인 생성 시도 (❌ 권한 차단) |
| `scripts/_delete-test-campaign.js` | 테스트 캠페인 삭제 유틸 |

---

### 발견 이슈

#### [해결] KPI 정합성 불일치 — cron 중단 + 전환 귀속 지연

- **현상**: DB 수치가 Google Ads 대시보드 대비 비용 12%, 전환 71% 부족
- **원인 1**: 15분 cron 수집이 3/25 00:15 이후 중단됨 → 3/25~3/26 데이터가 자정 직후 1회 수집분만 저장
- **원인 2**: Google Ads 전환은 클릭 후 최대 30일까지 소급 귀속 → 수집 당시에는 미귀속 전환이 많았음
- **해결**: `node scripts/collect-historical.js 2026-03-01 2026-03-26 google` 백필 실행
- **결과**: 3/20~3/25 기준 비용/클릭 **완벽 일치**, 전환 **0.7% 차이** (백필 시점과 대시보드 조회 시점 사이 전환 1건 추가 귀속)
- **향후 대응**: 과거 N일 데이터를 주기적으로 재수집하는 로직 추가 필요 (전환 귀속 지연 방지)

##### 정합성 검증 결과 (3/20~3/25)

| 캠페인 | 항목 | Google Ads | DB | 차이 |
|---|---|---|---|---|
| PMAX_AL_new | 비용 | ₩2,442,732 | ₩2,442,732 | 일치 |
| PMAX_AL_new | 클릭 | 11,778 | 11,778 | 일치 |
| PMAX_AL_new | 전환 | 47.29 | 47.29 | 일치 |
| PMAX_AL_new | 전환가치 | ₩6,096,890 | ₩6,096,890 | 일치 |
| PMAX_AL_rt | 비용 | ₩1,835,657 | ₩1,835,657 | 일치 |
| PMAX_AL_rt | 클릭 | 7,170 | 7,170 | 일치 |
| PMAX_AL_rt | 전환 | 115.02 | 114.02 | -1.0 (귀속 지연) |
| PMAX_AL_rt | 전환가치 | ₩14,458,785 | ₩14,316,785 | -₩142K (0.7%) |
| **총계** | **비용** | **₩4,278,389** | **₩4,278,389** | **일치** |

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
- [ ] Google Video 캠페인 API 생성 — Developer Token Standard Access 승인 후 진행 (`scripts/test-video-creation.js` 재실행)
- [ ] Google Shopping 캠페인 세팅 — GMC(Merchant Center) ID 확인 후 테스트
- [ ] Google Search/Display 캠페인 세팅 — 테스트 스크립트 실행 + Demand Gen 수준 UI 개선
