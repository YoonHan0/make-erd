export interface Token {
  value: string;
  lower: string;
}

const SYMBOLS = new Set(['(', ')', ',', '.', '=', ';']);

export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      index = skipLineComment(sql, index + 2);
      continue;
    }

    if (current === '/' && next === '*') {
      index = skipBlockComment(sql, index + 2);
      continue;
    }

    if (current === '\'') {
      index = skipStringLiteral(sql, index + 1);
      continue;
    }

    if (current === '"' || current === '`' || current === '[') {
      const { value, nextIndex } = readDelimitedIdentifier(sql, index);
      tokens.push(createToken(value));
      index = nextIndex;
      continue;
    }

    if (SYMBOLS.has(current)) {
      tokens.push(createToken(current));
      index += 1;
      continue;
    }

    const { value, nextIndex } = readWord(sql, index);
    tokens.push(createToken(value));
    index = nextIndex;
  }

  return tokens;
}

function createToken(value: string): Token {
  return { value, lower: value.toLowerCase() };
}

function skipLineComment(sql: string, index: number): number {
  while (index < sql.length && sql[index] !== '\n') {
    index += 1;
  }

  return index;
}

function skipBlockComment(sql: string, index: number): number {
  while (index < sql.length) {
    if (sql[index] === '*' && sql[index + 1] === '/') {
      return index + 2;
    }

    index += 1;
  }

  return index;
}

function skipStringLiteral(sql: string, index: number): number {
  while (index < sql.length) {
    if (sql[index] === '\'' && sql[index + 1] === '\'') {
      index += 2;
      continue;
    }

    if (sql[index] === '\'') {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function readDelimitedIdentifier(sql: string, index: number): { value: string; nextIndex: number } {
  const opener = sql[index];
  const closer = opener === '[' ? ']' : opener;
  let cursor = index + 1;
  let value = '';

  while (cursor < sql.length) {
    if (sql[cursor] === closer) {
      return { value, nextIndex: cursor + 1 };
    }

    value += sql[cursor];
    cursor += 1;
  }

  return { value, nextIndex: cursor };
}

function readWord(sql: string, index: number): { value: string; nextIndex: number } {
  let cursor = index;
  let value = '';

  while (cursor < sql.length) {
    const current = sql[cursor];
    const next = sql[cursor + 1];

    if (
      /\s/.test(current) ||
      SYMBOLS.has(current) ||
      current === '\'' ||
      current === '"' ||
      current === '`' ||
      current === '[' ||
      (current === '-' && next === '-') ||
      (current === '/' && next === '*')
    ) {
      break;
    }

    value += current;
    cursor += 1;
  }

  return { value, nextIndex: cursor };
}

