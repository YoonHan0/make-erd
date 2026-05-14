import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspect } from 'node:util';
import { TableLookup, TableMetadata, ForeignKeyMetadata } from '../domain/types';
import { MetadataEnricher } from './metadata-enricher';

/** stdio 방식 - 로컬 프로세스로 실행되는 MCP 서버 연결 설정 */
export interface StdioMcpConfig {
  transport: 'stdio';
  /** MCP 서버 실행 커맨드 (예: 'npx', 'python', 'node') */
  command: string;
  /** 실행 인자 (예: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://...']) */
  args: string[];
  /** 환경변수 (선택) */
  env?: Record<string, string>;
}

/** HTTP 방식 - 원격 MCP 서버 연결 설정 (Streamable HTTP 프로토콜) */
export interface HttpMcpConfig {
  transport: 'http';
  /** MCP 서버 엔드포인트 URL */
  url: string;
}

export type McpConfig = StdioMcpConfig | HttpMcpConfig;

type ToolParsedMetadata = {
  columns?: string[];
  primaryKeys?: string[];
  primary_keys?: string[];
  indexes?: string[];
  foreignKeys?: unknown[];
  foreign_keys?: unknown[];
};

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

/**
 * MCP 서버에서 테이블 메타데이터를 조회하는 enricher.
 *
 * MCP 서버가 `get_table_info` 또는 `describe_table` 같은 툴을 제공한다고 가정합니다.
 * 연결하는 MCP 서버의 툴 명세에 맞게 `fetchTableMetadata`를 조정하세요.
 */
export class McpMetadataEnricher implements MetadataEnricher {
  private readonly config: McpConfig;
  /** MCP 서버가 제공하는 테이블 조회 툴 이름 */
  private readonly toolName: string;

  constructor(config: McpConfig, toolName = 'describe_table') {
    this.config = config;
    this.toolName = toolName;
  }

  async enrichTables(tables: TableLookup[]): Promise<Map<string, TableMetadata>> {
    const client = new Client({ name: 'make_erd', version: '0.1.0' });
    const transport = this.createTransport();

    await client.connect(transport);

    try {
      const entries = await Promise.all(
        tables.map(async (table) => {
          const metadata = await this.fetchTableMetadata(client, table);
          return [table.fullName, metadata] as const;
        }),
      );
      return new Map(entries);
    } finally {
      await client.close();
    }
  }

  private createTransport() {
    if (this.config.transport === 'stdio') {
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
      });
    }

    // Streamable HTTP transport (MCP SDK 1.x)
    return new StreamableHTTPClientTransport(new URL(this.config.url));
  }

  /**
   * MCP 툴을 호출해 테이블 메타데이터를 가져옵니다.
   * 연결하는 MCP 서버의 응답 스키마에 맞게 이 메서드를 수정하세요.
   */
  private async fetchTableMetadata(client: Client, table: TableLookup): Promise<TableMetadata> {
    try {

      const result = await this.callToolWithFallbackArguments(client, table);
      
      const raw = this.parseToolResult(result.content);
      const columns = this.uniqueNormalized(raw.columns ?? [], true);
      const primaryKeys = this.uniqueNormalized(raw.primaryKeys ?? raw.primary_keys ?? [], true);
      const indexes = this.uniqueNormalized(raw.indexes ?? [], false);

      return {
        fullName: table.fullName,
        tableName: table.tableName,
        schemaName: table.schemaName,
        columns,
        primaryKeys,
        indexes,
        foreignKeys: this.normalizeForeignKeys(raw.foreignKeys ?? raw.foreign_keys ?? []),
      };
    } catch {
      // 조회 실패 시 빈 메타데이터로 폴백
      return {
        fullName: table.fullName,
        tableName: table.tableName,
        schemaName: table.schemaName,
        columns: [],
        primaryKeys: [],
        indexes: [],
        foreignKeys: [],
      };
    }
  }

  private async callToolWithFallbackArguments(client: Client, table: TableLookup) {
    const candidates: Record<string, string>[] = [
      this.compactArgs({ tableName: table.tableName, schemaName: table.schemaName }),
      this.compactArgs({ table_name: table.tableName, schema_name: table.schemaName }),
      this.compactArgs({ fullName: table.fullName, tableName: table.tableName, schemaName: table.schemaName }),
      this.compactArgs({ full_name: table.fullName, table_name: table.tableName, schema_name: table.schemaName }),
    ];

    let lastError: unknown;
    for (const args of candidates) {
      try {
        return await client.callTool({
          name: this.toolName,
          arguments: args,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error('Failed to call MCP tool with all known argument conventions.');
  }

  private compactArgs(input: Record<string, string | undefined>): Record<string, string> {
    return Object.entries(input).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === 'string' && value.length > 0) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  private parseToolResult(content: unknown): ToolParsedMetadata {
    const text = this.extractTextContent(content);
    const jsonParsed = this.tryParseJsonFromText(text);
    if (jsonParsed) {
      return jsonParsed;
    }

    return this.parseTextMetadata(text);
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object') return '';
          if ('text' in item && typeof item.text === 'string') return item.text;
          return JSON.stringify(item);
        })
        .filter((value) => value.length > 0)
        .join('\n');
    }

    if (content && typeof content === 'object') {
      return JSON.stringify(content);
    }

    return '';
  }

  private tryParseJsonFromText(text: string): ToolParsedMetadata | null {
    const candidates = [text, ...this.extractFencedCodeBlocks(text)];

    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const normalized = this.normalizeJsonMetadata(parsed);
        if (normalized) {
          return normalized;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private extractFencedCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const regex = /```(?:json|javascript|js|typescript|ts)?\s*([\s\S]*?)```/gi;

    for (const match of text.matchAll(regex)) {
      const body = match[1]?.trim();
      if (body) {
        blocks.push(body);
      }
    }

    return blocks;
  }

  private normalizeJsonMetadata(value: unknown): ToolParsedMetadata | null {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.normalizeJsonMetadata(item);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;
    const metadataCandidate =
      this.pickMetadataRecord(record) ??
      this.pickMetadataRecord(record.metadata) ??
      this.pickMetadataRecord(record.data) ??
      this.pickMetadataRecord(record.table);

    if (!metadataCandidate) {
      return null;
    }

    return {
      columns: this.toStringArray(metadataCandidate.columns),
      primaryKeys: this.toStringArray(metadataCandidate.primaryKeys),
      primary_keys: this.toStringArray(metadataCandidate.primary_keys),
      indexes: this.toStringArray(metadataCandidate.indexes),
      foreignKeys: this.toObjectArray(metadataCandidate.foreignKeys),
      foreign_keys: this.toObjectArray(metadataCandidate.foreign_keys),
    };
  }

  private pickMetadataRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const hasKnownKey =
      'columns' in record ||
      'primaryKeys' in record ||
      'primary_keys' in record ||
      'indexes' in record ||
      'foreignKeys' in record ||
      'foreign_keys' in record;

    return hasKnownKey ? record : null;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
  }

  private toObjectArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }

  private parseTextMetadata(text: string): ToolParsedMetadata {
    if (!text.trim()) {
      return {};
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== '```');
    const markdownTables = this.parseMarkdownTables(lines);

    const columns = this.uniqueNormalized(
      [
        ...this.extractColumnsFromTables(markdownTables),
        ...this.extractInlineNames(lines, /(컬럼|columns?|fields?)/i, true),
      ],
      true,
    );
    const primaryKeys = this.uniqueNormalized(
      [
        ...this.extractPrimaryKeysFromTables(markdownTables),
        ...this.extractInlineNames(lines, /(기본키|primary\s*key|\bpk\b)/i, true),
      ],
      true,
    );
    const indexes = this.uniqueNormalized(
      [
        ...this.extractIndexesFromTables(markdownTables),
        ...this.extractInlineNames(lines, /(인덱스|indexes?|idx)/i, false),
      ],
      false,
    );
    const foreignKeys = this.normalizeForeignKeys([
      ...this.extractForeignKeysFromTables(markdownTables),
      ...this.extractForeignKeysFromLines(lines),
    ]);

    return {
      columns,
      primaryKeys,
      indexes,
      foreignKeys,
    };
  }

  private parseMarkdownTables(lines: string[]): ParsedMarkdownTable[] {
    const tables: ParsedMarkdownTable[] = [];

    for (let index = 0; index < lines.length - 1; index += 1) {
      const headerLine = lines[index];
      const dividerLine = lines[index + 1];

      if (!headerLine.includes('|') || !this.isMarkdownDivider(dividerLine)) {
        continue;
      }

      const headers = this.parsePipeRow(headerLine);
      const rows: string[][] = [];
      let rowIndex = index + 2;

      while (rowIndex < lines.length) {
        const rowLine = lines[rowIndex];
        if (!rowLine.includes('|') || this.isMarkdownDivider(rowLine)) {
          break;
        }
        rows.push(this.parsePipeRow(rowLine));
        rowIndex += 1;
      }

      if (headers.length > 0 && rows.length > 0) {
        tables.push({ headers, rows });
      }

      index = rowIndex - 1;
    }

    return tables;
  }

  private isMarkdownDivider(line: string): boolean {
    return /^\|?\s*:?[-]{2,}:?\s*(\|\s*:?[-]{2,}:?\s*)+\|?$/.test(line.trim());
  }

  private parsePipeRow(line: string): string[] {
    return line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  private extractColumnsFromTables(tables: ParsedMarkdownTable[]): string[] {
    const columns: string[] = [];

    for (const table of tables) {
      const columnIndex = this.findHeaderIndex(table.headers, ['컬럼', 'column', 'col', 'field', '필드']);
      if (columnIndex < 0) {
        continue;
      }

      for (const row of table.rows) {
        columns.push(...this.parseNameList(row[columnIndex], true));
      }
    }

    return columns;
  }

  private extractPrimaryKeysFromTables(tables: ParsedMarkdownTable[]): string[] {
    const primaryKeys: string[] = [];

    for (const table of tables) {
      const columnIndex = this.findHeaderIndex(table.headers, ['컬럼', 'column', 'col', 'field', '필드']);
      const pkIndex = this.findHeaderIndex(table.headers, ['기본키', 'pk', 'primarykey', 'primary key']);

      if (columnIndex >= 0 && pkIndex >= 0) {
        for (const row of table.rows) {
          const marker = row[pkIndex] ?? '';
          if (this.isTruthyMarker(marker)) {
            primaryKeys.push(...this.parseNameList(row[columnIndex], true));
          }
        }
        continue;
      }

      if (pkIndex >= 0 && columnIndex < 0) {
        for (const row of table.rows) {
          primaryKeys.push(...this.parseNameList(row[pkIndex], true));
        }
      }
    }

    return primaryKeys;
  }

  private extractIndexesFromTables(tables: ParsedMarkdownTable[]): string[] {
    const indexes: string[] = [];

    for (const table of tables) {
      const indexColumn = this.findHeaderIndex(table.headers, ['인덱스', 'index', 'indexes', 'idx']);
      if (indexColumn < 0) {
        continue;
      }

      for (const row of table.rows) {
        indexes.push(...this.parseNameList(row[indexColumn], false));
      }
    }

    return indexes;
  }

  private extractForeignKeysFromTables(tables: ParsedMarkdownTable[]): Array<Record<string, string>> {
    const foreignKeys: Array<Record<string, string>> = [];

    for (const table of tables) {
      const localIndex = this.findHeaderIndex(table.headers, ['컬럼', 'column', 'fromcolumn', 'from column', 'fk']);
      const refTableIndex = this.findHeaderIndex(table.headers, [
        '참조테이블',
        'references table',
        'reference table',
        'totable',
        'to table',
      ]);
      const refColumnIndex = this.findHeaderIndex(table.headers, [
        '참조컬럼',
        'references column',
        'reference column',
        'tocolumn',
        'to column',
      ]);
      const refCombinedIndex = this.findHeaderIndex(table.headers, ['references', 'reference', '참조']);

      for (const row of table.rows) {
        const local = this.normalizeColumnName(row[localIndex] ?? '');
        const explicitRefTable = this.normalizeTableName(row[refTableIndex] ?? '');
        const explicitRefColumn = this.normalizeColumnName(row[refColumnIndex] ?? '');

        if (local && explicitRefTable && explicitRefColumn) {
          foreignKeys.push({
            column: local,
            referencesTable: explicitRefTable,
            referencesColumn: explicitRefColumn,
          });
          continue;
        }

        if (local && refCombinedIndex >= 0) {
          const parsedRef = this.parseQualifiedColumn(row[refCombinedIndex] ?? '');
          if (parsedRef) {
            foreignKeys.push({
              column: local,
              referencesTable: parsedRef.table,
              referencesColumn: parsedRef.column,
            });
          }
        }
      }
    }

    return foreignKeys;
  }

  private extractInlineNames(lines: string[], headingPattern: RegExp, columnLike: boolean): string[] {
    const results: string[] = [];

    for (const line of lines) {
      const match = line.match(new RegExp(`${headingPattern.source}\\s*[:：]\\s*(.+)`, 'i'));
      if (!match) {
        continue;
      }
      results.push(...this.parseNameList(match[1], columnLike));
    }

    return results;
  }

  private extractForeignKeysFromLines(lines: string[]): Array<Record<string, string>> {
    const foreignKeys: Array<Record<string, string>> = [];
    const text = lines.join('\n');

    for (const match of text.matchAll(/foreign\s+key\s*\(([^)]+)\)\s*references\s+([A-Za-z0-9_."`\[\]]+)\s*\(([^)]+)\)/gi)) {
      const localColumns = this.parseNameList(match[1], true);
      const refColumns = this.parseNameList(match[3], true);
      const refTable = this.normalizeTableName(match[2]);

      for (let index = 0; index < localColumns.length; index += 1) {
        const local = localColumns[index];
        const refColumn = refColumns[index] ?? refColumns[0] ?? '';
        if (local && refTable && refColumn) {
          foreignKeys.push({
            column: local,
            referencesTable: refTable,
            referencesColumn: refColumn,
          });
        }
      }
    }

    for (const line of lines) {
      const arrowMatch = line.match(/([A-Za-z0-9_"`\[\].]+)\s*(?:->|=>|→)\s*([A-Za-z0-9_"`\[\].]+)/);
      if (arrowMatch) {
        const local = this.normalizeColumnName(arrowMatch[1]);
        const parsedRef = this.parseQualifiedColumn(arrowMatch[2]);
        if (local && parsedRef) {
          foreignKeys.push({
            column: local,
            referencesTable: parsedRef.table,
            referencesColumn: parsedRef.column,
          });
        }
      }

      const referencesMatch = line.match(/([A-Za-z0-9_"`\[\].]+)\s+(?:references?|참조)\s+([A-Za-z0-9_"`\[\].]+)\s*\(?([A-Za-z0-9_"`\[\].]+)?\)?/i);
      if (referencesMatch) {
        const local = this.normalizeColumnName(referencesMatch[1]);
        const refTable = this.normalizeTableName(referencesMatch[2]);
        const refColumn = this.normalizeColumnName(referencesMatch[3] ?? '');
        if (local && refTable && refColumn) {
          foreignKeys.push({
            column: local,
            referencesTable: refTable,
            referencesColumn: refColumn,
          });
        }
      }
    }

    return foreignKeys;
  }

  private findHeaderIndex(headers: string[], candidates: string[]): number {
    const normalizedHeaders = headers.map((header) => this.normalizeHeader(header));
    const normalizedCandidates = candidates.map((candidate) => this.normalizeHeader(candidate));

    for (let index = 0; index < normalizedHeaders.length; index += 1) {
      if (normalizedCandidates.some((candidate) => normalizedHeaders[index].includes(candidate))) {
        return index;
      }
    }

    return -1;
  }

  private normalizeHeader(value: string): string {
    return value.toLowerCase().replace(/[\s_-]+/g, '');
  }

  private parseNameList(raw: string, columnLike: boolean): string[] {
    if (!raw) {
      return [];
    }

    const cleaned = raw
      .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/\*+/g, '')
      .replace(/`/g, '')
      .trim();

    if (!cleaned) {
      return [];
    }

    return cleaned
      .split(/[;,]/)
      .map((part) => (columnLike ? this.normalizeColumnName(part) : this.normalizeIdentifier(part)))
      .filter((value) => value.length > 0);
  }

  private normalizeIdentifier(value: string): string {
    const trimmed = value.trim().replace(/^[-*]\s*/, '').replace(/\s+\(.+\)$/, '');
    const stripped = trimmed.replace(/^["'`\[]+|["'`\]]+$/g, '');
    return stripped.replace(/\s+/g, '');
  }

  private normalizeColumnName(value: string): string {
    const normalized = this.normalizeIdentifier(value);
    if (!normalized) {
      return '';
    }

    const parts = normalized.split('.').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? '';
  }

  private normalizeTableName(value: string): string {
    const normalized = this.normalizeIdentifier(value);
    if (!normalized) {
      return '';
    }

    return normalized
      .split('.')
      .map((part) => this.normalizeIdentifier(part))
      .filter((part) => part.length > 0)
      .join('.');
  }

  private parseQualifiedColumn(value: string): { table: string; column: string } | null {
    const cleaned = this.normalizeIdentifier(value);
    if (!cleaned.includes('.')) {
      return null;
    }

    const parts = cleaned.split('.').filter((part) => part.length > 0);
    if (parts.length < 2) {
      return null;
    }

    const column = this.normalizeColumnName(parts[parts.length - 1]);
    const table = this.normalizeTableName(parts.slice(0, -1).join('.'));

    if (!table || !column) {
      return null;
    }

    return { table, column };
  }

  private isTruthyMarker(value: string): boolean {
    return /^(y|yes|true|1|o|v|pk|기본키)$/i.test(value.trim());
  }

  private uniqueNormalized(values: string[], columnLike: boolean): string[] {
    const deduped = new Map<string, string>();

    for (const value of values) {
      const normalized = columnLike ? this.normalizeColumnName(value) : this.normalizeIdentifier(value);
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, normalized);
      }
    }

    return [...deduped.values()];
  }

  private normalizeForeignKeys(raw: unknown[]): ForeignKeyMetadata[] {
    if (!Array.isArray(raw)) return [];

    const deduped = new Map<string, ForeignKeyMetadata>();

    for (const candidate of raw) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const fk = candidate as Record<string, unknown>;
      const column = this.normalizeColumnName(
        this.toString(fk.column) || this.toString(fk.from_column) || this.toString(fk.fromColumn),
      );
      const referencesTable = this.normalizeTableName(
        this.toString(fk.referencesTable) ||
          this.toString(fk.references_table) ||
          this.toString(fk.to_table) ||
          this.toString(fk.toTable),
      );
      const referencesColumn = this.normalizeColumnName(
        this.toString(fk.referencesColumn) ||
          this.toString(fk.references_column) ||
          this.toString(fk.to_column) ||
          this.toString(fk.toColumn),
      );

      if (!column || !referencesTable || !referencesColumn) {
        continue;
      }

      const key = `${column.toLowerCase()}|${referencesTable.toLowerCase()}|${referencesColumn.toLowerCase()}`;
      if (!deduped.has(key)) {
        deduped.set(key, {
          column,
          referencesTable,
          referencesColumn,
        });
      }
    }

    return [...deduped.values()];
  }

  private toString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
