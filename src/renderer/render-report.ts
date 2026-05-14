import { AnalyzedTable, Relationship } from '../domain/types';

export function renderTextReport(tables: AnalyzedTable[], relationships: Relationship[], warnings: string[]): string {
  const lines: string[] = [];

  lines.push('# SQL 분석 리포트');
  lines.push('');
  lines.push(`- 사용 테이블 수: ${tables.length}`);
  lines.push(`- 추론된 관계 수: ${relationships.length}`);
  lines.push('');
  lines.push('## 사용 테이블');

  for (const table of tables) {
    lines.push(`- ${table.fullName}`);
    if (table.aliases.length > 0) {
      lines.push(`  - 별칭: ${table.aliases.join(', ')}`);
    }
    lines.push(`  - 출처: ${table.sources.join(', ')}`);
    lines.push(`  - PK: ${table.metadata?.primaryKeys.join(', ') || '(없음)'}`);
    lines.push(`  - 컬럼 수: ${table.metadata?.columns.length ?? 0}`);
  }

  lines.push('');
  lines.push('## 관계');

  if (relationships.length === 0) {
    lines.push('- 추론된 관계가 없습니다.');
  } else {
    for (const relationship of relationships) {
      lines.push(
        `- ${relationship.fromTable}.${relationship.fromColumn} -> ${relationship.toTable}.${relationship.toColumn} ` +
          `(${relationship.cardinality}, ${relationship.confidence})`,
      );
      lines.push(`  - 근거: ${relationship.reason}`);
      lines.push(`  - 출처: ${relationship.sourceName}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('## 경고');
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

