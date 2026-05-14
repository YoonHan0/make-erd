import { NextResponse } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type HealthPayload = {
  ok: boolean;
  configured: boolean;
  transport?: 'http' | 'stdio';
  target?: string;
  toolCount?: number;
  tools?: string[];
  message: string;
};

export async function GET() {
  const config = resolveMcpConfig();

  if (!config) {
    const payload: HealthPayload = {
      ok: false,
      configured: false,
      message: 'MCP 설정이 없습니다. MCP_URL 또는 MCP_COMMAND/MCP_ARGS를 설정해 주세요.',
    };
    return NextResponse.json(payload);
  }

  const client = new Client({ name: 'make_erd-health-check', version: '0.1.0' });

  try {
    if (config.transport === 'http') {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
    } else {
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
        }),
      );
    }

    const tools = await client.listTools();
    const payload: HealthPayload = {
      ok: true,
      configured: true,
      transport: config.transport,
      target: config.transport === 'http' ? config.url : `${config.command} ${config.args.join(' ')}`,
      toolCount: tools.tools.length,
      tools: tools.tools.map((tool) => tool.name),
      message: 'MCP 서버 연결 및 도구 조회에 성공했습니다.',
    };

    return NextResponse.json(payload);
  } catch (error) {
    const payload: HealthPayload = {
      ok: false,
      configured: true,
      transport: config.transport,
      target: config.transport === 'http' ? config.url : `${config.command} ${config.args.join(' ')}`,
      message: error instanceof Error ? error.message : 'MCP 연결 확인 중 알 수 없는 오류가 발생했습니다.',
    };

    return NextResponse.json(payload, { status: 500 });
  } finally {
    await client.close();
  }
}

type HttpConfig = {
  transport: 'http';
  url: string;
};

type StdioConfig = {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
};

function resolveMcpConfig(): HttpConfig | StdioConfig | null {
  const mcpUrl = process.env.MCP_URL?.trim();
  if (mcpUrl) {
    return {
      transport: 'http',
      url: mcpUrl,
    };
  }

  const command = process.env.MCP_COMMAND?.trim();
  const argsEnv = process.env.MCP_ARGS?.trim();
  if (!command || !argsEnv) {
    return null;
  }

  const allowedSchemas = (process.env.ALLOWED_SCHEMAS ?? process.env.MCP_ALLOWED_SCHEMAS ?? '').trim();
  if (!allowedSchemas) {
    return null;
  }

  const args = argsEnv.split(' ').filter((arg) => arg.trim().length > 0);

  return {
    transport: 'stdio',
    command,
    args,
    env: buildMcpStdioEnv(allowedSchemas),
  };
}

function buildMcpStdioEnv(resolvedAllowedSchemas: string): Record<string, string> {
  const sanitizedEnv = Object.entries(process.env).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') {
      acc[key] = value;
    }
    return acc;
  }, {});

  sanitizedEnv.ALLOWED_SCHEMAS = resolvedAllowedSchemas;

  const criticalDbKeys = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'] as const;
  for (const key of criticalDbKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      sanitizedEnv[key] = value;
    }
  }

  return sanitizedEnv;
}
