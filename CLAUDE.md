# Ad Automation Framework — CLAUDE.md

## 프로젝트 개요

Meta / Google 광고 자동화 대시보드. 광고 성과 모니터링, 소재 관리, ROAS 기반 자동 ON/OFF 규칙 실행.

---

## 실행 방법

```bash
npm run dev   # Express API + 정적 파일 서빙 → http://localhost:3099
```

- API 서버: 포트 **3099**
- DB: `data/ads.db` (SQLite)
- **서버는 사용자가 직접 재시작한다. 코드 수정 후 자동으로 서버를 kill하거나 재시작하지 말 것.**

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| Frontend | `src/dashboard/index.html` — React (in-browser Babel) + Tailwind CSS CDN, 단일 파일 |
| Backend | `src/server.js` — Express.js |
| DB | SQLite (`better-sqlite3`) → `data/ads.db` |
| Meta API | `facebook-nodejs-business-sdk` → `src/meta/client.js` |
| Google Ads API | `google-ads-api` npm → `src/google/client.js` |
| 알림 | `@slack/bolt` + Slack Bot Token / Webhook |
| AI | `@anthropic-ai/sdk` (Claude Vision, 채팅 어시스턴트) |

---

## 주요 파일 구조

```
src/
├── server.js                  # Express API 서버, 모든 라우트
├── dashboard/index.html       # 단일 파일 프론트엔드 (React)
├── meta/
│   ├── client.js              # Meta Marketing API 클라이언트
│   └── auto-creative.js       # Claude Vision 광고 카피 자동 생성
├── google/
│   └── client.js              # Google Ads API 클라이언트
├── analytics/
│   ├── collector.js           # 성과 데이터 수집 스케줄러
│   ├── optimizer.js           # 예산/전략 최적화 추천
│   └── rule-engine.js         # ROAS 자동 ON/OFF 규칙 엔진
├── utils/
│   ├── db.js                  # DB 초기화 및 마이그레이션
│   ├── notifier.js            # Slack/Telegram 알림 발송
│   ├── clients.js             # 클라이언트 싱글턴 관리
│   └── services.js            # 서비스 싱글턴 관리
└── slack-bot.js               # Slack Socket Mode 봇
```

---

## 주요 DB 테이블

| 테이블 | 설명 |
|--------|------|
| `campaigns` | 캠페인 마스터 (Meta/Google 통합) |
| `performance` | 캠페인 레벨 성과 스냅샷 |
| `ad_performance` | 광고(소재) 레벨 성과 (`ad_id, platform, date_start` UNIQUE) |
| `google_asset_grades` | Google RSA/RDA 에셋 등급 (BEST/GOOD/LOW) |
| `pmax_asset_labels` | PMAX 에셋별 일별 성과 (`asset_id, asset_group_id, field_type, date` UNIQUE) |
| `creative_library` | 소재 이미지 BLOB 영구 저장 |
| `platform_asset_map` | 소재→플랫폼 업로드 매핑 |
| `ad_automation_rules` | ROAS 자동 ON/OFF 규칙 정의 |
| `ad_rule_log` | 규칙 실행 로그 |
| `creatives` | 소재 에셋 메타데이터 |
| `alerts` | 알림 발송 이력 |

---

## 대시보드 메뉴 구성

- **Overview** — KPI 카드, 캠페인별 성과 요약
- **Campaigns** — 캠페인 목록 및 일별 성과 테이블
- **Creatives** — 소재 성과 갤러리 (탭: 소재 성과 / Google 에셋 등급 / PMAX 에셋 성과)
- **Creative Upload** — 소재 업로드 및 파이프라인
- **Automation** — ROAS 자동 ON/OFF 규칙 + Slack 알림 설정 + 캠페인 제어
- **Settings** — 플랫폼 연동 설정

---

## ROAS 자동 ON/OFF 규칙 시스템

### 구조
- `src/analytics/rule-engine.js` — `RuleEngine` 클래스
- `runAll()` / `runOne(ruleId)` — 규칙 평가 및 Meta API 실행
- 평가 기준: `ad_performance` 테이블에서 `lookback_days` 기간 ROAS 집계
- 실행 결과: `ad_rule_log` 저장 + Slack 알림

### API 엔드포인트
```
GET    /api/rules               # 규칙 목록
POST   /api/rules               # 규칙 생성
PUT    /api/rules/:id           # 규칙 수정
DELETE /api/rules/:id           # 규칙 삭제
POST   /api/rules/:id/run       # 단건 수동 실행
POST   /api/rules/run-all       # 전체 수동 실행
GET    /api/rules/:id/log       # 실행 로그
```

---

## Google Ads API 주요 주의사항

- **CTR/CPC/ROAS 집계**: `AVG()` 사용 금지 → `SUM(clicks)/SUM(impressions)` 방식으로 계산
- **PMAX 에셋 성과 쿼리**: `segments.date`를 반드시 SELECT에 포함해야 일별 row 반환 (없으면 전체 합산 1건)
- **캠페인 상태 필터**: `campaign.status = 'ENABLED'` 쓰면 paused 캠페인 누락 → `campaign.status != 'REMOVED'` 사용
- **PMAX 에셋 한도**: MARKETING_IMAGE / SQUARE / PORTRAIT = 20개, LOGO = 5개
- **fieldType 숫자 매핑**: 5=MARKETING_IMAGE, 7=YOUTUBE_VIDEO, 19=SQUARE_MARKETING_IMAGE, 20=PORTRAIT_MARKETING_IMAGE
- **이미지 CSP**: `tpc.googlesyndication.com`, `img.youtube.com` 허용 필요

---

## Meta API 주요 주의사항

- 예산 단위: Meta API는 원화(KRW) 기준 그대로 전달 (cents 변환 없음)
- 광고 개별 ON/OFF: `MetaAdsClient.updateAdStatus(adId, 'ACTIVE'|'PAUSED')`
- 인사이트 조회: `getAdInsights()` — ad 레벨 ROAS 포함
- 이미지 해시: `getAdImageHashes()` — creative 이미지 CDN URL 매핑

---

## 코딩 컨벤션

- 새 DB 컬럼/테이블 추가 시 반드시 `db.js`에 migration 함수 추가 (`ALTER TABLE` 패턴 유지)
- API 라우트는 `server.js` 하단에 추가, 입력값은 `validateRequired()` / `validatePlatform()` 헬퍼로 검증
- 클라이언트 싱글턴은 `getMetaClient()` / `getGoogleClient()` 패턴 사용 (직접 `new` 하지 말 것)
- 프론트엔드는 단일 HTML 파일 (`src/dashboard/index.html`) — React 컴포넌트를 파일 내에 직접 작성
