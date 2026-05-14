# make_erd 프로젝트 가이드

## 📋 프로젝트 개요

**make_erd**는 SQL 쿼리를 분석하여 사용 테이블, 테이블 간 관계를 추론하고 ERD(Entity Relationship Diagram)로 시각화하는 **Next.js 웹 애플리케이션**입니다.

### 핵심 특징
- ✅ **SQL 파일 업로드** 또는 **직접 입력**으로 분석 가능
- ✅ **FK 제약 없는 환경**에서도 명명 규칙 기반 관계 자동 추론
- ✅ **Header-Detail, Lookup, History 테이블** 자동 구분
- ✅ **Mermaid ERD** 즉시 렌더링 및 미리보기
- ✅ **MCP(Model Context Protocol)** 연동으로 메타데이터 조회 가능
- ✅ **ERD 샌드박스**: 테이블 설계 후 관계 자동 추론으로 ERD 테스트

---

## 🏗️ 프로젝트 구조

```
make_erd/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── analyze/route.ts          # 메인 분석 API 엔드포인트
│   │   │   └── mcp/health/route.ts       # MCP 연결 상태 확인
│   │   ├── page.tsx                      # 메인 홈페이지
│   │   ├── sandbox/page.tsx              # ERD 샌드박스 페이지
│   │   ├── layout.tsx                    # 전역 레이아웃
│   │   └── globals.css                   # 전역 스타일
│   │
│   ├── analyzer/
│   │   ├── analyze.ts                    # 쿼리 분석 & 관계 추론 진행
│   │   ├── relationship-heuristics.ts    # ⭐ 공유 관계 추론 규칙
│   │   └── ... (파서, 렌더러)
│   │
│   ├── components/
│   │   ├── query-workbench.tsx           # 메인 SQL 편집/분석 화면
│   │   ├── erd-sandbox-page.tsx          # 샌드박스 페이지 (테이블 설계)
│   │   ├── mermaid-preview.tsx           # ERD 미리보기 컴포넌트
│   │   └── ...
│   │
│   ├── domain/
│   │   └── types.ts                      # 핵심 타입 정의
│   │
│   ├── enricher/
│   │   ├── mcp-metadata-enricher.ts      # MCP 서버 연동
│   │   └── ...
│   │
│   ├── parser/
│   │   └── extract.ts                    # SQL 파싱 (테이블/조인 추출)
│   │
│   └── renderer/
│       ├── render-mermaid.ts             # Mermaid ERD 생성
│       └── render-report.ts              # 텍스트 리포트 생성
│
├── test/                                  # Jest 테스트
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔄 데이터 흐름

### 1️⃣ 메인 분석 흐름

```
사용자 입력 (SQL + 파일)
    ↓
[POST] /api/analyze
    ↓
formData 파싱 (sqlText, files)
    ↓
prepareQueryInputs() → 쿼리 필터링 (SELECT/WITH만)
    ↓
MetadataEnricher 선택 (MCP HTTP/stdio 또는 Noop)
    ↓
analyzeQueries()
  ├─ parseQuery() → SQL 파싱 (테이블, 조인 추출)
  ├─ collectTables() → 테이블 목록 수집
  ├─ enrichTables(MCP) → 메타데이터 조회 (선택)
  ├─ inferRelationships() ⭐ → 관계 추론
  └─ renderMermaidErd() → ERD 생성
    ↓
AnalysisResult 반환
    ↓
클라이언트 렌더링 (테이블 목록, 관계, ERD, 리포트)
```

### 2️⃣ 샌드박스 흐름

```
사용자가 테이블 정의 (이름 + PK 컬럼)
    ↓
테이블 객체 생성 → AnalyzedTable[] 변환
    ↓
inferRelationshipsFromTableMetadata() ⭐ (공유 규칙)
    ↓
renderMermaidErd()
    ↓
ERD 즉시 미리보기
```

---

## ⭐ 관계 추론 로직 상세 설명

### 핵심 파일: `src/analyzer/relationship-heuristics.ts`

이 파일은 **메인 분석기**와 **샌드박스** 모두에서 사용하는 **공유 추론 규칙**을 정의합니다.

#### 1. 기본 함수 구조

```typescript
export function inferRelationshipsFromTableMetadata(
  tables: AnalyzedTable[]
): Relationship[]
```

**입력**: `AnalyzedTable[]` (테이블명 + PK 정보)
**출력**: `Relationship[]` (추론된 관계 배열)

---

### 추론 규칙 1️⃣: 참조 테이블 패턴 인식

#### 규칙 정의

```typescript
function isLikelyReferenceTableByName(tableName: string): boolean {
  // S로 시작: SDIV, SYSCFG, SBGTCD, ...
  if (/^s[a-z0-9_]+$/i.test(normalized)) return true;
  
  // 특정 suffix 패턴
  return /(_TERM|_CFG|_CODE|_MST|_BASE)$/i.test(normalized);
}
```

#### 인식 패턴

| 패턴 | 예시 | 의미 |
|------|------|------|
| `S`로 시작 | `SDIV`, `SYSCFG`, `SBGTCD` | 코드/설정/옵션 테이블 |
| `_TERM` suffix | `COMP_TERM`, `DIV_TERM` | 용어/코드 참조 |
| `_CFG` suffix | `SYSTEM_CFG`, `APP_CFG` | 환경 설정 |
| `_CODE` suffix | `CURRENCY_CODE`, `STATUS_CODE` | 코드성 마스터 |
| `_MST` suffix | `CUSTOMER_MST`, `PRODUCT_MST` | 마스터 데이터 |
| `_BASE` suffix | `RATE_BASE`, `PRICE_BASE` | 기준 데이터 |

#### 역할

**Header-Detail 구조와의 구분**
- 참조 테이블로 인식되면 → Header-Detail 후보에서 제외
- 예: `SDIV`는 다른 테이블과 조인되어도 "설정 참조"로 처리
- 카디널리티: **many-to-one** (참조 관계)

---

### 추론 규칙 2️⃣: 컬럼명 기반 필터링

#### 관계 추론 제외

```typescript
function shouldExcludeJoinColumn(columnName: string): boolean {
  const normalized = normalizeColumnKey(columnName);
  // _YN (Y/N 플래그), _QTY (수량), _AMT (금액) → 추론 제외
  return /(_yn|_qty|_amt)$/i.test(normalized);
}
```

| 컬럼 suffix | 예시 | 이유 |
|-----------|------|------|
| `_YN` | `USE_YN`, `DEL_YN`, `ACTIVE_YN` | 불린 플래그, 구조적 키 아님 |
| `_QTY` | `ORDER_QTY`, `STOCK_QTY` | 수량/개수, 조인 의미 없음 |
| `_AMT` | `TOTAL_AMT`, `DISCOUNT_AMT` | 금액, 조인 의미 없음 |

**코드 예시**

```typescript
// ABDOCU(Header) - ABDOCU_B(Detail) 조인 시:
// JOIN ON h.DOCU_NO = d.DOCU_NO AND h.SALE_QTY = d.SALE_QTY
//                                       ↑ 이건 제외됨
// → 실제로는 DOCU_NO만으로 관계 추론
```

---

### 추론 규칙 3️⃣: 컬럼명 감점 (_CNT)

```typescript
function shouldPenalizeJoinColumn(columnName: string): boolean {
  const normalized = normalizeColumnKey(columnName);
  return /_cnt$/i.test(normalized);
}
```

| 컬럼 suffix | 예시 | 처리 |
|-----------|------|------|
| `_CNT` | `ORDER_CNT`, `LINE_CNT` | PK가 아니면 감점, PK면 허용 |

**이유**: `_CNT`는 보통 카운트/회차지만, PK로 쓰이는 경우도 있음

**코드 예시**

```typescript
if (shouldPenalizeJoinColumn(column) && !hasPrimaryKey(metadata, column)) {
  // 신뢰도 낮춤, reason에 "감점" 문구 추가
}
```

---

### 추론 규칙 4️⃣: 이력 테이블 특화

#### 이력 테이블 인식

```typescript
function isHistoryTable(tableName: string): boolean {
  const normalized = normalizeColumnKey(tableName);
  return /(_his|_log)$/i.test(normalized);
}
```

#### 인식 패턴

| 패턴 | 예시 | 의미 |
|------|------|------|
| `_HIS` suffix | `ABDOCU_HIS`, `ORDER_HIS` | 변경 이력 |
| `_LOG` suffix | `SYSTEM_LOG`, `AUDIT_LOG` | 작업 로그 |

#### Header-Detail 로직

```typescript
if (isHistoryTable(detailTableName)) {
  // 원본 테이블(ABDOCU) PK가 이력 테이블(ABDOCU_HIS) PK 앞쪽에 포함?
  // 예: 원본 PK = (CO_CD, DOCU_NO)
  //     이력 PK = (CO_CD, DOCU_NO, REG_DTM, CHG_DTM)
  //           ↑ 원본 PK 포함됨
  // → 이력은 원본의 Detail로 판정
  // → reason: "ABDOCU의 변경 이력으로 추정했습니다."
}
```

---

### 추론 규칙 5️⃣: Header-Detail 구조 (핵심)

#### 패턴 정의

```
Header:     단일 업무 단위 (주문 1건)
Detail:     Header를 포함한 PK + 라인 식별자

예시 1:
ORDER_HEADER       PK = (CO_CD, ORDER_NO)
ORDER_DETAIL       PK = (CO_CD, ORDER_NO, SEQ)  ← Header PK + 라인 식별자
               조인: ORDER_HEADER.PK ⊂ ORDER_DETAIL.PK 일부

예시 2 (복합키):
ABDOCU             PK = (CO_CD, DOCU_NO)
ABDOCU_B           PK = (CO_CD, DOCU_NO, SEQ)  ← Header PK + 라인
ABDOCU_T           PK = (CO_CD, DOCU_NO, SEQ, SUB_SEQ)  ← Header+Detail PK + 부-라인
```

#### 추론 조건 (모두 만족해야 함)

```typescript
function isHeaderDetailCandidate(
  headerMetadata, detailMetadata, joinColumns, 
  headerName, detailName
) {
  // 조건 1: 참조 테이블이 아님
  if (isLikelyReferenceTableByName(headerName)) return false;
  if (isLikelyReferenceTableByName(detailName)) return false;
  
  // 조건 2: Header의 모든 PK가 조인에 참여
  const headerPKs = headerMetadata.primaryKeys;
  const joinColumnSet = new Set(joinColumns);
  const allHeaderInJoin = headerPKs.every(pk => joinColumnSet.has(pk));
  if (!allHeaderInJoin) return false;
  
  // 조건 3: Detail의 PK 중 일부만 조인에 참여 (추가 PK 존재)
  const detailPKs = detailMetadata.primaryKeys;
  const detailJoinCount = detailPKs.filter(pk => joinColumnSet.has(pk)).length;
  if (detailJoinCount === detailPKs.length) return false;  // 전부 참여 = 1:1
  if (detailJoinCount === 0) return false;  // 전혀 참여 안함 = 관계 아님
  
  // 조건 4: Detail 추가 PK에 라인 성격 컬럼 존재
  const additionalPKs = detailPKs.filter(pk => !joinColumnSet.has(pk));
  const hasLineLike = additionalPKs.some(pk => isLineLikeColumn(pk));
  if (!hasLineLike) return false;
  
  return true;
}
```

#### 라인성 컬럼 인식

```typescript
function isLineLikeColumn(columnName: string): boolean {
  const normalized = normalizeColumnKey(columnName);
  return /(\
    ^sq$ | ^seq$ | ^ln$ |           // 약자
    ^line$ | ^line_no$ |             // 영문
    ^row_no$ |                       // 행 번호
    ^dtl$ | ^dtl_seq$ | ^dtl_sq$ |  // 상세-시퀀스
    ^detail$ | ^detail_seq$          // 상세
  )$/i.test(normalized);
}
```

| 컬럼명 | 예시 | 의미 |
|--------|------|------|
| `SQ` | `DOCU_SQ` | 일련번호 (Sequence) |
| `SEQ` | `ORDER_SEQ`, `LINE_SEQ` | 순서번호 |
| `LN` | `SALE_LN` | 라인 |
| `LINE_NO` | `ORDER_LINE_NO` | 주문 라인 번호 |
| `ROW_NO` | `DETAIL_ROW_NO` | 행 번호 |
| `DTL_SEQ` | `SALE_DTL_SEQ` | 상세 순번 |

#### 추론 결과

```
추론 관계:
- fromTable: ORDER_DETAIL
- toTable: ORDER_HEADER
- cardinality: many-to-one (Detail → Header)
- confidence: inferred
- reason: "ORDER_DETAIL의 PK 일부(CO_CD, ORDER_NO)가 ORDER_HEADER와의 조인에 
          참여하고, ORDER_DETAIL에 라인 성격 PK(SEQ)가 있어 
          Header-Detail 구조로 추정했습니다."
```

---

### 추론 규칙 6️⃣: PK 계층 및 테이블명 패턴 (Sub-Detail)

#### 복합 PK 길이 기반 계층

```
PK 길이 1~2개: Header
PK 길이 3개:   Detail (Header PK + 라인)
PK 길이 4개+:  Sub-Detail (Header PK + Detail PK + 부-라인)
```

#### 테이블명 suffix 패턴

```typescript
function detectTableTier(tableName: string, pkCount: number): Tier {
  const normalized = tableName.toLowerCase();
  
  // _B, _T suffix로 계층 힌트
  if (/^(.+?)_b$/i.test(normalized)) return 'detail';      // Detail
  if (/^(.+?)_t$/i.test(normalized)) return 'sub-detail';  // Sub-Detail
  
  // PK 개수로 추론
  if (pkCount <= 2) return 'header';
  if (pkCount === 3) return 'detail';
  return 'sub-detail';
}
```

#### 예시

| 테이블명 | PK | 계층 | 이유 |
|----------|-----|------|------|
| `ABDOCU` | (CO_CD, DOCU_NO) | Header | PK 2개, suffix 없음 |
| `ABDOCU_B` | (CO_CD, DOCU_NO, SEQ) | Detail | `_B` suffix 또는 PK 3개 |
| `ABDOCU_T` | (CO_CD, DOCU_NO, SEQ, SUB_SEQ) | Sub-Detail | `_T` suffix 또는 PK 4개+ |

---

### 추론 규칙 7️⃣: _TERM 컬럼 신호

```typescript
function hasTermLikeColumn(metadata: TableMetadata): boolean {
  return metadata.columns.some(col => 
    /(_term|_term_cd|_term_name)$/i.test(col)
  );
}
```

#### 용도

- 테이블명이 `S...` 패턴이 아니어도 컬럼명이 `_TERM`이면 lookup 테이블로 간주
- 조인 우선순위 상향: "코드/설정 참조" 신호 강화

---

### 추론 규칙 8️⃣: 기본 PK 기반 추론

HeaderDetail 규칙에 안 걸렸을 때의 폴백:

```typescript
function buildRelationship(
  leftTable, leftColumn, rightTable, rightColumn, metadata
) {
  const leftIsFK = matchesForeignKey(metadata, leftColumn, rightTable, rightColumn);
  const rightIsFK = matchesForeignKey(metadata, rightColumn, leftTable, leftColumn);
  const leftIsPK = hasPrimaryKey(metadata, leftColumn);
  const rightIsPK = hasPrimaryKey(metadata, rightColumn);
  
  // 우선 1: FK 메타데이터 (있으면 확정)
  if (leftIsFK) return many-to-one (left→right), confidence: confirmed
  if (rightIsFK) return many-to-one (right→left), confidence: confirmed
  
  // 우선 2: PK 여부
  if (rightIsPK && !leftIsPK) return many-to-one (left→right), confidence: inferred
  if (leftIsPK && !rightIsPK) return many-to-one (right→left), confidence: inferred
  if (leftIsPK && rightIsPK) return one-to-one, confidence: inferred
  
  // 우선 3: 알 수 없음
  return unknown cardinality, confidence: inferred
}
```

#### 카디널리티 판정 표

| 좌측 | 우측 | 카디널리티 | 이유 |
|------|------|-----------|------|
| PK 아님 | PK | many-to-one | 우측이 참조 대상 |
| PK | PK 아님 | many-to-one | 좌측이 참조 대상 |
| PK | PK | one-to-one | 양쪽 모두 고유키 |
| 둘 다 아님 | 둘 다 아님 | unknown | 관계 판단 불가 |

---

## 📊 추론 규칙 우선순위

```
1. FK 메타데이터 존재 → confirmed many-to-one
   ↓
2. Header-Detail 패턴 매칭
   ├─ 참조 테이블이 아님
   ├─ Header PK ⊂ Detail PK
   ├─ Detail 추가 PK에 라인 성격
   └─ → inferred many-to-one (detail→header)
   ↓
3. 이력 테이블 패턴
   ├─ _HIS / _LOG suffix
   ├─ 원본 PK가 이력 PK 앞쪽 포함
   └─ → inferred many-to-one (history→original)
   ↓
4. PK 기반 추론
   ├─ 우측이 PK & 좌측 아님 → many-to-one
   ├─ 좌측이 PK & 우측 아님 → many-to-one
   ├─ 둘 다 PK → one-to-one
   └─ 둘 다 PK 아님 → unknown
   ↓
5. 컬럼명 신호 가중치 조정
   ├─ _TERM / _CFG / _CODE 등: lookup 신호 상향
   ├─ _YN / _QTY / _AMT: 제외
   └─ _CNT: PK 아니면 감점
```

---

## 🔍 실전 예시

### 예시 1: Header-Detail 구조

```sql
SELECT *
FROM ABDOCU a
JOIN ABDOCU_B b ON a.CO_CD = b.CO_CD AND a.DOCU_NO = b.DOCU_NO
```

**테이블 정의**
- `ABDOCU` PK: `(CO_CD, DOCU_NO)`
- `ABDOCU_B` PK: `(CO_CD, DOCU_NO, SEQ)`

**추론 과정**
1. ✅ `ABDOCU` ≠ 참조 테이블
2. ✅ `ABDOCU_B` ≠ 참조 테이블 (`_B`는 참조 패턴 아님)
3. ✅ Header PK `(CO_CD, DOCU_NO)` 전부 조인에 참여
4. ✅ Detail PK 중 `(CO_CD, DOCU_NO)`는 조인 참여, `SEQ`는 미참여
5. ✅ `SEQ`는 라인 성격 (isLineLikeColumn 통과)

**결론**
```
Relationship {
  fromTable: "ABDOCU_B",
  toTable: "ABDOCU",
  fromColumn: "CO_CD, DOCU_NO",
  toColumn: "CO_CD, DOCU_NO",
  cardinality: "many-to-one",
  reason: "ABDOCU_B의 PK 일부가 ABDOCU과의 조인에 참여하고, 
           ABDOCU_B에 라인 성격 PK(SEQ)가 있어 Header-Detail 구조로 추정했습니다."
}
```

### 예시 2: Lookup/Config 구분

```sql
SELECT *
FROM ABDOCU_B b
JOIN SDIV s ON b.DIV_CD = s.DIV_CD
```

**테이블 정의**
- `ABDOCU_B` PK: `(CO_CD, DOCU_NO, SEQ)`
- `SDIV` PK: `(CO_CD, DIV_CD)`

**추론 과정**
1. ✅ `SDIV`는 `S` 접두 → 참조 테이블 (Header-Detail 후보 제외)
2. ✅ PK 체크: `SDIV.DIV_CD`는 PK, `ABDOCU_B.DIV_CD`는 PK 아님
3. → many-to-one (ABDOCU_B → SDIV)

**결론**
```
Relationship {
  fromTable: "ABDOCU_B",
  toTable: "SDIV",
  fromColumn: "DIV_CD",
  toColumn: "DIV_CD",
  cardinality: "many-to-one",
  reason: "우측 컬럼이 PK로 보여 참조 관계로 추정했습니다. (SDIV는 코드/설정 참조)"
}
```

### 예시 3: 이력 테이블

```sql
SELECT *
FROM ORDER_HEADER oh
JOIN ORDER_HEADER_HIS ohis ON oh.ORDER_NO = ohis.ORDER_NO
```

**테이블 정의**
- `ORDER_HEADER` PK: `(ORDER_NO)`
- `ORDER_HEADER_HIS` PK: `(ORDER_NO, REG_DTM, CHG_SEQ)`

**추론 과정**
1. ✅ `ORDER_HEADER_HIS` 테이블명에 `_HIS` suffix
2. ✅ 원본 PK `(ORDER_NO)` ⊂ 이력 PK 앞쪽 `(ORDER_NO, ...)`
3. → Detail로 처리

**결론**
```
Relationship {
  fromTable: "ORDER_HEADER_HIS",
  toTable: "ORDER_HEADER",
  fromColumn: "ORDER_NO",
  toColumn: "ORDER_NO",
  cardinality: "many-to-one",
  reason: "ORDER_HEADER_HIS는 ORDER_HEADER의 변경 이력으로 추정했습니다."
}
```

---

## 📝 제외되는 조인의 예시

### Case 1: _YN 필터

```sql
JOIN SDIV ON a.DIV_CD = b.DIV_CD AND a.USE_YN = b.USE_YN
--                                    ↑ 제외됨
```
- `USE_YN`은 불린 플래그 → 관계 추론 제외
- 실제 관계: `a.DIV_CD = b.DIV_CD`만 인정

### Case 2: _QTY / _AMT 필터

```sql
JOIN RATE ON a.RATE_CD = b.RATE_CD AND a.ORDER_QTY = b.BASE_QTY
--                                      ↑ 제외됨
```
- `ORDER_QTY`는 수량 → 관계 구조 아님
- 실제 관계: `a.RATE_CD = b.RATE_CD`만 인정

---

## 🎯 정확도 개선 팁

### 1️⃣ 명명 규칙 준수
- Header 테이블: 기본명 (예: `ORDER`, `ABDOCU`)
- Detail 테이블: 기본명 + `_B` / `_D` (예: `ORDER_B`, `ABDOCU_B`)
- Sub-Detail: 기본명 + `_T` (예: `ABDOCU_T`)
- 참조 테이블: `S...` 또는 `..._CODE`, `..._TERM` (예: `SDIV`, `STATUS_CODE`)

### 2️⃣ PK 설정 명확화
- 모든 테이블에 명시적 PK 정의
- 복합 PK는 의미 있는 순서로 (Header → Detail → Sub-Detail)
- 라인 식별자는 명확한 이름 (`SEQ`, `SQ`, `LN` 등)

### 3️⃣ MCP 메타데이터 활용
- 가능하면 FK 제약을 DB에 정의
- FK가 있으면 추론 신뢰도 **confirmed**로 상향
- MCP를 통해 메타데이터 조회하면 자동 반영

---

## 🚀 배포 및 실행

### 개발 환경

```bash
npm install
npm run dev
```

브라우저: `http://localhost:3000`

### 프로덕션 빌드

```bash
npm run build
npm start
```

### 환경 변수 설정

#### MCP HTTP 모드

```bash
# .env.local
MCP_URL=http://10.82.6.189/mcp/am10-dev-db
MCP_TOOL_NAME=describe_table
```

#### MCP stdio 모드

```bash
# .env.local
MCP_COMMAND=/usr/bin/python3
MCP_ARGS=-m am10_dev_db
ALLOWED_SCHEMAS=erp_1234
DB_HOST=localhost
DB_PORT=5432
DB_USER=dbuser
DB_PASSWORD=dbpass
```

---

## 📌 주요 파일 구성

### `src/analyzer/analyze.ts`

**역할**: 쿼리 분석 + 관계 추론 통합

```typescript
export async function analyzeQueries(
  inputs: QueryInput[],
  enricher: MetadataEnricher
): Promise<AnalysisResult>

function inferRelationships(
  parsedQueries: ParsedQuery[],
  metadataMap: Map<string, TableMetadata>
): Relationship[]
```

### `src/analyzer/relationship-heuristics.ts`

**역할**: 공유 추론 규칙 (메인 + 샌드박스)

```typescript
export function inferRelationshipsFromTableMetadata(
  tables: AnalyzedTable[]
): Relationship[]
```

### `src/components/erd-sandbox-page.tsx`

**역할**: ERD 테스트 페이지 (테이블 직접 설계)

```typescript
const analyzedTables = useMemo<AnalyzedTable[]>(() => {...}, [tables])
const analyzedRelationships = useMemo<Relationship[]>(() => {
  return inferRelationshipsFromTableMetadata(analyzedTables)
}, [analyzedTables])
```

---

## 🧪 샌드박스 사용법

1. 메인 페이지 우상단 **"MCP 연결 & ERD 샌드박스"** 클릭
2. `/sandbox` 페이지 진입
3. **테이블 추가** 버튼으로 테이블 설계
   - 테이블명: 예) `ABDOCU`
   - PK 컬럼: 예) `CO_CD, DOCU_NO` (쉼표 구분)
4. 즉시 **ERD 미리보기** 렌더링
5. Mermaid 원문 확인으로 디버깅

---

## 🔗 MCP 건강 상태 확인

**엔드포인트**: `/api/mcp/health` (GET)

**응답 예시** (성공)

```json
{
  "ok": true,
  "configured": true,
  "transport": "http",
  "target": "http://10.82.6.189/mcp/am10-dev-db",
  "toolCount": 5,
  "tools": ["describe_table", "find_tables", ...],
  "message": "MCP 서버 연결 성공"
}
```

**응답 예시** (네트워크 차단)

```json
{
  "ok": false,
  "configured": true,
  "message": "Streamable HTTP error: ..."
}
```

---

## ❓ 자주 묻는 질문

### Q1: 관계가 잘못 추론되는 경우?

**A**: 컬럼/테이블 명명 규칙 확인
- PK 이름이 Header/Detail에서 일치하는가?
- Detail 라인 컬럼이 `SEQ/SQ/LN` 등인가?
- 참조 테이블이 `S...` 또는 `..._CODE` 패턴인가?

### Q2: FK가 있으면 어떻게?

**A**: 자동으로 `confidence: confirmed`로 상향  
MCP를 통해 메타데이터를 조회해야 함 (`.env.local` MCP 설정)

### Q3: Lookup 테이블이 Header-Detail로 오인되는 경우?

**A**: 테이블명에 `S` 접두 또는 `_TERM/_CFG/_CODE` 추가  
예: `SBGTCD`, `RATE_TERM` 등

### Q4: 조인 컬럼이 여러 개인 경우?

**A**: 모두 Header-Detail 조건을 만족해야 함  
하나라도 조건 벗어나면 → 기본 PK 기반 추론으로 폴백

---

## 📚 참고 자료

- [Mermaid ERD 문법](https://mermaid.js.org/syntax/entityRelationshipDiagram.html)
- [Next.js API Routes](https://nextjs.org/docs/pages/building-your-application/routing/api-routes)
- [MCP 프로토콜 명세](https://modelcontextprotocol.io/)

---

**마지막 수정**: 2024년  
**작성자**: make_erd 팀
