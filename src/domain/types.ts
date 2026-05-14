export interface QueryInputMetadata {
  documentName: string;
  sourceLabel: string;
  format: 'sql' | 'xml';
  queryId?: string;
  tagName?: string;
}

export interface QueryInput {
  name: string;
  sql: string;
  metadata?: QueryInputMetadata;
}

export interface TableReference {
  sourceName: string;
  rawName: string;
  fullName: string;
  schemaName?: string;
  tableName: string;
  alias?: string;
  clause: 'from' | 'join' | 'update' | 'into';
}

export interface JoinCondition {
  sourceName: string;
  leftAlias: string;
  leftColumn: string;
  rightAlias: string;
  rightColumn: string;
  rawExpression: string;
}

export interface ParsedQuery {
  sourceName: string;
  normalizedSql: string;
  tableReferences: TableReference[];
  joinConditions: JoinCondition[];
  cteNames: string[];
  warnings: string[];
  metadata?: QueryInputMetadata;
}

export interface AcceptedQuerySource extends QueryInputMetadata {
  sourceName: string;
}

export interface ForeignKeyMetadata {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableMetadata {
  fullName: string;
  tableName: string;
  schemaName?: string;
  columns: string[];
  primaryKeys: string[];
  indexes: string[];
  foreignKeys: ForeignKeyMetadata[];
}

export interface TableLookup {
  fullName: string;
  tableName: string;
  schemaName?: string;
}

export interface AnalyzedTable extends TableLookup {
  aliases: string[];
  sources: string[];
  metadata?: TableMetadata;
}

export interface Relationship {
  sourceName: string;
  fromTable: string;
  toTable: string;
  fromColumn: string;
  toColumn: string;
  confidence: 'confirmed' | 'inferred';
  cardinality: 'one-to-one' | 'many-to-one' | 'unknown';
  reason: string;
}

export interface AnalysisResult {
  parsedQueries: ParsedQuery[];
  acceptedQuerySources: AcceptedQuerySource[];
  tables: AnalyzedTable[];
  relationships: Relationship[];
  warnings: string[];
  mermaid: string;
  report: string;
}
