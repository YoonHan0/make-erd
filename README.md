# make_erd

SQL을 직접 입력하거나 파일로 업로드하면, 사용 테이블과 관계를 추출해 **텍스트 리포트 + Mermaid ERD**로 보여주는 **Next.js 웹앱**입니다.

## 현재 지원 범위

- 웹 에디터에 SQL 직접 입력
- `.sql`, `.txt`, `.xml` 파일 업로드
- `FROM`, `JOIN`, `WITH` 기준 테이블 추출
- `FROM ${dbErp}.테이블A` 같은 placeholder prefix 정규화
- CTE 이름 제외
- 조인 조건 기반 관계 추론
- Mermaid ERD 렌더링
- 텍스트 리포트 출력

## 실행

```bash
npm install
npm run dev
```

기본 주소:

```text
http://localhost:3000
```

프로덕션 빌드:

```bash
npm run build
npm start
```

테스트:

```bash
npm test
```

## 웹앱 사용 방법

1. 좌측 에디터에 SQL을 붙여넣거나
2. 우측에서 SQL 파일을 업로드하거나 드래그 앤 드롭한 뒤
3. `분석 실행` 버튼을 누르면
4. 사용 테이블, 추론된 관계, Mermaid ERD, 텍스트 리포트가 화면에 표시됩니다.

직접 입력과 파일 업로드를 동시에 사용할 수도 있습니다.

에디터에는 **초기화** 버튼이 있어 직접 입력한 SQL을 바로 비울 수 있습니다.
결과 영역은 **접기/펼치기**로 정리해서 볼 수 있고, Mermaid ERD는 클릭 후 크게 볼 수 있습니다.

## 업로드 파일 내 여러 쿼리 처리 방식

- 파일 하나에 쿼리가 여러 개 있으면 **statement 단위로 분리**합니다.
- 그중 **조회 계열 쿼리만 분석**합니다.
  - 예: `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`
- `INSERT`, `UPDATE`, `DELETE`, DDL 등 **조회 이외 쿼리는 자동 제외**합니다.
- 제외된 쿼리가 있으면 화면과 리포트의 **경고 영역**에 표시합니다.

XML 파일은 우선 `<select>`, `<sql>`, `<query>`, `<statement>` 블록과 CDATA를 기준으로 SQL을 추출합니다.

## placeholder 처리 규칙

아래 형태는 테이블명 앞의 동적 prefix로 보고 제거한 뒤 실제 테이블명을 추출합니다.

- `${dbErp}.테이블A`
- `#{schema}.테이블A`
- `{{catalog}}.테이블A`
- `:schema.테이블A`

예:

```sql
SELECT *
FROM ${dbErp}.주문 o
JOIN ${dbErp}.주문상세 od ON o.id = od.orderId
```

내부 분석 기준:

```sql
SELECT *
FROM 주문 o
JOIN 주문상세 od ON o.id = od.orderId
```

## 프로젝트 구조

```text
src/
  app/
    api/analyze/route.ts
    page.tsx
  components/
  analyzer/
  domain/
  enricher/
  parser/
  renderer/
test/
```

## 구현 메모

- 현재 웹앱은 내장 분석 엔진만 사용합니다.
- 사내 MCP 연동은 `enricher` 계층 구현을 추가하는 방식으로 확장할 수 있습니다.
