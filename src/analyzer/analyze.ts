import {
  AcceptedQuerySource,
  AnalysisResult,
  AnalyzedTable,
  JoinCondition,
  ParsedQuery,
  QueryInput,
  Relationship,
  TableLookup,
  TableMetadata,
} from '../domain/types';
import { MetadataEnricher } from '../enricher/metadata-enricher';
import { parseQuery } from '../parser/extract';
import { renderMermaidErd } from '../renderer/render-mermaid';
import { renderTextReport } from '../renderer/render-report';
import {
  getHistoryBaseTableName,
  getTableTier,
  isCntColumn,
  isExcludedRelationColumn,
  isHistoryTableByName,
  isLikelyReferenceTableByName,
  isLineLikeColumn,
  isPkPrefix,
  isTermColumn,
  normalizeColumnKey,
  normalizeTableKey,
} from './relationship-heuristics';

interface AnalyzeQueriesOptions {
  extraWarnings?: string[];
}

export async function analyzeQueries(
  inputs: QueryInput[],
  enricher: MetadataEnricher,
  options?: AnalyzeQueriesOptions,
): Promise<AnalysisResult> {
  const parsedQueries = inputs.map(parseQuery);
  const acceptedQuerySources = collectAcceptedQuerySources(inputs);
  const tables = collectTables(parsedQueries);
  const metadataMap = await enricher.enrichTables(tables);
  const enrichedTables = tables.map((table) => ({
    ...table,
    metadata: metadataMap.get(table.fullName),
  }));
  const relationships = inferRelationships(parsedQueries, metadataMap);
  const warnings = collectWarnings(parsedQueries, enrichedTables, options?.extraWarnings ?? []);
  const mermaid = renderMermaidErd(enrichedTables, relationships);
  const report = renderTextReport(enrichedTables, relationships, warnings);

  return {
    parsedQueries,
    acceptedQuerySources,
    tables: enrichedTables,
    relationships,
    warnings,
    mermaid,
    report,
  };
}

function collectAcceptedQuerySources(inputs: QueryInput[]): AcceptedQuerySource[] {
  return inputs.map((input) => ({
    sourceName: input.name,
    documentName: input.metadata?.documentName ?? input.name,
    sourceLabel: input.metadata?.sourceLabel ?? input.name,
    format: input.metadata?.format ?? 'sql',
    queryId: input.metadata?.queryId,
    tagName: input.metadata?.tagName,
  }));
}

function collectTables(parsedQueries: ParsedQuery[]): AnalyzedTable[] {
  const tableMap = new Map<string, AnalyzedTable>();

  for (const parsedQuery of parsedQueries) {
    for (const reference of parsedQuery.tableReferences) {
      if (reference.fullName === '__subquery__') {
        continue;
      }

      const existing = tableMap.get(reference.fullName);
      if (existing) {
        if (reference.alias && !existing.aliases.includes(reference.alias)) {
          existing.aliases.push(reference.alias);
        }
        if (!existing.sources.includes(reference.sourceName)) {
          existing.sources.push(reference.sourceName);
        }
        continue;
      }

      tableMap.set(reference.fullName, {
        fullName: reference.fullName,
        tableName: reference.tableName,
        schemaName: reference.schemaName,
        aliases: reference.alias ? [reference.alias] : [],
        sources: [reference.sourceName],
      });
    }
  }

  return [...tableMap.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function inferRelationships(parsedQueries: ParsedQuery[], metadataMap: Map<string, TableMetadata>): Relationship[] {
  const relationships = new Map<string, Relationship>();

  for (const parsedQuery of parsedQueries) {
    const aliasMap = buildAliasMap(parsedQuery);
    const groupedConditions = groupConditionsByTablePair(parsedQuery.joinConditions, aliasMap);

    for (const [pairKey, conditions] of groupedConditions.entries()) {
      const [leftTable, rightTable] = pairKey.split('|');
      
      // Header-Detail 패턴 검사 (FK 없을 때)
      const headerDetailRelationship = detectHeaderDetailPattern(
        parsedQuery.sourceName,
        leftTable,
        rightTable,
        conditions,
        metadataMap,
      );

      if (headerDetailRelationship) {
        const key = [
          headerDetailRelationship.fromTable,
          headerDetailRelationship.fromColumn,
          headerDetailRelationship.toTable,
          headerDetailRelationship.toColumn,
        ].join('|');
        if (!relationships.has(key)) {
          relationships.set(key, headerDetailRelationship);
        }
        continue;
      }

      // 기존 단건 관계 판단
      for (const condition of conditions) {
        const relationship = buildRelationship(
          condition.sourceName,
          leftTable,
          condition.leftColumn,
          rightTable,
          condition.rightColumn,
          metadataMap,
        );

        if (!relationship) {
          continue;
        }

        const key = [
          relationship.fromTable,
          relationship.fromColumn,
          relationship.toTable,
          relationship.toColumn,
        ].join('|');

        if (!relationships.has(key)) {
          relationships.set(key, relationship);
        }
      }
    }
  }

  return [...relationships.values()];
}

function groupConditionsByTablePair(
  conditions: JoinCondition[],
  aliasMap: Map<string, string>,
): Map<string, JoinCondition[]> {
  const grouped = new Map<string, JoinCondition[]>();

  for (const condition of conditions) {
    const leftTable = aliasMap.get(condition.leftAlias.toLowerCase());
    const rightTable = aliasMap.get(condition.rightAlias.toLowerCase());

    if (!leftTable || !rightTable || leftTable === rightTable) {
      continue;
    }

    const pairKey = [leftTable, rightTable].sort().join('|');
    if (!grouped.has(pairKey)) {
      grouped.set(pairKey, []);
    }
    grouped.get(pairKey)!.push(condition);
  }

  return grouped;
}

function detectHeaderDetailPattern(
  sourceName: string,
  leftTable: string,
  rightTable: string,
  conditions: JoinCondition[],
  metadataMap: Map<string, TableMetadata>,
): Relationship | null {
  const leftMetadata = metadataMap.get(leftTable);
  const rightMetadata = metadataMap.get(rightTable);

  if (!leftMetadata || !rightMetadata || leftMetadata.primaryKeys.length === 0 || rightMetadata.primaryKeys.length === 0) {
    return null;
  }

  // 이력 테이블(_HIS/_LOG) 특화 규칙: 원본 PK prefix가 이력 PK 앞쪽에 포함되면 Detail로 판정
  if (
    isHistoryTableByName(leftTable) &&
    normalizeTableKey(getHistoryBaseTableName(leftTable)) === normalizeTableKey(rightTable) &&
    isPkPrefix(rightMetadata.primaryKeys, leftMetadata.primaryKeys)
  ) {
    const joinColumn = rightMetadata.primaryKeys[0] ?? leftMetadata.primaryKeys[0] ?? conditions[0].rightColumn;
    return {
      sourceName,
      fromTable: leftTable,
      toTable: rightTable,
      fromColumn: joinColumn,
      toColumn: joinColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: `${leftTable}는 이력 테이블(_HIS/_LOG)이며 원본 PK prefix를 포함해 ${rightTable}의 Detail로 추정했습니다.`,
    };
  }

  if (
    isHistoryTableByName(rightTable) &&
    normalizeTableKey(getHistoryBaseTableName(rightTable)) === normalizeTableKey(leftTable) &&
    isPkPrefix(leftMetadata.primaryKeys, rightMetadata.primaryKeys)
  ) {
    const joinColumn = leftMetadata.primaryKeys[0] ?? rightMetadata.primaryKeys[0] ?? conditions[0].leftColumn;
    return {
      sourceName,
      fromTable: rightTable,
      toTable: leftTable,
      fromColumn: joinColumn,
      toColumn: joinColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: `${rightTable}는 이력 테이블(_HIS/_LOG)이며 원본 PK prefix를 포함해 ${leftTable}의 Detail로 추정했습니다.`,
    };
  }

  const joinColumnSet = new Set(
    conditions
      .filter((c) => !isExcludedRelationColumn(c.leftColumn) && !isExcludedRelationColumn(c.rightColumn))
      .flatMap((c) => [normalizeColumnKey(c.leftColumn), normalizeColumnKey(c.rightColumn)]),
  );

  if (joinColumnSet.size === 0) {
    return null;
  }

  // 좌측이 Header, 우측이 Detail인 경우
  if (isHeaderDetailCandidate(leftMetadata, rightMetadata, joinColumnSet, leftTable, rightTable)) {
    return {
      sourceName,
      fromTable: rightTable,
      toTable: leftTable,
      fromColumn: conditions[0].rightColumn,
      toColumn: conditions[0].leftColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: `${rightTable}의 PK 일부가 ${leftTable}과의 조인에 참여하고, ${rightTable}에 라인 성격 PK(SQ/SEQ/LN 등)가 있어 Header-Detail 구조로 추정했습니다.`,
    };
  }

  // 우측이 Header, 좌측이 Detail인 경우
  if (isHeaderDetailCandidate(rightMetadata, leftMetadata, joinColumnSet, rightTable, leftTable)) {
    return {
      sourceName,
      fromTable: leftTable,
      toTable: rightTable,
      fromColumn: conditions[0].leftColumn,
      toColumn: conditions[0].rightColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: `${leftTable}의 PK 일부가 ${rightTable}과의 조인에 참여하고, ${leftTable}에 라인 성격 PK(SQ/SEQ/LN 등)가 있어 Header-Detail 구조로 추정했습니다.`,
    };
  }

  return null;
}

function isHeaderDetailCandidate(
  headerCandidate: TableMetadata,
  detailCandidate: TableMetadata,
  joinColumnSet: Set<string>,
  headerTableName: string,
  detailTableName: string,
): boolean {
  // S 접두 테이블은 코드/설정 참조 테이블일 가능성이 높아 Header-Detail 후보에서 제외
  if (isLikelyReferenceTableByName(headerTableName) || isLikelyReferenceTableByName(detailTableName)) {
    return false;
  }

  const normalizedHeaderPks = headerCandidate.primaryKeys.map(normalizeColumnKey);
  const normalizedDetailPks = detailCandidate.primaryKeys.map(normalizeColumnKey);

  // 복합 PK prefix 순서가 맞는 경우를 Header-Detail 후보로 간주
  if (!isPkPrefix(normalizedHeaderPks, normalizedDetailPks)) {
    return false;
  }

  // Header의 모든 PK가 조인에 참여했는가
  const allHeaderPksInJoin = normalizedHeaderPks.every((pk) => joinColumnSet.has(pk));
  if (!allHeaderPksInJoin) {
    return false;
  }

  // Detail의 조인 참여 PK 개수 < Detail의 전체 PK 개수 (즉, Detail에 추가 PK가 있는가)
  const detailJoinPkCount = normalizedDetailPks.filter((pk) => joinColumnSet.has(pk)).length;
  if (detailJoinPkCount === 0 || detailJoinPkCount >= normalizedDetailPks.length) {
    return false;
  }

  // 조인에 참여하지 않는 Detail PK 중 라인 성격 컬럼(SQ/SEQ/LN 등)이 있어야 Header-Detail로 본다.
  const nonJoinDetailPks = normalizedDetailPks.filter((pk) => !joinColumnSet.has(pk));
  const hasLineLikePk = nonJoinDetailPks.some(isLineLikeColumn);
  const tierBasedHierarchy = getTableTier(detailTableName) > getTableTier(headerTableName);
  if (!hasLineLikePk && !tierBasedHierarchy) {
    return false;
  }

  return true;
}

function buildAliasMap(parsedQuery: ParsedQuery): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const reference of parsedQuery.tableReferences) {
    aliasMap.set(reference.tableName.toLowerCase(), reference.fullName);
    aliasMap.set(reference.fullName.toLowerCase(), reference.fullName);

    if (reference.alias) {
      aliasMap.set(reference.alias.toLowerCase(), reference.fullName);
    }
  }

  return aliasMap;
}

function buildRelationship(
  sourceName: string,
  leftTable: string,
  leftColumn: string,
  rightTable: string,
  rightColumn: string,
  metadataMap: Map<string, TableMetadata>,
): Relationship | null {
  const leftMetadata = metadataMap.get(leftTable);
  const rightMetadata = metadataMap.get(rightTable);
  const leftIsPrimaryKey = hasPrimaryKey(leftMetadata, leftColumn);
  const rightIsPrimaryKey = hasPrimaryKey(rightMetadata, rightColumn);

  // _YN, _QTY, _AMT는 관계 추론에서 제외
  if (isExcludedRelationColumn(leftColumn) || isExcludedRelationColumn(rightColumn)) {
    return null;
  }

  // _CNT는 감점 규칙: 둘 다 PK가 아니면 제외, PK면 예외 허용
  const hasCntSignal = isCntColumn(leftColumn) || isCntColumn(rightColumn);
  if (hasCntSignal && !leftIsPrimaryKey && !rightIsPrimaryKey) {
    return null;
  }

  // _TERM 접미사 컬럼은 코드/설정 참조(N:1) 신호로 우선 적용
  if (isTermColumn(leftColumn) || isTermColumn(rightColumn)) {
    const rightIsReference = isLikelyReferenceTableByName(rightTable);
    const leftIsReference = isLikelyReferenceTableByName(leftTable);

    if (rightIsReference && !leftIsReference) {
      return {
        sourceName,
        fromTable: leftTable,
        toTable: rightTable,
        fromColumn: leftColumn,
        toColumn: rightColumn,
        confidence: 'inferred',
        cardinality: 'many-to-one',
        reason: '_TERM 접미사 컬럼을 코드/설정 참조 신호로 판단해 N:1 관계로 추정했습니다.',
      };
    }

    if (leftIsReference && !rightIsReference) {
      return {
        sourceName,
        fromTable: rightTable,
        toTable: leftTable,
        fromColumn: rightColumn,
        toColumn: leftColumn,
        confidence: 'inferred',
        cardinality: 'many-to-one',
        reason: '_TERM 접미사 컬럼을 코드/설정 참조 신호로 판단해 N:1 관계로 추정했습니다.',
      };
    }
  }

  if (matchesForeignKey(leftMetadata, leftColumn, rightTable, rightColumn)) {
    return {
      sourceName,
      fromTable: leftTable,
      toTable: rightTable,
      fromColumn: leftColumn,
      toColumn: rightColumn,
      confidence: 'confirmed',
      cardinality: 'many-to-one',
      reason: withCntPenalty('메타데이터의 FK 정의와 조인 조건이 일치합니다.', hasCntSignal),
    };
  }

  if (matchesForeignKey(rightMetadata, rightColumn, leftTable, leftColumn)) {
    return {
      sourceName,
      fromTable: rightTable,
      toTable: leftTable,
      fromColumn: rightColumn,
      toColumn: leftColumn,
      confidence: 'confirmed',
      cardinality: 'many-to-one',
      reason: withCntPenalty('메타데이터의 FK 정의와 조인 조건이 일치합니다.', hasCntSignal),
    };
  }

  if (rightIsPrimaryKey && !leftIsPrimaryKey) {
    return {
      sourceName,
      fromTable: leftTable,
      toTable: rightTable,
      fromColumn: leftColumn,
      toColumn: rightColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: withCntPenalty('우측 컬럼이 PK로 보여 참조 관계로 추정했습니다.', hasCntSignal),
    };
  }

  if (leftIsPrimaryKey && !rightIsPrimaryKey) {
    return {
      sourceName,
      fromTable: rightTable,
      toTable: leftTable,
      fromColumn: rightColumn,
      toColumn: leftColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: withCntPenalty('좌측 컬럼이 PK로 보여 참조 관계로 추정했습니다.', hasCntSignal),
    };
  }

  if (leftIsPrimaryKey && rightIsPrimaryKey) {
    return {
      sourceName,
      fromTable: leftTable,
      toTable: rightTable,
      fromColumn: leftColumn,
      toColumn: rightColumn,
      confidence: 'inferred',
      cardinality: 'one-to-one',
      reason: withCntPenalty('양쪽 컬럼이 모두 PK로 보여 1:1 관계로 추정했습니다.', hasCntSignal),
    };
  }

  return {
    sourceName,
    fromTable: leftTable,
    toTable: rightTable,
    fromColumn: leftColumn,
    toColumn: rightColumn,
    confidence: 'inferred',
    cardinality: 'unknown',
    reason: withCntPenalty('조인 조건만 기반으로 관계를 추정했습니다.', hasCntSignal),
  };
}

function withCntPenalty(reason: string, hasCntSignal: boolean): string {
  if (!hasCntSignal) {
    return reason;
  }

  return `${reason} (_CNT 컬럼이 포함되어 신뢰도를 낮췄습니다.)`;
}

function matchesForeignKey(
  metadata: TableMetadata | undefined,
  column: string,
  referencesTable: string,
  referencesColumn: string,
): boolean {
  if (!metadata) {
    return false;
  }

  return metadata.foreignKeys.some(
    (foreignKey) =>
      normalizeColumnKey(foreignKey.column) === normalizeColumnKey(column) &&
      normalizeTableKey(foreignKey.referencesTable) === normalizeTableKey(referencesTable) &&
      normalizeColumnKey(foreignKey.referencesColumn) === normalizeColumnKey(referencesColumn),
  );
}

function hasPrimaryKey(metadata: TableMetadata | undefined, column: string): boolean {
  if (!metadata) {
    return false;
  }

  const target = normalizeColumnKey(column);
  return metadata.primaryKeys.some((primaryKey) => normalizeColumnKey(primaryKey) === target);
}

function collectWarnings(parsedQueries: ParsedQuery[], tables: AnalyzedTable[], extraWarnings: string[]): string[] {
  const warnings = [...extraWarnings, ...parsedQueries.flatMap((query) => query.warnings)];

  for (const table of tables) {
    if (!table.metadata || table.metadata.columns.length === 0) {
      warnings.push(`${table.fullName} 메타데이터가 비어 있어 관계 신뢰도가 낮을 수 있습니다.`);
    }
  }

  return [...new Set(warnings)];
}

