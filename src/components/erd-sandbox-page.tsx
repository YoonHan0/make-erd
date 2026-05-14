'use client';

import { CSSProperties, useMemo, useState } from 'react';
import Link from 'next/link';
import { MermaidPreview } from '@/components/mermaid-preview';
import type { AnalyzedTable, Relationship } from '@/domain/types';
import { inferRelationshipsFromTableMetadata } from '@/analyzer/relationship-heuristics';
import { renderMermaidErd } from '@/renderer/render-mermaid';

type SandboxTable = {
  id: string;
  name: string;
  primaryKeys: string;
};

type McpHealthResult = {
  ok: boolean;
  configured: boolean;
  transport?: 'http' | 'stdio';
  target?: string;
  toolCount?: number;
  tools?: string[];
  message: string;
};

type ProxyMcpHealthResult = {
  ok: boolean;
  configured: boolean;
  target?: string;
  message: string;
  resultCode?: number;
  resultMsg?: string;
  resultData?: {
    status?: 'ok' | 'error';
    connected?: boolean;
    sessionId?: string;
    url?: string;
    elapsedMs?: number;
    error?: string;
  };
};

const DEFAULT_TABLES: SandboxTable[] = [
  { id: 'table-1', name: 'ORDER_HEADER', primaryKeys: 'CO_CD, ORDER_NO' },
  { id: 'table-2', name: 'ORDER_DETAIL', primaryKeys: 'CO_CD, ORDER_NO, SEQ' },
  { id: 'table-3', name: 'SDIV', primaryKeys: 'CO_CD, DIV_CD' },
];

export function ErdSandboxPage() {
  const [tables, setTables] = useState<SandboxTable[]>(DEFAULT_TABLES);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpResult, setMcpResult] = useState<McpHealthResult | null>(null);
  const [proxyMcpLoading, setProxyMcpLoading] = useState(false);
  const [proxyMcpResult, setProxyMcpResult] = useState<ProxyMcpHealthResult | null>(null);

  const analyzedTables = useMemo<AnalyzedTable[]>(() => {
    return tables
      .map((table): AnalyzedTable | null => {
        const name = table.name.trim();
        if (!name) {
          return null;
        }

        const primaryKeys = parseCsv(table.primaryKeys);

        return {
          fullName: name,
          tableName: name,
          aliases: [] as string[],
          sources: ['sandbox'],
          metadata: {
            fullName: name,
            tableName: name,
            columns: primaryKeys,
            primaryKeys,
            indexes: [] as string[],
            foreignKeys: [],
          },
        };
      })
      .filter((table): table is AnalyzedTable => table !== null);
  }, [tables]);

  const analyzedRelationships = useMemo<Relationship[]>(
    () => inferRelationshipsFromTableMetadata(analyzedTables),
    [analyzedTables],
  );

  const mermaid = useMemo(() => {
    if (analyzedTables.length === 0) {
      return 'erDiagram\n  EMPTY_TABLE {\n    string ADD_TABLE_FIRST\n  }\n';
    }
    return renderMermaidErd(analyzedTables, analyzedRelationships);
  }, [analyzedRelationships, analyzedTables]);

  async function handleCheckMcpConnection() {
    setMcpLoading(true);
    setMcpResult(null);

    try {
      const response = await fetch('/api/mcp/health');
      const payload = (await response.json()) as McpHealthResult;
      setMcpResult(payload);
    } catch (error) {
      setMcpResult({
        ok: false,
        configured: true,
        message: error instanceof Error ? error.message : 'MCP 연결 확인 중 오류가 발생했습니다.',
      });
    } finally {
      setMcpLoading(false);
    }
  }

  async function handleCheckProxyMcpConnection() {
    setProxyMcpLoading(true);
    setProxyMcpResult(null);

    try {
      const response = await fetch('/api/mcp/proxy-health', {
        method: 'POST',
      });
      const payload = (await response.json()) as ProxyMcpHealthResult;
      setProxyMcpResult(payload);
    } catch (error) {
      setProxyMcpResult({
        ok: false,
        configured: true,
        message: error instanceof Error ? error.message : '프록시 서버 연결 확인 중 오류가 발생했습니다.',
      });
    } finally {
      setProxyMcpLoading(false);
    }
  }

  function addTable() {
    const nextId = `table-${Date.now()}`;
    setTables((current) => [...current, { id: nextId, name: '', primaryKeys: '' }]);
  }

  function removeTable(tableId: string) {
    setTables((current) => current.filter((table) => table.id !== tableId));
  }

  function updateTable(tableId: string, key: 'name' | 'primaryKeys', value: string) {
    setTables((current) => current.map((table) => (table.id === tableId ? { ...table, [key]: value } : table)));
  }

  return (
    <main style={styles.page}>
      <section style={styles.hero}>
        <span style={styles.badge}>Sandbox</span>
        <h1 style={styles.title}>MCP 연결 확인 + ERD 테스트 페이지</h1>
        <p style={styles.description}>
          실제 분석 전, MCP 연결 상태를 점검하고 테이블/PK만 설계하면 프로젝트 규칙으로 관계를 자동 추론해 ERD 생성 결과를
          빠르게 검증할 수 있습니다.
        </p>
        <div>
          <Link href="/" style={styles.secondaryLinkButton}>
            메인 화면으로 이동
          </Link>
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.sectionHeader}>
          <h2 style={styles.sectionTitle}>MCP 연결 테스트</h2>
          <div style={styles.buttonStack}>
            <button type="button" style={styles.primaryButton} onClick={handleCheckMcpConnection} disabled={mcpLoading}>
              {mcpLoading ? '확인 중...' : '연결 확인'}
            </button>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={handleCheckProxyMcpConnection}
              disabled={proxyMcpLoading}
            >
              {proxyMcpLoading ? '확인 중...' : '프록시 서버 연결 확인'}
            </button>
          </div>
        </div>

        <p style={styles.helperText}>MCP_URL 또는 MCP_COMMAND/MCP_ARGS 설정 기준으로 서버 연결을 확인합니다.</p>

        {mcpResult ? (
          <div style={{ ...styles.statusBox, ...(mcpResult.ok ? styles.statusSuccess : styles.statusError) }}>
            <strong>{mcpResult.ok ? '연결 성공' : '연결 실패'}</strong>
            <span style={styles.helperText}>메시지: {mcpResult.message}</span>
            <span style={styles.helperText}>설정 여부: {mcpResult.configured ? '설정됨' : '미설정'}</span>
            {mcpResult.transport ? <span style={styles.helperText}>전송 방식: {mcpResult.transport}</span> : null}
            {mcpResult.target ? <span style={styles.helperText}>대상: {mcpResult.target}</span> : null}
            {typeof mcpResult.toolCount === 'number' ? (
              <span style={styles.helperText}>사용 가능 도구 수: {mcpResult.toolCount}</span>
            ) : null}
            {mcpResult.tools && mcpResult.tools.length > 0 ? (
              <span style={styles.helperText}>도구: {mcpResult.tools.slice(0, 8).join(', ')}</span>
            ) : null}
          </div>
        ) : null}

          {proxyMcpResult ? (
            <div style={{ ...styles.statusBox, ...(proxyMcpResult.ok ? styles.statusSuccess : styles.statusError) }}>
              <strong>{proxyMcpResult.ok ? '프록시 연결 성공' : '프록시 연결 실패'}</strong>
              <span style={styles.helperText}>메시지: {proxyMcpResult.message}</span>
              <span style={styles.helperText}>설정 여부: {proxyMcpResult.configured ? '설정됨' : '미설정'}</span>
              {proxyMcpResult.target ? <span style={styles.helperText}>대상: {proxyMcpResult.target}</span> : null}
              {typeof proxyMcpResult.resultCode === 'number' ? (
                <span style={styles.helperText}>resultCode: {proxyMcpResult.resultCode}</span>
              ) : null}
              {proxyMcpResult.resultMsg ? <span style={styles.helperText}>resultMsg: {proxyMcpResult.resultMsg}</span> : null}
              {proxyMcpResult.resultData ? (
                <>
                  {typeof proxyMcpResult.resultData.connected === 'boolean' ? (
                    <span style={styles.helperText}>
                      connected: {proxyMcpResult.resultData.connected ? 'true' : 'false'}
                    </span>
                  ) : null}
                  {proxyMcpResult.resultData.status ? (
                    <span style={styles.helperText}>status: {proxyMcpResult.resultData.status}</span>
                  ) : null}
                  {proxyMcpResult.resultData.sessionId ? (
                    <span style={styles.helperText}>sessionId: {proxyMcpResult.resultData.sessionId}</span>
                  ) : null}
                  {proxyMcpResult.resultData.url ? (
                    <span style={styles.helperText}>url: {proxyMcpResult.resultData.url}</span>
                  ) : null}
                  {typeof proxyMcpResult.resultData.elapsedMs === 'number' ? (
                    <span style={styles.helperText}>elapsedMs: {proxyMcpResult.resultData.elapsedMs}</span>
                  ) : null}
                  {proxyMcpResult.resultData.error ? (
                    <span style={styles.helperText}>error: {proxyMcpResult.resultData.error}</span>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
      </section>

      <section style={styles.grid}>
        <section style={styles.card}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>테이블 설계</h2>
            <button type="button" style={styles.secondaryButton} onClick={addTable}>
              + 테이블 추가
            </button>
          </div>

          <div style={styles.stack}>
            {tables.map((table, index) => (
              <article key={table.id} style={styles.item}>
                <div style={styles.itemHeader}>
                  <strong>테이블 {index + 1}</strong>
                  <button type="button" style={styles.linkButton} onClick={() => removeTable(table.id)}>
                    삭제
                  </button>
                </div>
                <label style={styles.label}>
                  테이블명
                  <input
                    value={table.name}
                    onChange={(event) => updateTable(table.id, 'name', event.target.value)}
                    placeholder="예: ABDOCU_BUDGETSUM"
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  PK 컬럼(쉼표 구분)
                  <input
                    value={table.primaryKeys}
                    onChange={(event) => updateTable(table.id, 'primaryKeys', event.target.value)}
                    placeholder="예: CO_CD, DOCU_NO, SEQ"
                    style={styles.input}
                  />
                </label>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>자동 추론된 관계</h2>
        {analyzedRelationships.length === 0 ? (
          <span style={styles.helperText}>아직 추론 가능한 관계가 없습니다. 테이블명과 PK를 보강해 주세요.</span>
        ) : (
          <div style={styles.stack}>
            {analyzedRelationships.map((relationship, index) => (
              <article key={`${relationship.fromTable}-${relationship.toTable}-${relationship.fromColumn}-${relationship.toColumn}`} style={styles.item}>
                <strong>
                  {index + 1}. {relationship.fromTable}.{relationship.fromColumn} → {relationship.toTable}.{relationship.toColumn}
                </strong>
                <span style={styles.helperText}>
                  {relationship.cardinality} / {relationship.confidence}
                </span>
                <span style={styles.helperText}>{relationship.reason}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>ERD 미리보기</h2>
        <MermaidPreview chart={mermaid} title="Sandbox Mermaid ERD" />
        <pre style={styles.pre}>{mermaid}</pre>
      </section>
    </main>
  );
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const styles: Record<string, CSSProperties> = {
  page: {
    width: '100%',
    maxWidth: 1400,
    margin: '0 auto',
    padding: '48px 24px 72px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  hero: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  badge: {
    width: 'fit-content',
    padding: '8px 12px',
    borderRadius: 999,
    background: 'rgba(59, 130, 246, 0.16)',
    border: '1px solid rgba(96, 165, 250, 0.35)',
    color: '#bfdbfe',
    fontSize: 13,
    fontWeight: 600,
  },
  title: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.2,
    color: '#f8fafc',
  },
  description: {
    margin: 0,
    color: '#b6c2d9',
    fontSize: 15,
    lineHeight: 1.6,
    maxWidth: 860,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 20,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 20,
    borderRadius: 20,
    border: '1px solid rgba(148, 163, 184, 0.2)',
    background: 'rgba(15, 23, 42, 0.82)',
    boxShadow: '0 18px 44px rgba(15, 23, 42, 0.32)',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  sectionTitle: {
    margin: 0,
    fontSize: 20,
    color: '#f8fafc',
  },
  helperText: {
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 1.5,
  },
  statusBox: {
    borderRadius: 14,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  statusSuccess: {
    border: '1px solid rgba(34, 197, 94, 0.35)',
    background: 'rgba(22, 101, 52, 0.22)',
    color: '#bbf7d0',
  },
  statusError: {
    border: '1px solid rgba(248, 113, 113, 0.35)',
    background: 'rgba(127, 29, 29, 0.28)',
    color: '#fecaca',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    border: '1px solid rgba(148, 163, 184, 0.16)',
    borderRadius: 14,
    background: 'rgba(2, 6, 23, 0.65)',
    padding: 12,
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: '#e2e8f0',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    color: '#cbd5e1',
    fontSize: 13,
  },
  input: {
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 10,
    background: '#020617',
    color: '#e2e8f0',
    padding: '10px 12px',
  },
  primaryButton: {
    border: 'none',
    borderRadius: 12,
    background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
    color: '#f8fafc',
    padding: '10px 14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 12,
    background: 'transparent',
    color: '#dbeafe',
    padding: '10px 12px',
    cursor: 'pointer',
  },
  secondaryLinkButton: {
    display: 'inline-flex',
    alignItems: 'center',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 12,
    background: 'transparent',
    color: '#dbeafe',
    padding: '10px 12px',
    cursor: 'pointer',
    textDecoration: 'none',
  },
  linkButton: {
    border: 'none',
    background: 'transparent',
    color: '#93c5fd',
    cursor: 'pointer',
    padding: 0,
    fontSize: 13,
  },
  pre: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderRadius: 14,
    background: '#020617',
    border: '1px solid rgba(148, 163, 184, 0.12)',
    padding: 16,
    color: '#e2e8f0',
    lineHeight: 1.6,
    overflowX: 'auto',
  },
};
