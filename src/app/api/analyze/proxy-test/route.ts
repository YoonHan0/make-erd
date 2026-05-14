import { NextResponse } from 'next/server';
import { parseQuery } from '@/parser/extract';
import { prepareQueryInputs } from '@/server/prepare-query-inputs';
import { TableLookup } from '@/domain/types';
import { invokeAmaranthApi } from '@/app/api/apiProxy/apiProxy.js';

type ProxyBatchTestResponse = {
  ok: boolean;
  message: string;
  tableCount: number;
  tables: TableLookup[];
  proxyStatus?: number;
  proxyTarget?: string;
  proxyResponse?: unknown;
};

type ProxyBatchTablePayload = {
  tableName: string;
  schemaName: string;
};

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
          ok: false,
          message: '테스트 가능한 조회 SQL이 필요합니다. SQL 입력 또는 파일 업로드 후 다시 시도해 주세요.',
          tableCount: 0,
          tables: [],
        } satisfies ProxyBatchTestResponse,
        { status: 400 },
      );
    }

    const domain = process.env.MCP_PROXY_BATCH_TEST_DOMAIN?.trim();
    const urlPath = process.env.MCP_PROXY_BATCH_TEST_URL?.trim();
    const token = process.env.MCP_PROXY_BATCH_TEST_TOKEN?.trim();
    const hashKey = process.env.MCP_PROXY_BATCH_TEST_HASH_KEY?.trim();
    const callerName = process.env.MCP_PROXY_BATCH_TEST_CALLER_NAME?.trim();
    const groupSeq = process.env.MCP_PROXY_BATCH_TEST_GROUP_SEQ?.trim();
    const schemaName = process.env.MCP_PROXY_BATCH_TEST_SCHEMA_NAME?.trim();

    if (!domain || !urlPath || !token || !hashKey || !schemaName) {
      return NextResponse.json(
        {
          ok: false,
          message:
            'MCP_PROXY_BATCH_TEST_DOMAIN, MCP_PROXY_BATCH_TEST_URL, MCP_PROXY_BATCH_TEST_TOKEN, MCP_PROXY_BATCH_TEST_HASH_KEY, MCP_PROXY_BATCH_TEST_SCHEMA_NAME 환경 변수가 필요합니다.',
          tableCount: 0,
          tables: [],
        } satisfies ProxyBatchTestResponse,
        { status: 400 },
      );
    }

    const tables = collectTables(prepared.inputs.map(parseQuery), schemaName);
    const proxyTables = buildProxyTables(tables, schemaName);

    const parameters = {
      toolName: process.env.MCP_TOOL_NAME || 'describe_table',
      tables: proxyTables,
      ...(groupSeq ? { groupSeq } : {}),
    };

    const proxyBody = await invokeAmaranthApi(
      'POST',
      domain,
      urlPath,
      JSON.stringify(parameters),
      token,
      hashKey,
      callerName || null,
      groupSeq || null,
    );

    const payload: ProxyBatchTestResponse = {
      ok: true,
      message: `프록시에 테이블 ${tables.length}개를 한 번에 전송했습니다.`,
      tableCount: tables.length,
      tables,
      proxyStatus: 200,
      proxyTarget: `${domain}${domain.endsWith('/') || urlPath.startsWith('/') ? '' : '/'}${urlPath}`,
      proxyResponse: proxyBody,
    };

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : '프록시 배치 테스트 중 알 수 없는 오류가 발생했습니다.',
        tableCount: 0,
        tables: [],
      } satisfies ProxyBatchTestResponse,
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

function collectTables(parsedQueries: ReturnType<typeof parseQuery>[], schemaName: string): TableLookup[] {
  const tableMap = new Map<string, TableLookup>();

  for (const parsedQuery of parsedQueries) {
    for (const reference of parsedQuery.tableReferences) {
      if (reference.fullName === '__subquery__') {
        continue;
      }

      if (!tableMap.has(reference.fullName)) {
        tableMap.set(reference.fullName, {
          fullName: reference.fullName,
          tableName: reference.tableName,
          schemaName,
        });
      }
    }
  }

  return [...tableMap.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function buildProxyTables(tables: TableLookup[], fallbackSchemaName: string): ProxyBatchTablePayload[] {
  return tables.map(({ tableName, schemaName }) => ({
    tableName,
    schemaName: schemaName ?? fallbackSchemaName,
  }));
}
