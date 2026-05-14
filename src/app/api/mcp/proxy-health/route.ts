import { NextResponse } from 'next/server';
import { invokeAmaranthApi } from '@/app/api/apiProxy/apiProxy.js';

type ProxyHealthResultData = {
  status?: 'ok' | 'error';
  connected?: boolean;
  sessionId?: string;
  url?: string;
  elapsedMs?: number;
  error?: string;
};

type ProxyHealthResponse = {
  ok: boolean;
  configured: boolean;
  target?: string;
  message: string;
  resultCode?: number;
  resultMsg?: string;
  resultData?: ProxyHealthResultData;
};

export async function POST() {
  try {
    const domain = process.env.MCP_PROXY_BATCH_TEST_DOMAIN?.trim();
    const urlPath = process.env.MCP_PROXY_BATCH_TEST_URL_H_CHECK?.trim();
    const token = process.env.MCP_PROXY_BATCH_TEST_TOKEN?.trim();
    const hashKey = process.env.MCP_PROXY_BATCH_TEST_HASH_KEY?.trim();
    const callerName = process.env.MCP_PROXY_BATCH_TEST_CALLER_NAME?.trim();
    const groupSeq = process.env.MCP_PROXY_BATCH_TEST_GROUP_SEQ?.trim();

    if (!domain || !urlPath || !token || !hashKey) {
      return NextResponse.json(
        {
          ok: false,
          configured: false,
          message:
            'MCP_PROXY_BATCH_TEST_DOMAIN, MCP_PROXY_BATCH_TEST_URL_H_CHECK, MCP_PROXY_BATCH_TEST_TOKEN, MCP_PROXY_BATCH_TEST_HASH_KEY 환경 변수가 필요합니다.',
        } satisfies ProxyHealthResponse,
        { status: 400 },
      );
    }

    const proxyBody = await invokeAmaranthApi(
      'POST',
      domain,
      urlPath,
      JSON.stringify({ groupSeq }),
      token,
      hashKey,
      callerName || null,
      groupSeq || null,
    );

    const resultData = extractResultData(proxyBody);
    const connected = Boolean(resultData?.connected);

    return NextResponse.json({
      ok: connected,
      configured: true,
      target: `${domain}${domain.endsWith('/') || urlPath.startsWith('/') ? '' : '/'}${urlPath}`,
      message: connected ? '프록시 서버를 통해 MCP 연결 확인에 성공했습니다.' : '프록시 서버는 응답했지만 MCP 연결이 실패했습니다.',
      resultCode: getNumberField(proxyBody, 'resultCode'),
      resultMsg: getStringField(proxyBody, 'resultMsg'),
      resultData,
    } satisfies ProxyHealthResponse);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        message: error instanceof Error ? error.message : '프록시 서버 연결 확인 중 알 수 없는 오류가 발생했습니다.',
      } satisfies ProxyHealthResponse,
      { status: 500 },
    );
  }
}

function extractResultData(payload: unknown): ProxyHealthResultData | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const resultData = record.resultData;

  if (!resultData || typeof resultData !== 'object') {
    return undefined;
  }

  const data = resultData as Record<string, unknown>;
  return {
    status: getStringField(data, 'status') as 'ok' | 'error' | undefined,
    connected: getBooleanField(data, 'connected'),
    sessionId: getStringField(data, 'sessionId'),
    url: getStringField(data, 'url'),
    elapsedMs: getNumberField(data, 'elapsedMs'),
    error: getStringField(data, 'error'),
  };
}

function getStringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumberField(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function getBooleanField(record: unknown, key: string): boolean | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}
