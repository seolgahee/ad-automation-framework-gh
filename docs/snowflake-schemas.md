# Snowflake Schemas — Inventory & Sales

> 재고/판매 분석에서 사용하는 PRCS 스키마의 주요 테이블 정의. 새 쿼리를 짤 때 이 문서를 먼저 참고할 것.

## 테이블 카탈로그

| 테이블 | 단위 | 차원 | 데이터 |
|--------|------|------|--------|
| `DW_SCS_D` | 일자별 | SKU | 발주, 입고, 출고, 판매 |
| `DW_SCS_DACUM` | 일자 스냅샷 | SKU | 누적 발주/입고/출고/판매/재고 |
| `DW_SH_SCS_D` | 일자별 | 매장×SKU | 출고, 판매 |
| `DW_SH_SCS_DACUM` | 일자 스냅샷 | 매장×SKU | 누적 출고/판매, 매장재고 |
| `DB_SCS_W` | 주차별 | SKU | 발/입/출/판 + 누적 + 재고 |
| `DB_SCS_M` | 월별 | SKU | 발/입/출/판 + 누적 + 재고 |
| `DB_SH_S_W` | 주차별 | 매장×품번 | 출/판 + 누적 + 재고 |
| `DB_SH_S_M` | 월별 | 매장×품번 | 출/판 + 누적 + 재고 |

---

## 채널 컬럼 매핑 (중요)

테이블마다 채널 분리 방식이 다름.

### `DW_SH_SCS_DACUM` — 매장×SKU 누적 스냅샷
| 접미사 | 컬럼 (정상 수량) | 의미 |
|--------|------------------|------|
| `_SH` | `AC_SALE_NML_QTY_SH` | 매장 (오프라인 매장 통칭 — 백화점/대리점/직영점 등) |
| `_ON` | `AC_SALE_NML_QTY_ON` | 온라인 |
| `_EV` | `AC_SALE_NML_QTY_EV` | 행사 |
| `_DOME` | `AC_SALE_NML_QTY_DOME` | 도매 |

→ **별도 백화점/대리점/직영점 컬럼은 없음**. 이 테이블에서 "오프라인" = `_SH`로 통칭.

### `DB_SCS_W` — 주차별 SKU
| 접미사 | 컬럼 | 의미 |
|--------|------|------|
| `_CNS` | `SALE_NML_QTY_CNS` | 위탁 (백화점 등) |
| `_CNS_ON` | `SALE_NML_QTY_CNS_ON` | 위탁 온라인 |
| `_CNS_OFF` | `SALE_NML_QTY_CNS_OFF` | 위탁 오프라인 |
| `_RTL` | `SALE_NML_QTY_RTL` | 소매 |
| `_DOME` | `SALE_NML_QTY_DOME` | 도매 |
| `_WSL` | `SALE_NML_QTY_WSL` | 사입 |
| `_NOTAX` | `SALE_NML_QTY_NOTAX` | 면세 |
| `_RF` | `SALE_NML_QTY_RF` | RF |
| `_HK` / `_MO` / `_TW` / `_HMD` / `_TV` / `_CHN` / `_GVL` | 지역별 | 홍콩 / 마카오 / 대만 / 홍마대 / 태베 / 중국 / 글로벌 |

### `DW_SH_SCS_D` — 매장×SKU 일별
- 채널 분리 컬럼 **없음**. 단일 `SALE_NML_QTY` / `SALE_RET_QTY`.
- 채널 구분은 `SHOP_ID`로만 가능.
- 자사몰 = `SHOP_ID = '30001'` (env: `JASAMOL_SHOP_ID`).

---

## DW_SH_SCS_DACUM — 전체 컬럼

```sql
create or replace TABLE DW_SH_SCS_DACUM (
    START_DT DATE NOT NULL COMMENT 'PK 시작일자',
    END_DT DATE COMMENT 'PK 종료일자',
    SHOP_ID VARCHAR(8) NOT NULL COMMENT 'PK 매장코드',
    PRDT_CD VARCHAR(24) NOT NULL COMMENT 'PK (브랜드코드+시즌+품번)',
    BRD_CD VARCHAR(2) COMMENT '브랜드코드',
    SESN VARCHAR(4) COMMENT '시즌',
    PART_CD VARCHAR(18) COMMENT '품번',
    COLOR_CD VARCHAR(5) NOT NULL COMMENT 'PK 컬러코드',
    SIZE_CD VARCHAR(3) NOT NULL COMMENT 'PK 사이즈코드',

    -- 누적 출고 (총합 / 창고 / RT / 불량 / 조정 / 기타)
    AC_DELV_NML_QTY, AC_DELV_NML_SUPP_AMT, AC_DELV_NML_TAG_AMT,
    AC_DELV_RET_QTY, AC_DELV_RET_SUPP_AMT, AC_DELV_RET_TAG_AMT,
    AC_DELV_NML_QTY_WH, AC_DELV_NML_SUPP_AMT_WH, AC_DELV_NML_TAG_AMT_WH,
    AC_DELV_RET_QTY_WH, AC_DELV_RET_SUPP_AMT_WH, AC_DELV_RET_TAG_AMT_WH,
    AC_DELV_NML_QTY_RT, AC_DELV_NML_SUPP_AMT_RT, AC_DELV_NML_TAG_AMT_RT,
    AC_DELV_RET_QTY_RT, AC_DELV_RET_SUPP_AMT_RT, AC_DELV_RET_TAG_AMT_RT,
    AC_DELV_NML_QTY_BAD, AC_DELV_NML_SUPP_AMT_BAD, AC_DELV_NML_TAG_AMT_BAD,
    AC_DELV_RET_QTY_BAD, AC_DELV_RET_SUPP_AMT_BAD, AC_DELV_RET_TAG_AMT_BAD,
    AC_DELV_NML_QTY_ADJ, AC_DELV_NML_SUPP_AMT_ADJ, AC_DELV_NML_TAG_AMT_ADJ,
    AC_DELV_RET_QTY_ADJ, AC_DELV_RET_SUPP_AMT_ADJ, AC_DELV_RET_TAG_AMT_ADJ,
    AC_DELV_NML_QTY_ETC, AC_DELV_NML_SUPP_AMT_ETC, AC_DELV_NML_TAG_AMT_ETC,
    AC_DELV_RET_QTY_ETC, AC_DELV_RET_SUPP_AMT_ETC, AC_DELV_RET_TAG_AMT_ETC,

    -- 누적 판매 (총합 / 매장 / 온라인 / 행사 / 도매 / 순수)
    AC_SALE_NML_QTY, AC_SALE_NML_SUPP_AMT, AC_SALE_NML_SALE_AMT, AC_SALE_NML_TAG_AMT,
    AC_SALE_RET_QTY, AC_SALE_RET_SUPP_AMT, AC_SALE_RET_SALE_AMT, AC_SALE_RET_TAG_AMT,
    AC_SALE_NML_QTY_SH, AC_SALE_NML_SUPP_AMT_SH, AC_SALE_NML_SALE_AMT_SH, AC_SALE_NML_TAG_AMT_SH,
    AC_SALE_RET_QTY_SH, AC_SALE_RET_SUPP_AMT_SH, AC_SALE_RET_SALE_AMT_SH, AC_SALE_RET_TAG_AMT_SH,
    AC_SALE_NML_QTY_ON, AC_SALE_NML_SUPP_AMT_ON, AC_SALE_NML_SALE_AMT_ON, AC_SALE_NML_TAG_AMT_ON,
    AC_SALE_RET_QTY_ON, AC_SALE_RET_SUPP_AMT_ON, AC_SALE_RET_SALE_AMT_ON, AC_SALE_RET_TAG_AMT_ON,
    AC_SALE_NML_QTY_EV, AC_SALE_NML_SUPP_AMT_EV, AC_SALE_NML_SALE_AMT_EV, AC_SALE_NML_TAG_AMT_EV,
    AC_SALE_RET_QTY_EV, AC_SALE_RET_SUPP_AMT_EV, AC_SALE_RET_SALE_AMT_EV, AC_SALE_RET_TAG_AMT_EV,
    AC_SALE_NML_QTY_DOME, AC_SALE_NML_SUPP_AMT_DOME, AC_SALE_NML_SALE_AMT_DOME, AC_SALE_NML_TAG_AMT_DOME,
    AC_SALE_RET_QTY_DOME, AC_SALE_RET_SUPP_AMT_DOME, AC_SALE_RET_SALE_AMT_DOME, AC_SALE_RET_TAG_AMT_DOME,
    AC_SALE_NML_QTY_NET, AC_SALE_NML_SUPP_AMT_NET, AC_SALE_NML_SALE_AMT_NET, AC_SALE_NML_TAG_AMT_NET,
    AC_SALE_RET_QTY_NET, AC_SALE_RET_SUPP_AMT_NET, AC_SALE_RET_SALE_AMT_NET, AC_SALE_RET_TAG_AMT_NET,

    -- 매장 재고
    SH_STOCK_QTY NUMBER(38,0) DEFAULT 0 COMMENT '매장 재고 수량',
    SH_STOCK_TAG_AMT NUMBER(38,0) DEFAULT 0 COMMENT '매장 재고 택가',

    primary key (START_DT, PRDT_CD, COLOR_CD, SIZE_CD, SHOP_ID)
);
```

### 사용 시 주의
- **누적 스냅샷**: 기간 [start, end] 판매 = `snap[end].AC - snap[start-1].AC` 차이로 계산.
- **유효구간 모델**: 한 행은 `START_DT ≤ target ≤ END_DT` 또는 `END_DT IS NULL`이면 valid.
- 일별 스냅샷이 없는 날짜는 `START_DT <= ?` 조건으로 가장 가까운 이전 스냅샷을 사용.

---

## DW_SH_SCS_D — 일자별 매장×SKU (출고, 판매)

코드에서 자사몰 일별 판매 집계용으로 사용 (`src/snowflake/client.js`).

키: `BRD_CD`, `SHOP_ID`, `PART_CD`, `COLOR_CD`, `SIZE_CD`, `DT`
주요 컬럼: `SALE_NML_QTY`, `SALE_RET_QTY`, `DELV_NML_QTY`, `DELV_RET_QTY`

채널 분리 컬럼은 없음 — `SHOP_ID = '30001'`로 자사몰만 필터링.

---

## DW_SCS_DACUM — SKU 누적 (재고 조회)

코드에서 품번별 최신 재고 조회용으로 사용 (`src/snowflake/client.js` `fetchStockInfoBatch`).

| 컬럼 | 의미 | 대시보드 표기 |
|------|------|----------------|
| `WH_STOCK_QTY` | 창고 재고 — 온라인 출고용 풀 (특정 채널 전용 아님, 자사몰/외부 온라인 등 모든 온라인 발송에 공통 사용) | **온라인 재고** |
| `STOCK_QTY` | 총 재고 = 창고 + 매장 재고 | **전체 재고** |
| `SH_STOCK_QTY` (DW_SH_SCS_DACUM) | 매장 재고 (오프라인 매장 보유) | — |

조회 패턴: `START_DT = (SELECT MAX(START_DT) WHERE BRD_CD = ? AND PART_CD = ?)` — 최신 스냅샷.

> **온라인 재고일수** = 온라인 재고(WH_STOCK_QTY) ÷ 공식몰 일평균 (자사몰 SHOP_ID=30001) 으로 계산.
> 분자(재고)는 온라인 전체 풀, 분모(판매)는 자사몰만이라 보수적 추정 — 실제 외부 온라인까지 합치면 일수가 더 짧아질 수 있음.
> 오프라인 일평균은 별도 표기되지만 위험도 계산엔 사용하지 않음.

---

## DB_SHOP — 매장 마스터

PK: `(BRD_CD, SHOP_ID)`

매장 채널/유형을 식별할 때 join 대상. 비슷한 의미의 분류 컬럼이 여러 개 있으니 브랜드별로 어떤 게 살아있는지 먼저 확인.

| 컬럼 | 의미 | 코드그룹 |
|------|------|----------|
| `SHOP_NM`, `SHOP_NM_SHORT` | 매장명 / 약칭 | — |
| `SHOP_TYPE` / `SHOP_TYPE_NM` | 매장구분 (일반매장/협력업체/중간관리/본사 — 채널 분류엔 부적합) | C002 |
| `DIST_TYPE` / `DIST_TYPE_NM` | 유통형태 (백화점/대리점(위탁)/본사직영/...) | C006 |
| **`ANAL_DIST_TYPE` / `_NM`** | **유통형태(분석)** ← 채널 분류 정답: `백화점`/`대리점`/`직영점`/`아울렛`/`온라인`/`키즈백화점`/`상설(위탁)`/`상설(사입)`/`면세점`/`키즈아울렛`/`수출(VAT-)`/`기타` | A001 |
| `ANAL_CHNL` / `_NM` | 채널(분석) | A004 |
| `ANLYS_ON_OFF_CLS_CD` / `_NM` | (신규ERP) 온/오프 구분 | — |
| `ANLYS_SHOP_TYPE_CD` / `_NM` | (신규ERP) 매장형태 | — |
| `ANLYS_DIST_TYPE_CD` / `_NM` | (신규ERP) 채널 | — |
| `ONFF_CLS_SF` / `_NM` | Sales Force 온/오프 구분 | C023 |
| `OPEN_DT` / `CLOSE_DT` | 개점일 / 폐점일 (active 필터: `CLOSE_DT IS NULL`) | — |
| `EVENT_SHOP_YN` | 행사매장 여부 | — |
| `SIS_YN` | 샵인샵 여부 | — |
| `EXPORT_YN`, `GLOBAL_DIST_YN` | 수출/해외 여부 | — |

### 채널별 분류 값 확인 쿼리

```sql
-- 어느 컬럼에 백화점/대리점/직영점 같은 분류 값이 들어있는지 확인
SELECT 'SHOP_TYPE' AS COL, SHOP_TYPE_NM AS VAL, COUNT(*) AS CNT
FROM PRCS.DB_SHOP WHERE BRD_CD = 'X' AND CLOSE_DT IS NULL GROUP BY SHOP_TYPE_NM
UNION ALL ... -- (다른 후보 컬럼들도 동일)
ORDER BY COL, CNT DESC;
```

### 활용 예 (오프라인 매출 필터 — 백화점/대리점/직영점)

```sql
WITH offline_shops AS (
  SELECT SHOP_ID FROM PRCS.DB_SHOP
  WHERE BRD_CD = ?
    AND ANAL_DIST_TYPE_NM IN ('백화점', '대리점', '직영점')
)
SELECT s.PART_CD, SUM(s.SALE_NML_QTY - s.SALE_RET_QTY) AS SALE_QTY
FROM PRCS.DW_SH_SCS_D s
JOIN offline_shops os ON s.SHOP_ID = os.SHOP_ID
WHERE s.BRD_CD = ? AND s.PART_CD IN (...) AND s.DT BETWEEN ? AND ?
GROUP BY s.PART_CD
```

> 실제 코드: `src/snowflake/client.js` `fetchStockInfoBatch` 참조.
> 만약 아울렛/키즈백화점도 포함하고 싶으면 IN 리스트 확장.

---

## 인증

- RSA 키페어 (`SNOWFLAKE_JWT`), 서비스 계정 `SVC_ORG_PF`
- 환경변수: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY_PATH`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE`, `SNOWFLAKE_STOCK_SCHEMA` (default `PRCS`)
- 브랜드: `STOCK_BRAND_CD` (default `X` = Discovery)
- 자사몰: `JASAMOL_SHOP_ID` (default `30001`)
