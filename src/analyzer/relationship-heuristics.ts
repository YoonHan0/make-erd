import type { AnalyzedTable, Relationship } from '../domain/types';

const REFERENCE_TABLE_PREFIX = /^s[A-Za-z0-9_]+$/i;
const REFERENCE_TABLE_SUFFIX = /(_term|_cfg|_code|_mst|_base)$/i;
const HISTORY_TABLE_SUFFIX = /(_his|_log)$/i;
const TIER_B_SUFFIX = /_b$/i;
const TIER_T_SUFFIX = /_t$/i;
const LINE_LIKE_COLUMN_PATTERN = /(^|_)(sq|seq|ln|line|line_no|row_no|dtl|dtl_sq|dtl_seq|detail|detail_seq)(_|$)/i;
const EXCLUDED_RELATION_COLUMN_PATTERN = /(_yn|_qty|_amt)$/i;
const CNT_COLUMN_PATTERN = /_cnt$/i;
const TERM_COLUMN_PATTERN = /_term$/i;

export function normalizeTableKey(value: string): string {
  return value.toLowerCase();
}

export function normalizeColumnKey(value: string): string {
  return value.replace(/^["'`\[]+|["'`\]]+$/g, '').toLowerCase();
}

export function isLikelyReferenceTableByName(tableName: string): boolean {
  const normalized = normalizeTableKey(tableName).split('.').pop() ?? '';
  return REFERENCE_TABLE_PREFIX.test(normalized) || REFERENCE_TABLE_SUFFIX.test(normalized);
}

export function isHistoryTableByName(tableName: string): boolean {
  const normalized = normalizeTableKey(tableName).split('.').pop() ?? '';
  return HISTORY_TABLE_SUFFIX.test(normalized);
}

export function getHistoryBaseTableName(tableName: string): string {
  const parts = tableName.split('.');
  const base = parts.pop() ?? tableName;
  const removedSuffix = base.replace(HISTORY_TABLE_SUFFIX, '');
  return parts.length > 0 ? `${parts.join('.')}.${removedSuffix}` : removedSuffix;
}

export function isLineLikeColumn(columnName: string): boolean {
  return LINE_LIKE_COLUMN_PATTERN.test(normalizeColumnKey(columnName));
}

export function isExcludedRelationColumn(columnName: string): boolean {
  return EXCLUDED_RELATION_COLUMN_PATTERN.test(normalizeColumnKey(columnName));
}

export function isCntColumn(columnName: string): boolean {
  return CNT_COLUMN_PATTERN.test(normalizeColumnKey(columnName));
}

export function isTermColumn(columnName: string): boolean {
  return TERM_COLUMN_PATTERN.test(normalizeColumnKey(columnName));
}

export function getTableTier(tableName: string): number {
  const normalized = normalizeTableKey(tableName).split('.').pop() ?? '';
  if (TIER_T_SUFFIX.test(normalized)) {
    return 2;
  }
  if (TIER_B_SUFFIX.test(normalized)) {
    return 1;
  }
  return 0;
}

export function isPkPrefix(parentPks: string[], childPks: string[]): boolean {
  if (parentPks.length === 0 || childPks.length <= parentPks.length) {
    return false;
  }

  for (let index = 0; index < parentPks.length; index += 1) {
    if (normalizeColumnKey(parentPks[index]) !== normalizeColumnKey(childPks[index])) {
      return false;
    }
  }

  return true;
}

export function pickSharedJoinColumn(leftPks: string[], rightPks: string[]): string | null {
  const rightSet = new Set(rightPks.map(normalizeColumnKey));
  const shared = leftPks.find((pk) => rightSet.has(normalizeColumnKey(pk)));
  return shared ?? null;
}

export function inferRelationshipsFromTableMetadata(tables: AnalyzedTable[]): Relationship[] {
  const relationships: Relationship[] = [];
  const relationshipKeys = new Set<string>();

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const left = tables[i];
      const right = tables[j];

      const leftPks = left.metadata?.primaryKeys ?? [];
      const rightPks = right.metadata?.primaryKeys ?? [];
      if (leftPks.length === 0 || rightPks.length === 0) {
        continue;
      }

      if (tryAddHistoryRelationship(left, right, leftPks, rightPks, relationships, relationshipKeys)) {
        continue;
      }

      if (tryAddHistoryRelationship(right, left, rightPks, leftPks, relationships, relationshipKeys)) {
        continue;
      }

      if (tryAddHierarchyRelationship(left, right, leftPks, rightPks, relationships, relationshipKeys)) {
        continue;
      }

      if (tryAddHierarchyRelationship(right, left, rightPks, leftPks, relationships, relationshipKeys)) {
        continue;
      }

      tryAddReferenceRelationship(left, right, leftPks, rightPks, relationships, relationshipKeys);
    }
  }

  return relationships;
}

function tryAddHistoryRelationship(
  historyTable: AnalyzedTable,
  baseTable: AnalyzedTable,
  historyPks: string[],
  basePks: string[],
  relationships: Relationship[],
  relationshipKeys: Set<string>,
): boolean {
  if (!isHistoryTableByName(historyTable.fullName)) {
    return false;
  }

  if (normalizeTableKey(getHistoryBaseTableName(historyTable.fullName)) !== normalizeTableKey(baseTable.fullName)) {
    return false;
  }

  if (!isPkPrefix(basePks, historyPks)) {
    return false;
  }

  const joinColumn = basePks[0] ?? historyPks[0] ?? 'id';
  addRelationshipIfAbsent(relationships, relationshipKeys, {
    sourceName: 'sandbox',
    fromTable: historyTable.fullName,
    toTable: baseTable.fullName,
    fromColumn: joinColumn,
    toColumn: joinColumn,
    confidence: 'inferred',
    cardinality: 'many-to-one',
    reason: `${historyTable.fullName}는 이력 테이블(_HIS/_LOG)로 판단되어 ${baseTable.fullName}의 Detail로 추론했습니다.`,
  });

  return true;
}

function tryAddHierarchyRelationship(
  detailTable: AnalyzedTable,
  headerTable: AnalyzedTable,
  detailPks: string[],
  headerPks: string[],
  relationships: Relationship[],
  relationshipKeys: Set<string>,
): boolean {
  if (isLikelyReferenceTableByName(detailTable.fullName) || isLikelyReferenceTableByName(headerTable.fullName)) {
    return false;
  }

  if (!isPkPrefix(headerPks, detailPks)) {
    return false;
  }

  const extraDetailPks = detailPks.slice(headerPks.length);
  const hasLineLikePk = extraDetailPks.some(isLineLikeColumn);
  const tierBasedHierarchy = getTableTier(detailTable.fullName) > getTableTier(headerTable.fullName);

  if (!hasLineLikePk && !tierBasedHierarchy) {
    return false;
  }

  const joinColumn = headerPks[0] ?? detailPks[0] ?? 'id';
  addRelationshipIfAbsent(relationships, relationshipKeys, {
    sourceName: 'sandbox',
    fromTable: detailTable.fullName,
    toTable: headerTable.fullName,
    fromColumn: joinColumn,
    toColumn: joinColumn,
    confidence: 'inferred',
    cardinality: 'many-to-one',
    reason: hasLineLikePk
      ? `${detailTable.fullName}의 추가 PK에 라인 성격(SQ/SEQ/LN 등)이 있어 Header-Detail 구조로 추론했습니다.`
      : `${detailTable.fullName}의 PK prefix와 테이블 접미사(_B/_T) 규칙으로 계층형 Detail 구조를 추론했습니다.`,
  });

  return true;
}

function tryAddReferenceRelationship(
  leftTable: AnalyzedTable,
  rightTable: AnalyzedTable,
  leftPks: string[],
  rightPks: string[],
  relationships: Relationship[],
  relationshipKeys: Set<string>,
): void {
  const leftIsReference = isLikelyReferenceTableByName(leftTable.fullName);
  const rightIsReference = isLikelyReferenceTableByName(rightTable.fullName);

  const joinColumn = pickSharedJoinColumn(leftPks, rightPks);
  if (!joinColumn) {
    return;
  }

  const termSignal = isTermColumn(joinColumn);
  if (leftIsReference === rightIsReference && !termSignal) {
    return;
  }

  if (isExcludedRelationColumn(joinColumn)) {
    return;
  }

  const cntPenalty = isCntColumn(joinColumn);

  if (rightIsReference || (termSignal && rightPks.length <= leftPks.length)) {
    addRelationshipIfAbsent(relationships, relationshipKeys, {
      sourceName: 'sandbox',
      fromTable: leftTable.fullName,
      toTable: rightTable.fullName,
      fromColumn: joinColumn,
      toColumn: joinColumn,
      confidence: 'inferred',
      cardinality: 'many-to-one',
      reason: cntPenalty
        ? `${joinColumn}는 _CNT 컬럼이라 신뢰도를 낮추었지만 예외적으로 참조 관계를 허용했습니다.`
        : termSignal
          ? `${joinColumn}의 _TERM 접미사를 코드/설정 참조 신호로 판단해 N:1 관계를 추론했습니다.`
          : `${rightTable.fullName}는 코드/설정 참조 테이블 패턴(S 접두 또는 _TERM/_CFG/_CODE 등)으로 추론했습니다.`,
    });
    return;
  }

  addRelationshipIfAbsent(relationships, relationshipKeys, {
    sourceName: 'sandbox',
    fromTable: rightTable.fullName,
    toTable: leftTable.fullName,
    fromColumn: joinColumn,
    toColumn: joinColumn,
    confidence: 'inferred',
    cardinality: 'many-to-one',
    reason: cntPenalty
      ? `${joinColumn}는 _CNT 컬럼이라 신뢰도를 낮추었지만 예외적으로 참조 관계를 허용했습니다.`
      : termSignal
        ? `${joinColumn}의 _TERM 접미사를 코드/설정 참조 신호로 판단해 N:1 관계를 추론했습니다.`
        : `${leftTable.fullName}는 코드/설정 참조 테이블 패턴(S 접두 또는 _TERM/_CFG/_CODE 등)으로 추론했습니다.`,
  });
}

function addRelationshipIfAbsent(
  relationships: Relationship[],
  relationshipKeys: Set<string>,
  relationship: Relationship,
): void {
  const key = [relationship.fromTable, relationship.toTable, relationship.fromColumn, relationship.toColumn].join('|');
  if (relationshipKeys.has(key)) {
    return;
  }

  relationshipKeys.add(key);
  relationships.push(relationship);
}
