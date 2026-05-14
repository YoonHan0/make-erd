import { NextResponse } from 'next/server';
import { analyzeQueries } from '@/analyzer/analyze';
import { NoopMetadataEnricher } from '@/enricher/noop-metadata-enricher';
import { McpMetadataEnricher, type McpConfig } from '@/enricher/mcp-metadata-enricher';
import { ProxyBatchConfig, ProxyBatchMetadataEnricher } from '@/enricher/proxy-batch-metadata-enricher';
import { prepareQueryInputs } from '@/server/prepare-query-inputs';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const sqlText = readTextField(formData.get('sqlText'));
    const files = formData.getAll('files');

    const uploadedFiles = await Promise.all(
      files
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map(async (file) => ({
          name: file.name || 'uploaded-query.sql',
          content: await file.text(),
        })),
    );

    const prepared = prepareQueryInputs(sqlText, uploadedFiles);

    if (prepared.inputs.length === 0) {
      return NextResponse.json(
        {
          message: '분석 가능한 조회 SQL이 필요합니다. 업로드 파일에 조회문이 있는지 확인해 주세요.',
        },
        { status: 400 },
      );
    }

    const enricher = createMetadataEnricher();
    const result = await analyzeQueries(prepared.inputs, enricher, {
      extraWarnings: prepared.warnings,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '분석 중 알 수 없는 오류가 발생했습니다.';
    return NextResponse.json(
      {
        message,
      },
      { status: 500 },
    );
  }
}

function readTextField(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function createMetadataEnricher() {
  const toolName = process.env.MCP_TOOL_NAME;
  const resolvedToolName = toolName || 'describe_table';

  const useProxy = (process.env.USE_MCP_PROXY ?? '').trim().toLowerCase() === 'true';
  if (useProxy) {
    const proxyConfig = resolveProxyBatchConfig(resolvedToolName);
    return new ProxyBatchMetadataEnricher(proxyConfig);
  }

  const mcpUrl = process.env.MCP_URL;

  // HTTP 방식 (Streamable HTTP)
  if (mcpUrl) {
    const mcpConfig: McpConfig = { transport: 'http', url: mcpUrl };
    return new McpMetadataEnricher(mcpConfig, resolvedToolName);
  }

  // stdio 방식 (로컬 프로세스)
  const command = process.env.MCP_COMMAND;
  const argsEnv = process.env.MCP_ARGS;

  if (!command || !argsEnv) {
    return new NoopMetadataEnricher();
  }

  const allowedSchemas = (process.env.ALLOWED_SCHEMAS ?? process.env.MCP_ALLOWED_SCHEMAS ?? '').trim();
  if (!allowedSchemas) {
    throw new Error(
      'MCP 메타데이터 조회가 활성화되었지만 ALLOWED_SCHEMAS(또는 MCP_ALLOWED_SCHEMAS)가 비어 있습니다. .env.local 또는 실행 환경에 ALLOWED_SCHEMAS를 설정해 주세요.',
    );
  }

  const args = argsEnv.split(' ').filter((arg) => arg.trim());
  const mcpConfig: McpConfig = {
    transport: 'stdio',
    command,
    args,
    env: buildMcpStdioEnv(allowedSchemas),
  };

  return new McpMetadataEnricher(mcpConfig, resolvedToolName);
}

function resolveProxyBatchConfig(toolName: string): ProxyBatchConfig {
  const domain = process.env.MCP_PROXY_BATCH_TEST_DOMAIN?.trim();
  const urlPath = process.env.MCP_PROXY_BATCH_TEST_URL?.trim();
  const token = process.env.MCP_PROXY_BATCH_TEST_TOKEN?.trim();
  const hashKey = process.env.MCP_PROXY_BATCH_TEST_HASH_KEY?.trim();
  const callerName = process.env.MCP_PROXY_BATCH_TEST_CALLER_NAME?.trim();
  const groupSeq = process.env.MCP_PROXY_BATCH_TEST_GROUP_SEQ?.trim();
  const schemaName = process.env.MCP_PROXY_BATCH_TEST_SCHEMA_NAME?.trim();

  if (!domain || !urlPath || !token || !hashKey) {
    throw new Error(
      'USE_MCP_PROXY=true 설정 시 MCP_PROXY_BATCH_TEST_DOMAIN, MCP_PROXY_BATCH_TEST_URL, MCP_PROXY_BATCH_TEST_TOKEN, MCP_PROXY_BATCH_TEST_HASH_KEY 환경 변수가 필요합니다.',
    );
  }

  return {
    domain,
    urlPath,
    token,
    hashKey,
    toolName,
    callerName,
    groupSeq,
    schemaName,
  };
}

type CriticalDbEnvKey = 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD';

function buildMcpStdioEnv(resolvedAllowedSchemas: string): Record<string, string> {
  const sanitizedEnv = Object.entries(process.env).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') {
      acc[key] = value;
    }
    return acc;
  }, {});

  sanitizedEnv.ALLOWED_SCHEMAS = resolvedAllowedSchemas;

  const criticalDbKeys: readonly CriticalDbEnvKey[] = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'];
  for (const key of criticalDbKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      sanitizedEnv[key] = value;
    }
  }

  return sanitizedEnv;
}
