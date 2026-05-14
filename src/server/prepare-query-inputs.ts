import { QueryInput, QueryInputMetadata } from '@/domain/types';

export interface PreparedQueryInputs {
  inputs: QueryInput[];
  warnings: string[];
}

const XML_SQL_BLOCK_PATTERN = /<((?:[\w.-]+:)?(?:select|insert|update|delete|sql|query|statement))\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const XML_CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/gi;
const READ_QUERY_PREFIXES = ['select', 'with', 'show', 'describe', 'desc', 'explain'] as const;
const WRITE_XML_TAGS = new Set(['insert', 'update', 'delete']);

interface SourceDocument {
  name: string;
  content: string;
  format: 'sql' | 'xml';
}

interface ExtractedStatement {
  sql: string;
  sourceLabel?: string;
  queryId?: string;
  tagName?: string;
  forceIgnore?: boolean;
}

export function prepareQueryInputs(sqlText: string, files: Array<{ name: string; content: string }>): PreparedQueryInputs {
  const warnings: string[] = [];
  const documents: SourceDocument[] = [];

  if (sqlText.trim()) {
    documents.push({
      name: '직접 입력 SQL',
      content: sqlText,
      format: 'sql',
    });
  }

  for (const file of files) {
    documents.push({
      name: file.name,
      content: file.content,
      format: file.name.toLowerCase().endsWith('.xml') ? 'xml' : 'sql',
    });
  }

  const inputs: QueryInput[] = [];

  for (const document of documents) {
    const statements = extractStatements(document);
    const readableStatements = statements.filter((statement) => !statement.forceIgnore && isReadQuery(statement.sql));
    const ignoredCount = statements.length - readableStatements.length;

    if (ignoredCount > 0) {
      warnings.push(`${document.name}에서 조회 이외의 쿼리 ${ignoredCount}개를 분석 대상에서 제외했습니다.`);
    }

    if (statements.length === 0 && document.format === 'xml') {
      warnings.push(`${document.name}에서 분석 가능한 SQL 블록을 찾지 못했습니다.`);
    }

    if (statements.length > 0 && readableStatements.length === 0) {
      warnings.push(`${document.name}에는 조회 계열 쿼리가 없어 분석하지 않았습니다.`);
    }

    inputs.push(
      ...buildQueryInputs(document, readableStatements),
    );
  }

  return {
    inputs,
    warnings: [...new Set(warnings)],
  };
}

function buildQueryInputs(document: SourceDocument, readableStatements: ExtractedStatement[]): QueryInput[] {
  const duplicateSourceNames = new Map<string, number>();

  return readableStatements.map((statement, index) => {
    const baseSourceName = statement.sourceLabel ?? (readableStatements.length > 1 ? `${document.name}#${index + 1}` : document.name);
    const sourceName = createUniqueSourceName(baseSourceName, duplicateSourceNames);
    const metadata: QueryInputMetadata = {
      documentName: document.name,
      sourceLabel: statement.sourceLabel ?? baseSourceName,
      format: document.format,
      queryId: statement.queryId,
      tagName: statement.tagName,
    };

    return {
      name: sourceName,
      sql: statement.sql,
      metadata,
    };
  });
}

function createUniqueSourceName(baseSourceName: string, duplicateSourceNames: Map<string, number>): string {
  const existingCount = duplicateSourceNames.get(baseSourceName) ?? 0;
  duplicateSourceNames.set(baseSourceName, existingCount + 1);

  if (existingCount === 0) {
    return baseSourceName;
  }

  return `${baseSourceName}#${existingCount + 1}`;
}

function extractStatements(document: SourceDocument): ExtractedStatement[] {
  const rawSegments = document.format === 'xml' ? extractXmlSegments(document.name, document.content) : [{ sql: document.content }];
  const statements: ExtractedStatement[] = [];

  for (const segment of rawSegments) {
    for (const statement of splitSqlStatements(segment.sql)) {
      const sql = statement.trim();
      if (!sql) {
        continue;
      }

      statements.push({
        sql,
        sourceLabel: segment.sourceLabel,
        queryId: segment.queryId,
        tagName: segment.tagName,
        forceIgnore: segment.forceIgnore,
      });
    }
  }

  return statements;
}

function extractXmlSegments(documentName: string, content: string): ExtractedStatement[] {
  const taggedSegments: ExtractedStatement[] = [];
  let matchedSqlBlocks = false;

  for (const match of content.matchAll(XML_SQL_BLOCK_PATTERN)) {
    matchedSqlBlocks = true;
    const tagName = normalizeXmlTagName(match[1]);
    const body = normalizeXmlSqlBody(match[3]);
    if (!body) {
      continue;
    }

    const queryId = extractXmlAttribute(match[2], 'id');
    taggedSegments.push({
      sql: body,
      sourceLabel: queryId ? `${documentName}#${queryId}` : undefined,
      queryId,
      tagName,
      forceIgnore: WRITE_XML_TAGS.has(tagName),
    });
  }

  if (matchedSqlBlocks) {
    return taggedSegments;
  }

  const cdataSegments: ExtractedStatement[] = [];
  for (const match of content.matchAll(XML_CDATA_PATTERN)) {
    const body = normalizeXmlSqlBody(match[1]);
    if (body) {
      cdataSegments.push({ sql: body });
    }
  }

  if (cdataSegments.length > 0) {
    return cdataSegments;
  }

  const fallbackText = normalizeXmlSqlBody(content.replace(/<[^>]+>/g, ' '));
  return fallbackText ? [{ sql: fallbackText }] : [];
}

function normalizeXmlTagName(value: string): string {
  const parts = value.toLowerCase().split(':');
  return parts[parts.length - 1];
}

function extractXmlAttribute(attributes: string, attributeName: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${attributeName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2]?.trim() || undefined;
}

function normalizeXmlSqlBody(value: string): string {
  return value
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<\/?[A-Za-z_][\w:.-]*(?:\s+[^<>]*?)?\/?>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: '\'' | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      current += character;
      if (character === '\n') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      current += character;
      if (character === '*' && next === '/') {
        current += '/';
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += character;
      if (character === quote) {
        if (quote === '\'' && next === '\'') {
          current += next;
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }

    if (character === '-' && next === '-') {
      current += character + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (character === '/' && next === '*') {
      current += character + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (character === '\'' || character === '"' || character === '`') {
      current += character;
      quote = character;
      continue;
    }

    if (character === ';') {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

function isReadQuery(sql: string): boolean {
  const trimmed = stripLeadingComments(sql).trimStart().toLowerCase();
  return READ_QUERY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function stripLeadingComments(sql: string): string {
  let value = sql.trimStart();

  while (true) {
    if (value.startsWith('--')) {
      const nextLineIndex = value.indexOf('\n');
      value = nextLineIndex === -1 ? '' : value.slice(nextLineIndex + 1).trimStart();
      continue;
    }

    if (value.startsWith('/*')) {
      const endIndex = value.indexOf('*/');
      value = endIndex === -1 ? '' : value.slice(endIndex + 2).trimStart();
      continue;
    }

    return value;
  }
}
