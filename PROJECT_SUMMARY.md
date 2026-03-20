# Ad Automation Framework — 프로젝트 정리

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
| 스케줄러 | node-cron (15분 주기) |

---

## 전체 파일 구조

```
ad-automation-framework/
├── src/
│   ├── server.js                # Express API 서버 + WebSocket (port 3099)
│   ├── analytics/
│   │   ├── collector.js         # Meta API 데이터 수집 (15분 주기)
│   │   └── optimizer.js         # ROAS/CPA 기반 예산 최적화
│   ├── content/
│   │   ├── copy-templates.js    # 광고 카피 템플릿 엔진
│   │   ├── creative-pipeline.js # 소재 조립 → 플랫폼 등록
│   │   ├── ab-testing.js        # A/B 테스트 관리
│   │   └── audience-manager.js  # 오디언스/타겟팅 관리
│   ├── meta/
│   │   └── client.js            # Meta Marketing API 클라이언트
│   ├── google/
│   │   └── client.js            # Google Ads API 클라이언트 (미연결)
│   ├── tiktok/
│   │   └── client.js            # TikTok Ads API 클라이언트 (미연결)
│   ├── openclaw-skills/
│   │   ├── ad-manager.skill.js  # 챗봇 스킬 (키워드 기반 의도 분류)
│   │   └── skill.yaml           # 스킬 메타데이터
│   ├── utils/
│   │   ├── db.js                # SQLite 초기화 및 쿼리
│   │   ├── logger.js            # Winston 로거
│   │   ├── notifier.js          # Slack/Telegram 알림
│   │   └── ...                  # 기타 유틸
│   └── dashboard/
│       └── index.html           # React 대시보드 (port 3100)
├── config/
│   └── default.env              # 환경변수 템플릿
├── .env                         # 실제 환경변수 (API 키 등)
└── package.json
```

---

## 데이터 흐름

```
Meta API
   ↓ (15분마다 자동 수집)
SQLite (data/ads.db)
   ↓
Express API 서버 (port 3099)
   ↓              ↓
대시보드        챗봇 (Ask)
(차트/KPI)    (성과 조회/설정 변경)
```

---

## 수집 데이터 (SQLite 테이블)

| 테이블 | 내용 |
|---|---|
| `campaigns` | 캠페인 목록 (이름, 상태, 예산 등) |
| `performance` | 캠페인별 성과 (ROAS, CPA, CTR, 지출 등) |
| `ad_performance` | 소재별 성과 (오늘 추가) |
| `alerts` | ROAS/CPA 임계값 초과 알림 이력 |
| `budget_history` | 예산 변경 이력 |
| `creatives` | 소재 정보 |
| `creative_performance` | 소재 성과 (크리에이티브 파이프라인용) |

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

```powershell
cd "c:\Users\AC1135\ad-automation-framework"
npm run dev
```

- API 서버: http://localhost:3099
- 대시보드: http://localhost:3100

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

## 다음 작업 예정

- [ ] 소재 레벨 데이터 수집 확인 (`ad_performance` 테이블 데이터 적재 확인)
- [ ] 과거 데이터 백필 여부 결정 (현재 오늘 데이터만 수집 중)
- [ ] DB Browser로 수집 데이터 팀 분석
