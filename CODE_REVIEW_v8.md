# Code Review: ad-automation-framework v1.0.0

**Review Date**: 2026-03-19
**Reviewer**: Claude Code (Automated Review)
**Codebase**: ~4,500 LOC / 21 modules
**Stack**: Node.js 22 + Express + React 18 + SQLite (WAL) + WebSocket

---

## Executive Summary

Meta & Google Ads 자동화 프레임워크로, 실시간 React 대시보드, WebSocket 라이브 업데이트, NLP 기반 챗 인터페이스, 멀티채널 알림을 포함합니다. 전반적으로 견고한 아키텍처 패턴(Singleton, Adapter, Transaction)을 사용하고 있으나, **보안 취약점**(자격증명 노출, 인증 미비)과 **확장성 제약**(인메모리 Rate Limiting, 동기식 DB)이 존재합니다.

**Overall Grade: B+**

---

## 1. Architecture Overview

```
src/
├── server.js                    # Express API + WebSocket (604 lines)
├── analytics/
│   ├── collector.js             # 15분 주기 데이터 수집
│   └── optimizer.js             # 예산 재배분 분석
├── content/
│   ├── creative-pipeline.js     # 광고 등록 파이프라인
│   ├── copy-templates.js        # 카피 템플릿 엔진
│   ├── ab-testing.js            # A/B 테스트 통계 엔진
│   └── audience-manager.js      # 타겟팅 자동화
├── google/client.js             # Google Ads API
├── meta/client.js               # Meta Marketing API
├── tiktok/client.js             # TikTok Ads API
├── utils/
│   ├── db.js                    # SQLite 스키마 + 초기화
│   ├── logger.js                # Winston 로깅
│   ├── notifier.js              # Slack/Telegram 알림
│   ├── base-client.js           # 클라이언트 베이스 클래스
│   ├── clients.js               # 클라이언트 싱글톤 레지스트리
│   ├── services.js              # 서비스 싱글톤 레지스트리
│   ├── platform-adapter.js      # 통합 플랫폼 인터페이스
│   ├── statistics.js            # 순수 JS 통계 라이브러리
│   ├── format.js                # 로케일 포매터
│   └── intent-classifier.js     # TF-IDF NLP 분류기
├── dashboard/index.html         # React SPA (929 lines)
└── openclaw-skills/
    └── ad-manager.skill.js      # OpenClaw 챗 통합
```

**Data Flow:**
```
Collector (cron 15m) → Platform APIs → SQLite (WAL) → Optimizer → WebSocket → Dashboard
                                                     → Notifier → Slack/Telegram
```

---

## 2. Strengths

### Architecture
- **Singleton 서비스 레지스트리**: Lazy 초기화로 중복 API 클라이언트 방지, `resetServices()`로 테스트 가능
- **Platform Adapter 패턴**: Meta/Google/TikTok을 통합 인터페이스로 추상화, if-else 제거
- **이벤트 기반 실시간 업데이트**: Collector → WebSocket broadcast → Dashboard 자동 갱신

### Database
- **WAL 모드 + Foreign Keys**: 동시 쓰기 성능 + 데이터 무결성
- **적절한 인덱스**: `(campaign_id, date_start)`, `(platform, date_start)`, 중복방지 인덱스
- **트랜잭션 사용**: Collector에서 `db.transaction()` 활용

### Testing
- **94개 테스트 전체 통과** (569ms)
- Integration 테스트: DB 스키마, CRUD, REST 엔드포인트, 인증 미들웨어
- Load 테스트: 동시성, Rate Limiting, 처리량 (46,797 cls/s NLP)

### API Design
- **25+ REST 엔드포인트**: 잘 구조화된 RESTful 설계
- **입력 검증**: `validatePlatform()`, `validateDays()`, `validateRequired()`
- **Rate Limiting**: Read 120/min, Mutation 20/min (IP별)

---

## 3. Issues & Recommendations

### CRITICAL — 프로덕션 배포 전 필수 (로컬 테스트 단계에서는 조치 불필요)

> 아래 3건은 모두 **외부 네트워크 노출 시** 위험한 이슈입니다.
> 로컬(localhost) 테스트 환경에서는 외부 접근이 불가능하므로 실질적 위험이 없으며,
> **프로덕션 배포 직전에 반드시 해결**해야 합니다.

| # | Issue | File | Impact | Fix | 적용 시점 |
|---|-------|------|--------|-----|-----------|
| 1 | **API 자격증명 .env에 노출** | `.env` | git push 시 토큰 유출 → 광고 계정 무단 접근 | `.env`를 `.gitignore`에 추가, 토큰 교체, Secrets Manager 사용 | 배포 전 |
| 2 | **WebSocket 인증 없음** | `server.js:104-109` | 외부에서 WS 연결로 실시간 데이터 수신 가능 | WS upgrade 시 Bearer token 검증 추가 | 배포 전 |
| 3 | **HTTPS 미적용** | `server.js` | 네트워크 스니핑으로 인증 토큰 + 데이터 탈취 | nginx 리버스 프록시 + TLS 인증서 적용 (로컬에서 적용 시 자체서명 인증서 문제 발생) | 배포 전 |

### HIGH — 프로덕션 배포 전 권장

| # | Issue | File | Impact | Fix | 로컬에서 필요? |
|---|-------|------|--------|-----|---------------|
| 4 | **CORS 전체 허용** | `server.js:21` | `origin: '*'` — CSRF 공격 가능 | 프로덕션에서 특정 origin만 화이트리스트 | 아니오 |
| 5 | **인증 선택적 (dev mode)** | `server.js:31` | `API_AUTH_TOKEN` 미설정 시 인증 비활성화 | 프로덕션 환경에서는 토큰 필수로 설정 | 아니오 |
| 6 | **외부 API 호출 타임아웃 없음** | `meta/client.js`, `google/client.js` | 느린 API가 이벤트 루프를 무한 차단 | 모든 외부 API 호출에 30초 타임아웃 추가 | **예 — 로컬에서도 API 지연 시 서버가 멈춤** |
| 7 | **Circuit Breaker 미구현** | `collector.js` | API 장애 시 15분마다 계속 실패 요청 반복 | opossum 등 Circuit Breaker 패턴 도입 | 아니오 |
| 8 | **보안 헤더 미적용** | `server.js` | XSS, Clickjacking 등 브라우저 공격에 취약 | `helmet.js` 미들웨어 추가 | 아니오 |

### MEDIUM

| # | Issue | File | Impact | Fix | 로컬에서 필요? |
|---|-------|------|--------|-----|---------------|
| 9 | **인메모리 Rate Limiting** | `server.js:42-67` | 서버 재시작 시 초기화, 멀티 인스턴스 미지원 | Redis 기반 분산 Rate Limiting으로 전환 | 아니오 |
| 10 | **GAQL 문자열 보간** | `google/client.js:63` | `safeFilter.join("','")` — 화이트리스트 검증 있지만 취약한 패턴 | 파라미터화된 쿼리 API 사용 | 아니오 |
| 11 | **스키마 검증 라이브러리 없음** | 전체 | 런타임 타입 에러 가능 | `zod` 또는 `joi`로 요청 스키마 검증 | 아니오 |
| 12 | **대시보드 단일 파일** | `dashboard/index.html` (929 lines) | 테스트/유지보수 어려움 | React 컴포넌트 분리 + Vite SPA 구조로 전환 | 아니오 |
| 13 | **페이지네이션 미구현** | `server.js` list 엔드포인트들 | 캠페인 10,000+개 시 성능 저하 | `limit/offset` 커서 기반 페이지네이션 추가 | 아니오 |
| 14 | **에러 메시지 클라이언트 노출** | 다수 엔드포인트 | `err.message`가 응답에 그대로 전달 | 내부 로깅 후 클라이언트에는 일반 메시지 반환 | **권장 — 프로덕션 전환 시 빠뜨리기 쉬움** |
| 15 | **Facebook SDK 버전** | `meta/client.js` | v20.0은 EOL, 보안 패치 누락 가능 | 최신 버전으로 업그레이드 | 아니오 |

### LOW

| # | Issue | File | Impact | Fix | 로컬에서 필요? |
|---|-------|------|--------|-----|---------------|
| 16 | **구조화된 로깅 부족** | `logger.js` | 요청 추적용 correlation ID 없음 | correlation ID 미들웨어 추가 | 아니오 |
| 17 | **TypeScript 미사용** | 전체 | 런타임 에러, IDE 자동완성 약함 | 점진적 TypeScript 마이그레이션 | 아니오 |
| 18 | **환경변수 유효성 검증 없음** | 클라이언트 초기화 시 | 자격증명 누락 시 불분명한 에러 | 시작 시 필수 환경변수 검증, fail-fast | **예 — .env 설정 실수 시 디버깅 시간 절약** |
| 19 | **차트 불필요한 리렌더링** | `dashboard/index.html` | 데이터 업데이트마다 전체 차트 리렌더 | `React.memo` 적용 | 아니오 |
| 20 | **접근성(A11Y) 미비** | `dashboard/index.html` | ARIA 레이블, 키보드 내비게이션 없음 | 시맨틱 HTML + ARIA 속성 추가 | 아니오 |

### 로컬 테스트 단계에서 개선 권장 항목 요약

| # | Issue | Severity | 로컬에서 고치면 좋은 이유 |
|---|-------|----------|-------------------------|
| 6 | 외부 API 호출 타임아웃 없음 | HIGH | Meta/Google API 지연 시 로컬 서버가 무한 대기하며 멈춤. 개발 중 직접 체감하는 문제 |
| 18 | 환경변수 유효성 검증 없음 | LOW | `.env`에 값 하나 빠졌을 때 원인 불명 에러 발생. fail-fast로 디버깅 시간 대폭 절약 |
| 14 | 에러 메시지 클라이언트 노출 | MEDIUM | 지금 습관적으로 분리해두면 프로덕션 전환 시 빠뜨리지 않음 |

---

## 4. API Endpoints Summary

### Dashboard
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/overview` | KPI 요약 (spend, ROAS, CPA, CTR) — `platform` 필터 지원 |
| GET | `/api/campaigns` | 활성 캠페인 목록 |
| GET | `/api/performance/timeline` | 차트용 시계열 데이터 — `platform` 필터 지원 |
| GET | `/api/alerts` | 최근 알림 |
| POST | `/api/alerts/:id/acknowledge` | 알림 확인 |
| GET | `/api/optimization` | 예산 재배분 제안 |
| POST | `/api/campaigns/:id/budget` | 일일 예산 변경 |
| POST | `/api/campaigns/:id/status` | 캠페인 상태 변경 |
| GET | `/api/budget-history/:campaignId` | 예산 변경 이력 |

### Content Management
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/templates` | 카피 템플릿 목록 |
| POST | `/api/templates` | 커스텀 템플릿 생성 |
| GET | `/api/creatives` | 광고 소재 목록 |
| POST | `/api/creatives/assemble` | 템플릿 기반 소재 조립 |
| POST | `/api/creatives/:id/register` | 플랫폼에 소재 등록 |
| POST | `/api/creatives/pipeline` | 전체 파이프라인 (템플릿 → 조립 → 등록) |

### A/B Testing
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/ab-tests` | 테스트 목록 |
| POST | `/api/ab-tests` | 테스트 생성 |
| POST | `/api/ab-tests/:id/evaluate` | 통계적 유의성 평가 |

### Audience Management
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/audiences` | 오디언스 목록 |
| POST | `/api/audiences/meta/pixel` | 픽셀 기반 오디언스 |
| POST | `/api/audiences/meta/lookalike` | 유사 오디언스 |
| POST | `/api/audiences/google/remarketing` | 리마케팅 리스트 |
| POST | `/api/audiences/apply` | 프리셋 + 오디언스 적용 |

### Chat
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/chat` | NLP 기반 자연어 명령 (30 req/min) |

### WebSocket Events
| Event | Purpose |
|-------|---------|
| `performance_update` | 수집 후 성과 데이터 갱신 |
| `budget_changed` | 예산 변경 알림 |
| `status_changed` | 캠페인 상태 변경 |
| `creative_assembled` | 소재 조립 완료 |
| `ab_test_evaluated` | A/B 테스트 평가 완료 |

---

## 5. Test Coverage

| Area | Status | Details |
|------|--------|---------|
| DB 스키마 & CRUD | ✅ | 캠페인, 성과, 알림, 예산이력, 크리에이티브 |
| 입력 검증 | ✅ | validatePlatform, validateDays, Rate Limiting |
| 인증 미들웨어 | ✅ | Bearer token 검증 로직 |
| Intent Classifier | ✅ | 한국어/영어 11개 intent, 엣지 케이스 |
| 통계 엔진 | ✅ | Z-test, Wilson CI, 최소 샘플 크기 |
| Platform Adapter | ✅ | 3개 플랫폼 어댑터, 상태 정규화 |
| 부하 테스트 | ✅ | DB 동시 쓰기, Rate Limiter, NLP 처리량 |
| E2E 파이프라인 | ✅ | 수집 → 분석 → 알림 전체 흐름 |
| **프론트엔드 컴포넌트** | ❌ | React 컴포넌트 테스트 없음 |
| **WebSocket 통합** | ❌ | WS 연결/메시지 테스트 없음 |
| **E2E (브라우저)** | ❌ | Playwright/Cypress 없음 |

**총 94개 테스트 통과 / 569ms**

---

## 6. Database Schema

| Table | Purpose | Key Index |
|-------|---------|-----------|
| `campaigns` | 캠페인 마스터 | `UNIQUE(platform, platform_id)` |
| `performance` | 15분 주기 성과 스냅샷 | `UNIQUE(campaign_id, platform, date_start)` |
| `ad_groups` | 광고그룹 계층 | `UNIQUE(platform, platform_id)` |
| `ads` | 광고 계층 | `UNIQUE(platform, platform_id)` |
| `ad_performance` | 광고 레벨 성과 | `UNIQUE(ad_id, date_start)` |
| `alerts` | 알림 로그 | `idx_alerts_campaign` |
| `budget_history` | 예산 변경 감사 이력 | `idx_budget_history_campaign` |
| `creatives` | 광고 소재 | `(platform, status)` |
| `creative_performance` | 소재별 성과 | `(creative_id)` |
| `ab_tests` | A/B 테스트 메타데이터 | `(status)` |
| `audiences` | 오디언스 레지스트리 | `(platform, type)` |

---

## 7. Action Plan

### 로컬 테스트 단계 (지금)
1. 외부 API 호출에 30초 타임아웃 추가 (#6)
2. 시작 시 필수 환경변수 유효성 검증 (#18)
3. 에러 메시지 내부 로깅/클라이언트 분리 (#14)

### 프로덕션 배포 직전 (필수)
4. 모든 API 자격증명 교체 (Meta, Google) (#1)
5. `.env`를 `.gitignore`에 추가 (#1)
6. WebSocket upgrade 시 Bearer token 검증 추가 (#2)
7. HTTPS 적용 — nginx 리버스 프록시 (#3)
8. CORS origin 화이트리스트 적용 (#4)
9. 프로덕션 환경에서 인증 토큰 필수화 (#5)
10. `helmet.js` 보안 헤더 추가 (#8)

### Short Term (배포 후 1~2 스프린트)
11. Circuit Breaker 패턴 도입 (#7)
12. Redis 기반 Rate Limiting 전환 (#9)
13. `zod` 스키마 검증 도입 (#11)
14. list 엔드포인트 페이지네이션 추가 (#13)
15. Facebook SDK 최신 버전 업그레이드 (#15)

### Medium Term (다음 분기)
16. 대시보드 React 컴포넌트 분리 (#12)
17. TypeScript 점진적 마이그레이션 (#17)
18. E2E 테스트 — Playwright 추가
19. 구조화된 로깅 — correlation ID (#16)

### Long Term (향후)
20. SQLite → PostgreSQL 마이그레이션 (멀티 인스턴스)
21. Redis 캐싱 레이어
22. APM/분산 추적 (Datadog, New Relic)

---

## 8. Conclusion

잘 구조화된 코드베이스로 Singleton, Adapter, Transaction 패턴을 적절히 활용하고 있습니다. 94개 테스트가 전체 통과하며, 현재 규모(~1,000 캠페인)에서는 안정적으로 작동합니다. **최우선 과제는 자격증명 보안과 인증 강화**이며, 이를 해결하면 프로덕션 배포가 가능한 수준입니다.
