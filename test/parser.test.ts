import { analyzeQueries } from '../src/analyzer/analyze';
import { parseQuery } from '../src/parser/extract';
import { renderMermaidErd } from '../src/renderer/render-mermaid';
import { JsonMetadataEnricher } from '../src/enricher/json-metadata-enricher';
import { mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

describe('placeholder-aware SQL parsing', () => {
  it('extracts tables when placeholder prefixes appear before the table name', () => {
    const parsed = parseQuery({
      name: 'inline-1',
      sql: `
        SELECT *
        FROM \${dbErp}.테이블A a
        JOIN \${dbErp}.테이블B b ON a.id = b.tableAId
      `,
    });

    expect(parsed.tableReferences.map((reference) => reference.fullName)).toEqual(['테이블A', '테이블B']);
    expect(parsed.joinConditions).toEqual([
      {
        sourceName: 'inline-1',
        leftAlias: 'a',
        leftColumn: 'id',
        rightAlias: 'b',
        rightColumn: 'tableAId',
        rawExpression: 'a.id = b.tableAId',
      },
    ]);
  });

  it.each(['${dbErp}', '${db_erp}', '${DBERP}', '${DB_ERP}', '#{schema}', '#{SCHEMA_NAME}'])(
    'normalizes placeholder prefix variant %s before extracting tables',
    (placeholderPrefix) => {
      const parsed = parseQuery({
        name: `variant-${placeholderPrefix}`,
        sql: `
          SELECT *
          FROM ${placeholderPrefix}.테이블A a
          JOIN ${placeholderPrefix}.테이블B b ON a.id = b.tableAId
        `,
      });

      expect(parsed.tableReferences.map((reference) => reference.fullName)).toEqual(['테이블A', '테이블B']);
      expect(parsed.joinConditions).toEqual([
        {
          sourceName: `variant-${placeholderPrefix}`,
          leftAlias: 'a',
          leftColumn: 'id',
          rightAlias: 'b',
          rightColumn: 'tableAId',
          rawExpression: 'a.id = b.tableAId',
        },
      ]);
    },
  );

  it('excludes cte names from the table list', () => {
    const parsed = parseQuery({
      name: 'inline-2',
      sql: `
        WITH recent_orders AS (
          SELECT *
          FROM \${dbErp}.주문 o
        )
        SELECT *
        FROM recent_orders ro
        JOIN \${dbErp}.주문상세 od ON ro.id = od.orderId
      `,
    });

    expect(parsed.tableReferences.map((reference) => reference.fullName)).toEqual(['주문', '주문상세']);
  });

  it('extracts tables from nested subqueries inside FROM clause', () => {
    const parsed = parseQuery({
      name: 'inline-nested',
      sql: `
        SELECT *
        FROM (
          SELECT a.id
          FROM \${dbErp}.내부테이블A a
          JOIN \${dbErp}.내부테이블B b ON a.id = b.aId
        ) sub
        JOIN \${dbErp}.외부테이블 c ON sub.id = c.id
      `,
    });

    expect(parsed.tableReferences.map((reference) => reference.fullName)).toEqual([
      '__subquery__',
      '내부테이블A',
      '내부테이블B',
      '외부테이블',
    ]);
  });
});

describe('analysis and rendering', () => {
  const tempDir = path.join(os.tmpdir(), 'make-erd-tests');
  const metadataPath = path.join(tempDir, 'metadata.json');

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses metadata to confirm FK relationships and renders mermaid', async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({
        주문: {
          columns: ['id', 'customerId'],
          primaryKeys: ['id'],
          foreignKeys: [],
        },
        주문상세: {
          columns: ['id', 'orderId'],
          primaryKeys: ['id'],
          foreignKeys: [
            {
              column: 'orderId',
              referencesTable: '주문',
              referencesColumn: 'id',
            },
          ],
        },
      }),
      'utf8',
    );

    const result = await analyzeQueries(
      [
        {
          name: 'inline-3',
          sql: `
            SELECT *
            FROM \${dbErp}.주문 o
            JOIN \${dbErp}.주문상세 od ON o.id = od.orderId
          `,
        },
      ],
      await JsonMetadataEnricher.fromFile(metadataPath),
    );

    expect(result.relationships).toEqual([
      {
        sourceName: 'inline-3',
        fromTable: '주문상세',
        toTable: '주문',
        fromColumn: 'orderId',
        toColumn: 'id',
        confidence: 'confirmed',
        cardinality: 'many-to-one',
        reason: '메타데이터의 FK 정의와 조인 조건이 일치합니다.',
      },
    ]);

    expect(renderMermaidErd(result.tables, result.relationships)).toContain('주문 ||--o{ 주문상세');
  });

  it('renders only PK columns with truncation and keeps metadata pending fallback when PK is missing', () => {
    const mermaid = renderMermaidErd(
      [
        {
          fullName: '복합키테이블',
          tableName: '복합키테이블',
          aliases: [],
          sources: [],
          metadata: {
            fullName: '복합키테이블',
            tableName: '복합키테이블',
            columns: ['pk1', 'pk2', 'pk3', 'pk4', 'pk5', 'nonPkColumn'],
            primaryKeys: ['pk1', 'pk2', 'pk3', 'pk4', 'pk5'],
            indexes: [],
            foreignKeys: [],
          },
        },
        {
          fullName: '메타없음테이블',
          tableName: '메타없음테이블',
          aliases: [],
          sources: [],
        },
      ],
      [],
    );

    expect(mermaid).toContain('string pk1 PK');
    expect(mermaid).toContain('string pk2 PK');
    expect(mermaid).toContain('string pk3 PK');
    expect(mermaid).toContain('string pk4 PK');
    expect(mermaid).toContain('string __truncated_pk_fields');
    expect(mermaid).not.toContain('string pk5 PK');
    expect(mermaid).not.toContain('string nonPkColumn');
    expect(mermaid).toContain('string __metadata_pending');
  });

  it('renders only one relationship per unordered table pair using priority', () => {
    const mermaid = renderMermaidErd(
      [
        {
          fullName: 'A',
          tableName: 'A',
          aliases: [],
          sources: [],
        },
        {
          fullName: 'B',
          tableName: 'B',
          aliases: [],
          sources: [],
        },
      ],
      [
        {
          sourceName: 's1',
          fromTable: 'A',
          toTable: 'B',
          fromColumn: 'a1',
          toColumn: 'b1',
          confidence: 'inferred',
          cardinality: 'unknown',
          reason: 'first',
        },
        {
          sourceName: 's2',
          fromTable: 'B',
          toTable: 'A',
          fromColumn: 'b2',
          toColumn: 'a2',
          confidence: 'confirmed',
          cardinality: 'one-to-one',
          reason: 'better confidence',
        },
        {
          sourceName: 's3',
          fromTable: 'A',
          toTable: 'B',
          fromColumn: 'a3',
          toColumn: 'b3',
          confidence: 'confirmed',
          cardinality: 'many-to-one',
          reason: 'best cardinality',
        },
        {
          sourceName: 's4',
          fromTable: 'B',
          toTable: 'A',
          fromColumn: 'b4',
          toColumn: 'a4',
          confidence: 'confirmed',
          cardinality: 'many-to-one',
          reason: 'same priority should lose by occurrence order',
        },
      ],
    );

    expect((mermaid.match(/\|\|--o\{/g) ?? []).length).toBe(1);
    expect(mermaid).toContain('B ||--o{ A : "b3 -> a3 (confirmed)"');
    expect(mermaid).not.toContain('b4 -> a4 (confirmed)');
  });
});
