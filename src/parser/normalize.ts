const TEMPLATE_PLACEHOLDER_PATTERN = String.raw`(?:\$\{[^}]+\}|#\{[^}]+\}|\{\{[^}]+\}\})`;
const NAMED_PARAMETER_PATTERN = String.raw`(?::[A-Za-z_][\w$]*)`;

const PLACEHOLDER_PREFIX_PATTERN = new RegExp(
  String.raw`(?:${TEMPLATE_PLACEHOLDER_PATTERN}|${NAMED_PARAMETER_PATTERN})\s*\.\s*`,
  'g',
);

export function normalizeSql(sql: string): string {
  return sql.replace(PLACEHOLDER_PREFIX_PATTERN, '');
}
