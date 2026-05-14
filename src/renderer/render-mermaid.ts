import { AnalyzedTable, Relationship } from '../domain/types';

export function renderMermaidErd(tables: AnalyzedTable[], relationships: Relationship[]): string {
  const entityNames = createEntityNameMap(tables);
  const lines = ['erDiagram'];

  for (const table of tables) {
    const entityName = entityNames.get(table.fullName) ?? table.fullName;
    lines.push(`  ${entityName} {`);

    const primaryKeys = table.metadata?.primaryKeys ?? [];
    if (primaryKeys.length > 0) {
      for (const primaryKey of primaryKeys.slice(0, 4)) {
        lines.push(`    string ${sanitizeFieldName(primaryKey)} PK`);
      }

      if (primaryKeys.length >= 5) {
        lines.push('    string __truncated_pk_fields');
      }
    } else {
      lines.push('    string __metadata_pending');
    }

    lines.push('  }');
  }

  const selectedRelationships = selectRelationshipPerPair(relationships);

  for (const relationship of selectedRelationships) {
    const fromEntity = entityNames.get(relationship.fromTable) ?? relationship.fromTable;
    const toEntity = entityNames.get(relationship.toTable) ?? relationship.toTable;

    if (relationship.cardinality === 'many-to-one') {
      lines.push(
        `  ${toEntity} ||--o{ ${fromEntity} : "${relationship.toColumn} -> ${relationship.fromColumn} (${relationship.confidence})"`,
      );
      continue;
    }

    if (relationship.cardinality === 'one-to-one') {
      lines.push(
        `  ${fromEntity} ||--|| ${toEntity} : "${relationship.fromColumn} = ${relationship.toColumn} (${relationship.confidence})"`,
      );
      continue;
    }

    lines.push(
      `  ${fromEntity} }o--o{ ${toEntity} : "${relationship.fromColumn} = ${relationship.toColumn} (${relationship.confidence})"`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function selectRelationshipPerPair(relationships: Relationship[]): Relationship[] {
  const selectedByPair = new Map<string, Relationship>();
  const selectedOrder: string[] = [];

  for (const relationship of relationships) {
    const pairKey = getUnorderedPairKey(relationship.fromTable, relationship.toTable);
    const selected = selectedByPair.get(pairKey);

    if (!selected) {
      selectedByPair.set(pairKey, relationship);
      selectedOrder.push(pairKey);
      continue;
    }

    if (isHigherPriority(relationship, selected)) {
      selectedByPair.set(pairKey, relationship);
    }
  }

  return selectedOrder
    .map((pairKey) => selectedByPair.get(pairKey))
    .filter((relationship): relationship is Relationship => relationship !== undefined);
}

function getUnorderedPairKey(leftTable: string, rightTable: string): string {
  return [leftTable, rightTable].sort((a, b) => a.localeCompare(b)).join('::');
}

function isHigherPriority(candidate: Relationship, current: Relationship): boolean {
  const candidateConfidencePriority = getConfidencePriority(candidate.confidence);
  const currentConfidencePriority = getConfidencePriority(current.confidence);
  if (candidateConfidencePriority !== currentConfidencePriority) {
    return candidateConfidencePriority > currentConfidencePriority;
  }

  const candidateCardinalityPriority = getCardinalityPriority(candidate.cardinality);
  const currentCardinalityPriority = getCardinalityPriority(current.cardinality);
  if (candidateCardinalityPriority !== currentCardinalityPriority) {
    return candidateCardinalityPriority > currentCardinalityPriority;
  }

  return false;
}

function getConfidencePriority(confidence: Relationship['confidence']): number {
  if (confidence === 'confirmed') {
    return 1;
  }
  return 0;
}

function getCardinalityPriority(cardinality: Relationship['cardinality']): number {
  if (cardinality === 'many-to-one') {
    return 2;
  }
  if (cardinality === 'one-to-one') {
    return 1;
  }
  return 0;
}

function createEntityNameMap(tables: AnalyzedTable[]): Map<string, string> {
  const usedNames = new Set<string>();
  const entityNames = new Map<string, string>();

  for (const table of tables) {
    let entityName = table.fullName.replace(/[^\p{L}\p{N}_]+/gu, '_');
    if (!entityName) {
      entityName = 'TABLE';
    }

    let suffix = 1;
    let candidate = entityName;
    while (usedNames.has(candidate)) {
      suffix += 1;
      candidate = `${entityName}_${suffix}`;
    }

    usedNames.add(candidate);
    entityNames.set(table.fullName, candidate);
  }

  return entityNames;
}

function sanitizeFieldName(column: string): string {
  return column.replace(/[^\p{L}\p{N}_]+/gu, '_');
}

