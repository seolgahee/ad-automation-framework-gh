# Ad Automation Framework — 설치 및 사용 가이드

**최초 작성일**: 2026-03-17
**최종 수정일**: 2026-03-20

---

## 1. 사전 요구사항

| 항목 | 최소 버전 | 확인 명령 |
|------|-----------|-----------|
| **Node.js** | v22.0.0+ | `node -v` |
| **npm** | v10+ | `npm -v` |
| **SQLite3** | 내장 (better-sqlite3) | 자동 설치 |

---

## 2. 설치

```bash
# 1) 프로젝트 폴더로 이동
cd ad-automation-framework

# 2) 의존성 설치
npm install

# 3) 환경변수 설정 — .env 파일 생성
cp config/default.env .env
```

`.env` 파일을 열어 **본인의 API 자격증명**을 입력합니다.

---

## 3. 환경변수 설정 (.env)

### Meta (Facebook) Marketing API

```env
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_ACCESS_TOKEN=your_long_lived_token
META_AD_ACCOUNT_ID=act_XXXXXXXXX
META_PIXEL_ID=your_pixel_id
```

**토큰 발급 방법:**
1. [Facebook for Developers](https://developers.facebook.com) → 앱 생성
2. Marketing API 권한 추가
3. Graph API Explorer에서 Long-lived Access Token 생성
4. 광고 계정 ID는 `act_` 접두사 포함 (예: `act_123456789`)

### Google Ads API

```env
GOOGLE_ADS_CLIENT_ID=your_client_id
GOOGLE_ADS_CLIENT_SECRET=your_client_secret
GOOGLE_ADS_DEVELOPER_TOKEN=your_developer_token
GOOGLE_ADS_REFRESH_TOKEN=your_refresh_token
GOOGLE_ADS_CUSTOMER_ID=123-456-7890
GOOGLE_ADS_LOGIN_CUSTOMER_ID=123-456-7890
```

**토큰 발급 방법:**
1. [Google Ads API 센터](https://developers.google.com/google-ads/api/docs/first-call/overview)에서 개발자 토큰 신청
2. Google Cloud Console에서 OAuth 2.0 클라이언트 생성
3. `google-ads-api` 라이브러리의 인증 플로우로 Refresh Token 발급

### TikTok Ads API

```env
TIKTOK_ACCESS_TOKEN=your_access_token
TIKTOK_ADVERTISER_ID=your_advertiser_id
```

**토큰 발급 방법:**
1. [TikTok for Business](https://business-api.tiktok.com) → 개발자 앱 생성
2. Marketing API 접근 승인 후 Access Token 발급

### 알림 채널 (선택)

```env
# Slack 알림
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ

# Telegram 알림
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 서버 설정

```env
API_PORT=3099                    # API 서버 포트
DASHBOARD_PORT=3100              # 대시보드 포트
DB_PATH=./data/ads.db            # SQLite DB 경로
COLLECT_INTERVAL_MINUTES=15      # 데이터 수집 주기 (분)
API_AUTH_TOKEN=                  # 비어두면 개발 모드 (인증 없음)
```

### 알림 임계값

```env
ALERT_ROAS_THRESHOLD=1.5         # ROAS가 이 값 아래면 경고
ALERT_CPA_THRESHOLD=50000        # CPA가 ₩50,000 초과 시 경고
ALERT_BUDGET_BURN_RATE=0.85      # 예산 소진율 85% 초과 시 경고
```

---

## 4. 초기 설정

```bash
npm run setup
```

이 명령이 수행하는 작업:
1. `.env` 파일 존재 확인 (없으면 `config/default.env`에서 복사)
2. SQLite 데이터베이스 초기화 (테이블 생성)
3. 기본 카피 템플릿 시딩
4. Meta / Google API 자격증명 유효성 검증

---

## 5. 실행

### 개발 모드 (API 서버 + 대시보드 동시 실행)

```bash
npm run dev
```

실행 후 접속:
- **API 서버**: `http://localhost:3099`
- **대시보드**: `http://localhost:3100`
- **WebSocket**: `ws://localhost:3099/ws`

### 서버만 실행

```bash
npm run server
```

### 대시보드만 실행

```bash
npm run dashboard
```

---

## 6. 데이터 동기화

### 캠페인 동기화 (Meta / Google → 로컬 DB)

```bash
npm run sync-campaigns
```

처음 실행 시, 각 플랫폼의 활성 캠페인을 로컬 SQLite로 가져옵니다.

### 수동 데이터 수집

```bash
npm run collect
```

서버 실행 중에는 `COLLECT_INTERVAL_MINUTES` (기본 15분) 간격으로 자동 수집됩니다.

---

## 7. 주요 기능 사용법

### 7-1. 대시보드

`http://localhost:3100` 접속 후:
- **Overview** — 총 지출, 전환수, ROAS, CPA, CTR 실시간 KPI
- **캠페인 목록** — 예산 수정, 상태 변경 (활성/일시정지)
- **성과 차트** — 플랫폼별 시계열 그래프
- **알림** — ROAS 하락, CPA 초과, 예산 소진율 경고
- **크리에이티브** — 템플릿 기반 광고 소재 조합 & 등록
- **A/B 테스트** — 다변량 테스트 생성 및 통계적 유의성 평가
- **타겟 오디언스** — 픽셀/고객목록/유사타겟 생성
- **채팅** — 자연어로 캠페인 관리 (한국어/영어 지원)

### 7-2. 채팅 명령어 예시

대시보드 하단의 채팅창에서:

| 입력 예시 | 동작 |
|-----------|------|
| `성과 보여줘` | 최근 7일 캠페인 성과 요약 |
| `예산 늘려줘` | 특정 캠페인 예산 변경 |
| `캠페인 일시정지` | 캠페인 상태 → PAUSED |
| `캠페인 활성화` | 캠페인 상태 → ACTIVE |
| `최적화 추천` | ROAS 기반 예산 재배분 제안 |
| `캠페인 목록` | 전체 캠페인 리스트 |
| `알림 확인` | 최근 미확인 알림 |
| `광고 만들어줘` | 크리에이티브 파이프라인 실행 |
| `템플릿 목록` | 사용 가능한 카피 템플릿 |
| `AB 테스트` | A/B 테스트 생성/관리 |
| `타겟 설정` | 오디언스 타겟팅 |
| `크리에이티브 목록` | 등록된 광고 소재 리스트 |

### 7-3. REST API 직접 호출

```bash
# 개요 조회
curl http://localhost:3099/api/overview?days=7

# 캠페인 목록
curl http://localhost:3099/api/campaigns

# 예산 변경
curl -X POST http://localhost:3099/api/campaigns/1/budget \
  -H "Content-Type: application/json" \
  -d '{"daily_budget": 100000}'

# 캠페인 상태 변경
curl -X POST http://localhost:3099/api/campaigns/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "PAUSED"}'

# 성과 타임라인 (Meta만, 최근 14일)
curl "http://localhost:3099/api/performance/timeline?days=14&platform=meta"

# 최적화 추천
curl "http://localhost:3099/api/optimization?budget=5000000"
```

인증 모드에서는 `-H "Authorization: Bearer YOUR_TOKEN"` 추가.

---

## 8. 테스트

```bash
# 전체 테스트 (94개)
npm test

# 통합 테스트만 (65개)
npm run test:integration

# 부하 테스트만 (29개)
npm run test:load

# 워치 모드
npm run test:watch
```

---

## 9. 프로젝트 구조

```
ad-automation-framework/
├── config/
│   └── default.env              # 환경변수 템플릿
├── data/
│   └── ads.db                   # SQLite 데이터베이스 (자동 생성)
├── scripts/
│   ├── setup.js                 # 초기 설정 스크립트
│   ├── collect-data.js          # 수동 데이터 수집
│   ├── collect-historical.js    # 과거 데이터 백필 (Meta)
│   └── sync-campaigns.js        # 캠페인 동기화
├── src/
│   ├── server.js                # Express API + WebSocket 서버
│   ├── analytics/
│   │   ├── collector.js         # 정기 데이터 수집기 (Meta + Google + TikTok)
│   │   └── optimizer.js         # ROAS 최적화 엔진
│   ├── content/
│   │   ├── ab-testing.js        # A/B 테스트 (Z-검정, Wilson CI)
│   │   ├── audience-manager.js  # 오디언스/타겟팅 관리
│   │   ├── copy-templates.js    # 광고 카피 템플릿 엔진
│   │   └── creative-pipeline.js # 크리에이티브 파이프라인
│   ├── dashboard/
│   │   └── index.html           # React SPA 대시보드
│   ├── meta/
│   │   └── client.js            # Meta Marketing API 클라이언트
│   ├── google/
│   │   └── client.js            # Google Ads API 클라이언트
│   ├── tiktok/
│   │   └── client.js            # TikTok Marketing API 클라이언트
│   ├── openclaw-skills/
│   │   └── ad-manager.skill.js  # 자연어 채팅 스킬
│   └── utils/
│       ├── base-client.js       # 플랫폼 클라이언트 베이스 클래스 (타임아웃 헬퍼)
│       ├── clients.js           # 플랫폼 클라이언트 싱글톤
│       ├── db.js                # DB 스키마 & 초기화
│       ├── format.js            # KRW 포맷터
│       ├── intent-classifier.js # TF-IDF 의도 분류기
│       ├── logger.js            # Winston 구조화 로거
│       ├── notifier.js          # Slack/Telegram 알림 발송
│       ├── platform-adapter.js  # 3-플랫폼 통합 어댑터
│       ├── services.js          # 서비스 싱글톤 레지스트리
│       └── statistics.js        # 통계 엔진 (Z-test, Wilson CI)
├── tests/
│   ├── integration.test.js      # 통합 테스트 (65개)
│   ├── load.test.js             # 부하 테스트 (29개)
│   └── test-db.js               # sql.js 테스트 DB 헬퍼
├── package.json
├── vitest.config.js
└── CODE_REVIEW_v8.md
```

---

## 10. 빠른 시작 (Quick Start)

```bash
# 1단계: 설치
cd ad-automation-framework
npm install

# 2단계: 환경변수 설정
cp config/default.env .env
# .env 파일을 편집하여 API 키 입력

# 3단계: 초기 설정
npm run setup

# 4단계: 캠페인 동기화
npm run sync-campaigns

# 5단계: 실행
npm run dev

# → 브라우저에서 http://localhost:3100 접속
```

---

## 11. 주의사항

- **Node.js 22+** 필수 (ES Module, top-level await 사용)
- **TikTok 플랫폼**: `db.js`의 CHECK 제약조건에 `'tiktok'`이 아직 추가되지 않았습니다 — TikTok 데이터 수집 전에 해당 제약조건을 업데이트해야 합니다
- **프로덕션 배포 시**: `API_AUTH_TOKEN`을 반드시 설정하고, 대시보드의 CDN 의존성에 SRI 해시를 추가하세요
- **데이터 수집**: 서버가 실행 중이어야 자동 수집이 동작합니다
- **data/ 폴더**: `ads.db-shm`, `ads.db-wal` 파일은 SQLite WAL 모드의 정상 파일입니다. 삭제하지 마세요
- **과거 데이터 백필**: `node scripts/collect-historical.js 2026-03-01 2026-03-18` (현재 Meta 전용)
- **DB 파일 조회**: DB Browser for SQLite, DBeaver, 또는 VS Code의 SQLite Viewer 확장을 사용하세요
