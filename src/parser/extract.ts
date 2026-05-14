import { JoinCondition, ParsedQuery, QueryInput, TableReference } from '../domain/types';
import { normalizeSql } from './normalize';
import { Token, tokenizeSql } from './tokenize';

const RESERVED_WORDS = new Set([
  'select',
  'from',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'outer',
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'on',
  'using',
  'set',
  'values',
  'as',
  'with',
  'by',
  'recursive',
]);

const CLAUSE_BOUNDARIES = new Set([
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'qualify',
  'window',
  'returning',
]);

export function parseQuery(input: QueryInput): ParsedQuery {
  const normalizedSql = normalizeSql(input.sql);
  const tokens = tokenizeSql(normalizedSql);
  const cteNames = extractCteNames(tokens);
  const scanResult = scanTableAndJoinTokens(tokens, input.name, cteNames);
  const warnings: string[] = [];

  return {
    sourceName: input.name,
    normalizedSql,
    tableReferences: scanResult.tableReferences,
    joinConditions: scanResult.joinConditions,
    cteNames: [...cteNames],
    warnings,
    metadata: input.metadata,
  };
}

function scanTableAndJoinTokens(
  tokens: Token[],
  sourceName: string,
  parentCteNames: Set<string> = new Set(),
): { tableReferences: TableReference[]; joinConditions: JoinCondition[] } {
  const localCteNames = extractCteNames(tokens);
  const activeCteNames = new Set([...parentCteNames, ...localCteNames]);
  const tableReferences: TableReference[] = [];
  const joinConditions: JoinCondition[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.lower === 'from' || token.lower === 'join' || token.lower === 'update' || token.lower === 'into') {
      const clause = token.lower as TableReference['clause'];
      const parsedReference = parseTableReference(tokens, index + 1, clause, sourceName);

      if (!parsedReference) {
        continue;
      }

      const cteKey = parsedReference.reference.fullName.toLowerCase();
      const tableKey = parsedReference.reference.tableName.toLowerCase();

      if (!activeCteNames.has(cteKey) && !activeCteNames.has(tableKey)) {
        tableReferences.push(parsedReference.reference);
      }

      if (parsedReference.subqueryTokens.length > 0) {
        const nestedScan = scanTableAndJoinTokens(parsedReference.subqueryTokens, sourceName, activeCteNames);
        tableReferences.push(...nestedScan.tableReferences);
        joinConditions.push(...nestedScan.joinConditions);
      }

      if (clause === 'join') {
        const joinScan = parseJoinConditions(tokens, parsedReference.nextIndex, sourceName);
        joinConditions.push(...joinScan.conditions);
      }

      index = parsedReference.nextIndex - 1;
    }
  }

  return { tableReferences, joinConditions };
}

function extractCteNames(tokens: Token[]): Set<string> {
  const cteNames = new Set<string>();

  if (tokens.length === 0 || tokens[0].lower !== 'with') {
    return cteNames;
  }

  let index = 1;
  if (tokens[index]?.lower === 'recursive') {
    index += 1;
  }

  while (index < tokens.length) {
    const nameToken = tokens[index];
    if (!isIdentifier(nameToken)) {
      break;
    }

    cteNames.add(nameToken.lower);
    index += 1;

    if (tokens[index]?.value === '(') {
      index = skipBalanced(tokens, index);
    }

    if (tokens[index]?.lower !== 'as' || tokens[index + 1]?.value !== '(') {
      break;
    }

    index += 1;
    index = skipBalanced(tokens, index);

    if (tokens[index]?.value !== ',') {
      break;
    }

    index += 1;
  }

  return cteNames;
}

function parseTableReference(
  tokens: Token[],
  startIndex: number,
  clause: TableReference['clause'],
  sourceName: string,
): { reference: TableReference; nextIndex: number; subqueryTokens: Token[] } | null {
  let index = startIndex;

  while (tokens[index] && ['lateral', 'only'].includes(tokens[index].lower)) {
    index += 1;
  }

  if (!tokens[index]) {
    return null;
  }

  if (tokens[index].value === '(') {
    const nextIndex = skipBalanced(tokens, index);
    return {
      reference: createVirtualReference(sourceName, clause),
      nextIndex,
      subqueryTokens: tokens.slice(index + 1, nextIndex - 1),
    };
  }

  const parts: string[] = [];
  let cursor = index;

  while (tokens[cursor]) {
    if (!isIdentifier(tokens[cursor])) {
      break;
    }

    parts.push(tokens[cursor].value);

    if (tokens[cursor + 1]?.value !== '.') {
      cursor += 1;
      break;
    }

    cursor += 2;
  }

  if (parts.length === 0) {
    return null;
  }

  const rawName = parts.join('.');
  const tableName = parts[parts.length - 1];
  const schemaName = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
  const fullName = schemaName ? `${schemaName}.${tableName}` : tableName;

  let alias: string | undefined;
  if (tokens[cursor]?.lower === 'as' && isIdentifier(tokens[cursor + 1])) {
    alias = tokens[cursor + 1].value;
    cursor += 2;
  } else if (isAliasToken(tokens[cursor])) {
    alias = tokens[cursor].value;
    cursor += 1;
  }

  return {
    reference: {
      sourceName,
      rawName,
      fullName,
      schemaName,
      tableName,
      alias,
      clause,
    },
    nextIndex: cursor,
    subqueryTokens: [],
  };
}

function parseJoinConditions(tokens: Token[], startIndex: number, sourceName: string): { conditions: JoinCondition[] } {
  let cursor = startIndex;
  let depth = 0;
  let capturing = false;
  const clauseTokens: Token[] = [];

  while (cursor < tokens.length) {
    const token = tokens[cursor];

    if (token.value === '(') {
      depth += 1;
    } else if (token.value === ')') {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }

    if (depth === 0 && isJoinBoundary(token)) {
      break;
    }

    if (!capturing && depth === 0 && token.lower === 'on') {
      capturing = true;
      cursor += 1;
      continue;
    }

    if (capturing) {
      clauseTokens.push(token);
    }

    cursor += 1;
  }

  return {
    conditions: parseEqualityConditions(clauseTokens, sourceName),
  };
}

function parseEqualityConditions(tokens: Token[], sourceName: string): JoinCondition[] {
  const conditions: JoinCondition[] = [];

  for (let index = 0; index < tokens.length - 6; index += 1) {
    if (
      isIdentifier(tokens[index]) &&
      tokens[index + 1]?.value === '.' &&
      isIdentifier(tokens[index + 2]) &&
      tokens[index + 3]?.value === '=' &&
      isIdentifier(tokens[index + 4]) &&
      tokens[index + 5]?.value === '.' &&
      isIdentifier(tokens[index + 6])
    ) {
      conditions.push({
        sourceName,
        leftAlias: tokens[index].value,
        leftColumn: tokens[index + 2].value,
        rightAlias: tokens[index + 4].value,
        rightColumn: tokens[index + 6].value,
        rawExpression: `${tokens[index].value}.${tokens[index + 2].value} = ${tokens[index + 4].value}.${tokens[index + 6].value}`,
      });
    }
  }

  return conditions;
}

function skipBalanced(tokens: Token[], startIndex: number): number {
  let depth = 0;
  let index = startIndex;

  while (index < tokens.length) {
    if (tokens[index].value === '(') {
      depth += 1;
    } else if (tokens[index].value === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return index;
}

function isIdentifier(token: Token | undefined): token is Token {
  return Boolean(token && token.value && !['(', ')', ',', '.', '=', ';'].includes(token.value));
}

function isAliasToken(token: Token | undefined): token is Token {
  return Boolean(token && isIdentifier(token) && !RESERVED_WORDS.has(token.lower));
}

function isJoinBoundary(token: Token): boolean {
  return (
    token.value === ',' ||
    token.value === ';' ||
    token.lower === 'join' ||
    token.lower === 'inner' ||
    token.lower === 'left' ||
    token.lower === 'right' ||
    token.lower === 'full' ||
    token.lower === 'cross' ||
    CLAUSE_BOUNDARIES.has(token.lower)
  );
}

function createVirtualReference(sourceName: string, clause: TableReference['clause']): TableReference {
  return {
    sourceName,
    rawName: '__subquery__',
    fullName: '__subquery__',
    tableName: '__subquery__',
    clause,
  };
}
