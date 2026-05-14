'use client';

import {
  CSSProperties,
  ChangeEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import type { AcceptedQuerySource, AnalysisResult } from '@/domain/types';
import { MermaidPreview } from '@/components/mermaid-preview';
import { renderMermaidErd } from '@/renderer/render-mermaid';

const SAMPLE_SQL = `SELECT *
FROM \${dbErp}.주문 o
JOIN \${dbErp}.주문상세 od ON o.id = od.orderId
JOIN \${dbErp}.고객 c ON o.customerId = c.id`;

type SectionKey = 'tables' | 'relationships' | 'mermaid' | 'details';

type ProxyBatchTestResult = {
  ok: boolean;
  message: string;
  tableCount: number;
  proxyStatus?: number;
  proxyTarget?: string;
  proxyResponse?: unknown;
};

const INITIAL_COLLAPSED_SECTIONS: Record<SectionKey, boolean> = {
  tables: false,
  relationships: false,
  mermaid: false,
  details: false,
};

export function QueryWorkbench() {
  const [sqlText, setSqlText] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [selectedTableFullName, setSelectedTableFullName] = useState<string | null>(null);
  const [expandedTableDetails, setExpandedTableDetails] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProxyTestLoading, setIsProxyTestLoading] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyBatchTestResult | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState(INITIAL_COLLAPSED_SECTIONS);
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [pendingDuplicateAction, setPendingDuplicateAction] = useState<'analysis' | 'proxy' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileSummary = useMemo(() => {
    if (selectedFiles.length === 0) {
      return '';
    }

    if (selectedFiles.length === 1) {
      return selectedFiles[0].name;
    }

    return `${selectedFiles.length}개 파일 선택됨`;
  }, [selectedFiles]);

  const selectedQuerySources = useMemo(() => getSelectedQuerySources(result), [result]);
  const effectiveSelectedTable = useMemo(() => {
    if (!result || result.tables.length === 0) {
      return null;
    }

    if (selectedTableFullName && result.tables.some((table) => table.fullName === selectedTableFullName)) {
      return selectedTableFullName;
    }

    return result.tables[0].fullName;
  }, [result, selectedTableFullName]);

  const focusedRelationships = useMemo(() => {
    if (!result || !effectiveSelectedTable) {
      return [];
    }

    return result.relationships.filter(
      (relationship) =>
        relationship.fromTable === effectiveSelectedTable || relationship.toTable === effectiveSelectedTable,
    );
  }, [effectiveSelectedTable, result]);

  const focusedInferredRelationships = useMemo(() => {
    return focusedRelationships.filter((relationship) => relationship.confidence === 'inferred');
  }, [focusedRelationships]);

  const focusedTables = useMemo(() => {
    if (!result || !effectiveSelectedTable) {
      return [];
    }

    const focusedNames = new Set<string>([effectiveSelectedTable]);
    for (const relationship of focusedRelationships) {
      focusedNames.add(relationship.fromTable);
      focusedNames.add(relationship.toTable);
    }

    return result.tables.filter((table) => focusedNames.has(table.fullName));
  }, [effectiveSelectedTable, focusedRelationships, result]);

  const focusedMermaid = useMemo(() => {
    if (!result) {
      return '';
    }

    if (focusedTables.length === 0) {
      return result.mermaid;
    }

    return renderMermaidErd(focusedTables, focusedRelationships);
  }, [focusedRelationships, focusedTables, result]);
  const uploadHintId = 'upload-hint';

  useEffect(() => {
    if (!result || result.tables.length === 0) {
      setSelectedTableFullName(null);
      return;
    }

    if (!selectedTableFullName || !result.tables.some((table) => table.fullName === selectedTableFullName)) {
      setSelectedTableFullName(result.tables[0].fullName);
    }
  }, [result, selectedTableFullName]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (hasDuplicateInput()) {
      setPendingDuplicateAction('analysis');
      setShowDuplicateConfirm(true);
      return;
    }

    if (hasAnyInput()) {
      executeAnalysis();
    }
  }

  async function executeAnalysis(options?: { preserveProxyTestResult?: boolean }) {
    setIsLoading(true);
    setError(null);
    if (!options?.preserveProxyTestResult) {
      setProxyTestResult(null);
    }
    setShowDuplicateConfirm(false);

    try {
      const formData = new FormData();
      formData.append('sqlText', sqlText);
      for (const file of selectedFiles) {
        formData.append('files', file);
      }

      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as AnalysisResult | { message: string };
      if (!response.ok) {
        throw new Error('message' in payload ? payload.message : '분석 요청에 실패했습니다.');
      }

      setResult(payload as AnalysisResult);
      setSelectedTableFullName(null);
      setExpandedTableDetails({});
      setCollapsedSections(INITIAL_COLLAPSED_SECTIONS);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '분석 요청에 실패했습니다.');
      setResult(null);
      setSelectedTableFullName(null);
      setExpandedTableDetails({});
    } finally {
      setIsLoading(false);
    }
  }

  function handleProxyBatchTest() {
    if (hasDuplicateInput()) {
      setPendingDuplicateAction('proxy');
      setShowDuplicateConfirm(true);
      return;
    }

    if (hasAnyInput()) {
      executeProxyBatchTest();
    }
  }

  function handleDuplicateConfirm() {
    setShowDuplicateConfirm(false);

    if (pendingDuplicateAction === 'analysis') {
      setPendingDuplicateAction(null);
      executeAnalysis();
      return;
    }

    if (pendingDuplicateAction === 'proxy') {
      setPendingDuplicateAction(null);
      executeProxyBatchTest();
      return;
    }

    setPendingDuplicateAction(null);
  }

  async function executeProxyBatchTest() {
    setIsProxyTestLoading(true);
    setProxyTestResult(null);

    try {
      const formData = new FormData();
      formData.append('sqlText', sqlText);
      for (const file of selectedFiles) {
        formData.append('files', file);
      }

      const response = await fetch('/api/analyze/proxy-test', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as ProxyBatchTestResult | { message: string };
      if (!response.ok) {
        throw new Error('message' in payload ? payload.message : '프록시 배치 테스트 요청에 실패했습니다.');
      }

      const successPayload = payload as ProxyBatchTestResult;
      setProxyTestResult({
        ok: successPayload.ok,
        message: successPayload.message,
        tableCount: successPayload.tableCount,
        proxyStatus: successPayload.proxyStatus,
        proxyTarget: successPayload.proxyTarget,
        proxyResponse: successPayload.proxyResponse,
      });

      if (successPayload.ok) {
        await executeAnalysis({ preserveProxyTestResult: true });
      } else {
        clearAnalysisResultView();
      }
    } catch (testError) {
      setProxyTestResult({
        ok: false,
        message: testError instanceof Error ? testError.message : '프록시 배치 테스트 요청에 실패했습니다.',
        tableCount: 0,
        proxyResponse: null,
      });
      clearAnalysisResultView();
    } finally {
      setIsProxyTestLoading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setSelectedFiles((currentFiles) => mergeFiles(currentFiles, nextFiles));
    event.target.value = '';
  }

  function handleResetEditor() {
    setSqlText('');
  }

  function clearAnalysisResultView() {
    setResult(null);
    setSelectedTableFullName(null);
    setExpandedTableDetails({});
    setCollapsedSections(INITIAL_COLLAPSED_SECTIONS);
  }

  function handleClearResults() {
    clearAnalysisResultView();
    setError(null);
    setProxyTestResult(null);
  }

  function handleToggleSection(section: SectionKey) {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  function handleToggleTableDetail(tableFullName: string) {
    setExpandedTableDetails((current) => ({
      ...current,
      [tableFullName]: !current[tableFullName],
    }));
  }

  function handleTableCardKeyDown(event: KeyboardEvent<HTMLElement>, tableFullName: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedTableFullName(tableFullName);
    }
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function clearSelectedFiles() {
    setSelectedFiles([]);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingFile(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingFile(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();

    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingFile(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingFile(false);
    setSelectedFiles((currentFiles) => mergeFiles(currentFiles, Array.from(event.dataTransfer.files ?? [])));
  }

  function handleUploadKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  }

  function hasAnyInput(): boolean {
    return sqlText.trim().length > 0 || selectedFiles.length > 0;
  }

  function hasDuplicateInput(): boolean {
    return sqlText.trim().length > 0 && selectedFiles.length > 0;
  }

  function shouldShowProxyFailureResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }

    return (value as { resultCode?: unknown }).resultCode === -1;
  }

  function formatProxyResponse(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return (
    <main style={styles.page}>
      <section style={styles.hero}>
        <span style={styles.badge}>Next.js SQL ERD Workbench</span>
        <h1 style={styles.heading}>테이블 관계를 확인해 보세요.</h1>
        <p style={styles.description}>
          SQL을 직접 입력하거나 파일을 업로드하면, 사용 테이블 목록과 관계 추론 결과, Mermaid ERD를 한 번에 확인할 수
          있습니다.
        </p>
        <div>
          <Link href="/sandbox" style={styles.secondaryButtonLink}>
            MCP 연결/ERD 샌드박스 열기
          </Link>
        </div>
      </section>

      <form onSubmit={handleSubmit} style={styles.grid}>
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <h2 style={styles.cardTitle}>직접 입력</h2>
            <div style={styles.buttonGroup}>
              <button type="button" style={styles.secondaryButton} onClick={handleResetEditor}>
                초기화
              </button>
              <button type="button" style={styles.secondaryButton} onClick={() => setSqlText(SAMPLE_SQL)}>
                예시 채우기
              </button>
            </div>
          </div>
          <textarea
            value={sqlText}
            onChange={(event) => setSqlText(event.target.value)}
            placeholder="여기에 SQL을 입력하세요."
            style={styles.textarea}
            spellCheck={false}
          />
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <h2 style={styles.cardTitle}>파일 업로드</h2>
            <span style={styles.helperText}>.sql, .txt, .xml 파일 여러 개 업로드 가능</span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.txt,.xml,text/plain,text/xml,application/xml"
            multiple
            onChange={handleFileChange}
            style={styles.input}
          />

          <div
            style={{
              ...styles.uploadArea,
              ...(isDraggingFile ? styles.uploadAreaActive : {}),
            }}
            onClick={openFilePicker}
            onKeyDown={handleUploadKeyDown}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            aria-label="파일 업로드 영역"
            aria-describedby={uploadHintId}
          >
            <div style={styles.uploadIconWrap} aria-hidden="true">
              <FileOutlineIcon />
            </div>
            <div style={styles.uploadCopy}>
              <span style={styles.uploadLabel}>파일 업로드</span>
              {/* <span id={uploadHintId} style={styles.uploadHint}>
                클릭 또는 드래그
              </span> */}
              {/* <span style={styles.uploadMeta}>지원: .sql, .txt, .xml</span> */}
              {fileSummary ? <span style={styles.uploadMeta}>{fileSummary}</span> : null}
            </div>
          </div>

          <div style={styles.buttonGroup}>
            <button type="button" style={styles.secondaryButton} onClick={openFilePicker}>
              파일 선택
            </button>
            {selectedFiles.length > 0 ? (
              <button type="button" style={styles.secondaryButton} onClick={clearSelectedFiles}>
                파일 비우기
              </button>
            ) : null}
          </div>

          <p style={styles.helperText}>
            업로드 파일에 여러 쿼리가 있으면 조회 계열만 자동으로 분리 분석하고, 나머지는 경고로 안내합니다.
          </p>

          <button
            type="submit"
            style={{
              ...styles.primaryButton,
              ...(isLoading || (sqlText.trim().length === 0 && selectedFiles.length === 0)
                ? styles.primaryButtonDisabled
                : {}),
            }}
            disabled={isLoading || (sqlText.trim().length === 0 && selectedFiles.length === 0)}
          >
            {isLoading ? '분석 중...' : '분석 실행'}
          </button>

          <button
            type="button"
            style={{
              ...styles.testButton,
              ...(isProxyTestLoading || isLoading || (sqlText.trim().length === 0 && selectedFiles.length === 0)
                ? styles.primaryButtonDisabled
                : {}),
            }}
            onClick={handleProxyBatchTest}
            disabled={isProxyTestLoading || isLoading || (sqlText.trim().length === 0 && selectedFiles.length === 0)}
          >
            {isProxyTestLoading ? '프록시 테스트 중...' : '프록시 배치 테스트'}
          </button>

          {proxyTestResult ? (
            <div style={proxyTestResult.ok ? styles.testResultSuccessBox : styles.testResultErrorBox}>
              <strong>{proxyTestResult.ok ? '프록시 테스트 성공' : '프록시 테스트 실패'}</strong>
              <span style={styles.helperText}>{proxyTestResult.message}</span>
              <span style={styles.helperText}>테이블 수: {proxyTestResult.tableCount}</span>
              {proxyTestResult.proxyStatus ? (
                <span style={styles.helperText}>프록시 응답 상태: {proxyTestResult.proxyStatus}</span>
              ) : null}
              {proxyTestResult.proxyTarget ? (
                <span style={styles.helperText}>프록시 URL: {proxyTestResult.proxyTarget}</span>
              ) : null}
              {shouldShowProxyFailureResponse(proxyTestResult.proxyResponse) ? (
                <div style={styles.proxyResponseBox}>
                  <strong style={styles.proxyResponseTitle}>응답 결과</strong>
                  <pre style={styles.proxyResponsePre}>{formatProxyResponse(proxyTestResult.proxyResponse)}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </form>

      {error ? (
        <section style={styles.errorBox}>
          <strong>오류</strong>
          <div>{error}</div>
        </section>
      ) : null}

      {result ? (
        <section style={styles.results}>
          <div style={styles.resultsHeader}>
            <span style={styles.helperText}>분석 결과가 화면에 표시되고 있습니다.</span>
            <button
              type="button"
              style={styles.resultClearButton}
              onClick={handleClearResults}
              aria-label="분석 결과 화면 비우기"
            >
              ↻ 결과 비우기
            </button>
          </div>

          {selectedQuerySources.length > 0 ? (
            <section style={styles.card}>
              <div style={styles.sectionHeader}>
                <h2 style={styles.cardTitle}>선택된 Query ID</h2>
                <span style={styles.helperText}>{selectedQuerySources.length}개</span>
              </div>
              <div style={styles.chipList}>
                {selectedQuerySources.map((querySource) => (
                  <article key={`${querySource.sourceName}-${querySource.queryId}`} style={styles.chipCard}>
                    <strong>{querySource.queryId}</strong>
                    <span style={styles.helperText}>{querySource.documentName}</span>
                    {querySource.tagName ? <span style={styles.helperText}>태그: {querySource.tagName}</span> : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {result.warnings.length > 0 ? (
            <section style={styles.warningBox}>
              <strong>주의</strong>
              <div style={styles.list}>
                {result.warnings.map((warning) => (
                  <span key={warning} style={styles.helperText}>
                    - {warning}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <div style={styles.resultGrid}>
            <CollapsibleSection
              title="사용 테이블"
              collapsed={collapsedSections.tables}
              onToggle={() => handleToggleSection('tables')}
            >
              <div style={styles.list}>
                {result.tables.map((table) => (
                  <article
                    key={table.fullName}
                    style={{
                      ...styles.item,
                      ...styles.itemClickable,
                      ...(effectiveSelectedTable === table.fullName ? styles.itemSelected : {}),
                    }}
                    onClick={() => setSelectedTableFullName(table.fullName)}
                    onKeyDown={(event) => handleTableCardKeyDown(event, table.fullName)}
                    role="button"
                    tabIndex={0}
                    aria-pressed={effectiveSelectedTable === table.fullName}
                    aria-label={`${table.fullName} 테이블 선택`}
                  >
                    <div style={styles.tableHeaderRow}>
                      <strong>{table.fullName}</strong>
                      <button
                        type="button"
                        style={styles.iconButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleTableDetail(table.fullName);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                        aria-label={`${table.fullName} 상세 정보 토글`}
                        aria-expanded={Boolean(expandedTableDetails[table.fullName])}
                        title="상세 정보"
                      >
                        <SearchIcon />
                      </button>
                    </div>
                    <span style={styles.helperText}>출처: {table.sources.join(', ')}</span>
                    <span style={styles.helperText}>
                      별칭: {table.aliases.length > 0 ? table.aliases.join(', ') : '(없음)'}
                    </span>

                    {expandedTableDetails[table.fullName] ? (
                      table.metadata ? (
                        <div style={styles.tableDetailBox}>
                          <span style={styles.helperText}>컬럼: {table.metadata.columns.join(', ') || '(없음)'}</span>
                          <span style={styles.helperText}>PK: {table.metadata.primaryKeys.join(', ') || '(없음)'}</span>
                          <span style={styles.helperText}>인덱스: {table.metadata.indexes.join(', ') || '(없음)'}</span>
                          <span style={styles.helperText}>FK:</span>
                          {table.metadata.foreignKeys.length === 0 ? (
                            <span style={styles.helperText}>- (없음)</span>
                          ) : (
                            table.metadata.foreignKeys.map((foreignKey) => (
                              <span
                                key={`${table.fullName}-${foreignKey.column}-${foreignKey.referencesTable}-${foreignKey.referencesColumn}`}
                                style={styles.helperText}
                              >
                                - {foreignKey.column} → {foreignKey.referencesTable}.{foreignKey.referencesColumn}
                              </span>
                            ))
                          )}
                        </div>
                      ) : (
                        <span style={styles.helperText}>MCP 메타데이터가 없습니다.</span>
                      )
                    ) : null}
                  </article>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="추론된 관계"
              collapsed={collapsedSections.relationships}
              onToggle={() => handleToggleSection('relationships')}
            >
              <div style={styles.list}>
                {focusedInferredRelationships.length === 0 ? (
                  <div style={styles.helperText}>
                    {effectiveSelectedTable
                      ? `${effectiveSelectedTable}와 연결된 추론된 관계가 없습니다.`
                      : '관계가 추론되지 않았습니다.'}
                  </div>
                ) : (
                  focusedInferredRelationships.map((relationship) => (
                    <article
                      key={[
                        relationship.sourceName,
                        relationship.fromTable,
                        relationship.fromColumn,
                        relationship.toTable,
                        relationship.toColumn,
                      ].join('|')}
                      style={styles.item}
                    >
                      <strong>
                        {relationship.fromTable}.{relationship.fromColumn} → {relationship.toTable}.{relationship.toColumn}
                      </strong>
                      <span style={styles.helperText}>
                        {relationship.cardinality} / {relationship.confidence}
                      </span>
                      <span style={styles.helperText}>{relationship.reason}</span>
                    </article>
                  ))
                )}
              </div>
            </CollapsibleSection>
          </div>

          <CollapsibleSection
            title="Mermaid ERD"
            collapsed={collapsedSections.mermaid}
            onToggle={() => handleToggleSection('mermaid')}
          >
            {effectiveSelectedTable ? (
              <span style={styles.helperText}>
                기준 테이블: {effectiveSelectedTable} / 표시 테이블 {focusedTables.length}개, 관계 {focusedRelationships.length}개
              </span>
            ) : null}
            <MermaidPreview chart={focusedMermaid} title="Mermaid ERD" />
          </CollapsibleSection>

          <CollapsibleSection
            title="리포트 / Mermaid 원문"
            collapsed={collapsedSections.details}
            onToggle={() => handleToggleSection('details')}
          >
            <div style={styles.innerGrid}>
              <div style={styles.innerPanel}>
                <h3 style={styles.subTitle}>리포트</h3>
                <pre style={styles.pre}>{result.report}</pre>
              </div>

              <div style={styles.innerPanel}>
                <h3 style={styles.subTitle}>Mermaid 원문</h3>
                <pre style={styles.pre}>{focusedMermaid}</pre>
              </div>
            </div>
          </CollapsibleSection>
        </section>
      ) : null}

      {showDuplicateConfirm ? (
        <DuplicateDataConfirmDialog
          onConfirm={handleDuplicateConfirm}
          onCancel={() => {
            setPendingDuplicateAction(null);
            setShowDuplicateConfirm(false);
          }}
        />
      ) : null}
    </main>
  );
}

interface CollapsibleSectionProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function CollapsibleSection({ title, collapsed, onToggle, children }: CollapsibleSectionProps) {
  return (
    <section style={styles.card}>
      <div style={styles.sectionHeader}>
        <h2 style={styles.cardTitle}>{title}</h2>
        <button type="button" style={styles.secondaryButton} onClick={onToggle} aria-expanded={!collapsed}>
          {collapsed ? '펼치기' : '접기'}
        </button>
      </div>
      {collapsed ? <span style={styles.helperText}>필요할 때 다시 펼쳐서 확인할 수 있습니다.</span> : children}
    </section>
  );
}

function getSelectedQuerySources(result: AnalysisResult | null): AcceptedQuerySource[] {
  if (!result) {
    return [];
  }

  return result.acceptedQuerySources.filter((source) => Boolean(source.queryId));
}

function mergeFiles(currentFiles: File[], nextFiles: File[]): File[] {
  const fileMap = new Map<string, File>();

  for (const file of [...currentFiles, ...nextFiles]) {
    fileMap.set(`${file.name}-${file.size}-${file.lastModified}`, file);
  }

  return [...fileMap.values()];
}

const styles: Record<string, CSSProperties> = {
  page: {
    width: '100%',
    maxWidth: 1400,
    margin: '0 auto',
    padding: '48px 24px 72px',
  },
  hero: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 32,
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
  heading: {
    margin: 0,
    fontSize: 36,
    lineHeight: 1.15,
  },
  description: {
    margin: 0,
    color: '#b6c2d9',
    fontSize: 16,
    maxWidth: 860,
    lineHeight: 1.6,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 20,
    alignItems: 'stretch',
  },
  results: {
    marginTop: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  resultsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  resultGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 20,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 20,
    borderRadius: 20,
    border: '1px solid rgba(148, 163, 184, 0.2)',
    background: 'rgba(15, 23, 42, 0.82)',
    boxShadow: '0 18px 44px rgba(15, 23, 42, 0.32)',
    minHeight: 0,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  buttonGroup: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardTitle: {
    margin: 0,
    fontSize: 20,
  },
  helperText: {
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 1.5,
  },
  uploadIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(30, 41, 59, 0.8)',
    border: '1px solid rgba(96, 165, 250, 0.18)',
    color: '#bfdbfe',
    flexShrink: 0,
  },
  uploadCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  textarea: {
    minHeight: 360,
    width: '100%',
    resize: 'vertical',
    borderRadius: 16,
    border: '1px solid rgba(148, 163, 184, 0.22)',
    background: '#020617',
    color: '#e2e8f0',
    padding: 16,
    lineHeight: 1.6,
  },
  uploadArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    border: '1px dashed rgba(125, 211, 252, 0.35)',
    borderRadius: 16,
    padding: 18,
    background: 'rgba(2, 6, 23, 0.56)',
    cursor: 'pointer',
    transition: 'border-color 0.2s ease, background 0.2s ease, transform 0.2s ease',
  },
  uploadAreaActive: {
    border: '1px dashed rgba(96, 165, 250, 0.92)',
    background: 'rgba(15, 23, 42, 0.96)',
    transform: 'translateY(-1px)',
  },
  uploadLabel: {
    fontWeight: 600,
    color: '#e2e8f0',
    fontSize: 15,
  },
  uploadMeta: {
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word',
    fontSize: 13,
  },
  uploadHint: {
    color: '#cbd5e1',
    lineHeight: 1.5,
    wordBreak: 'break-word',
    fontSize: 13,
  },
  input: {
    display: 'none',
  },
  primaryButton: {
    border: 'none',
    borderRadius: 14,
    background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
    color: '#f8fafc',
    padding: '14px 18px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  testButton: {
    border: '1px solid rgba(125, 211, 252, 0.5)',
    borderRadius: 14,
    background: 'rgba(15, 23, 42, 0.82)',
    color: '#bae6fd',
    padding: '12px 16px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  primaryButtonDisabled: {
    background: 'rgba(148, 163, 184, 0.3)',
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  secondaryButton: {
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 12,
    background: 'transparent',
    color: '#dbeafe',
    padding: '10px 12px',
    cursor: 'pointer',
  },
  secondaryButtonLink: {
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
  resultClearButton: {
    border: '1px solid rgba(148, 163, 184, 0.18)',
    borderRadius: 999,
    background: 'rgba(2, 6, 23, 0.72)',
    color: '#cbd5e1',
    padding: '10px 14px',
    cursor: 'pointer',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  chipList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
  },
  chipCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '12px 14px',
    borderRadius: 14,
    background: 'rgba(2, 6, 23, 0.72)',
    border: '1px solid rgba(96, 165, 250, 0.18)',
    minWidth: 180,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 14,
    borderRadius: 14,
    background: 'rgba(2, 6, 23, 0.72)',
    border: '1px solid rgba(148, 163, 184, 0.12)',
  },
  itemClickable: {
    cursor: 'pointer',
  },
  itemSelected: {
    border: '1px solid rgba(96, 165, 250, 0.8)',
    boxShadow: 'inset 0 0 0 1px rgba(37, 99, 235, 0.35)',
  },
  tableHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  iconButton: {
    width: 32,
    height: 32,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 10,
    border: '1px solid rgba(148, 163, 184, 0.22)',
    background: 'rgba(15, 23, 42, 0.9)',
    color: '#dbeafe',
    cursor: 'pointer',
  },
  tableDetailBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 12,
    borderRadius: 12,
    background: 'rgba(15, 23, 42, 0.62)',
    border: '1px solid rgba(148, 163, 184, 0.16)',
  },
  innerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 16,
  },
  innerPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  subTitle: {
    margin: 0,
    fontSize: 17,
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
  errorBox: {
    marginTop: 20,
    borderRadius: 16,
    border: '1px solid rgba(248, 113, 113, 0.35)',
    background: 'rgba(127, 29, 29, 0.28)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    color: '#fecaca',
  },
  warningBox: {
    borderRadius: 16,
    border: '1px solid rgba(250, 204, 21, 0.28)',
    background: 'rgba(113, 63, 18, 0.26)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    color: '#fde68a',
  },
  testResultSuccessBox: {
    borderRadius: 14,
    border: '1px solid rgba(74, 222, 128, 0.4)',
    background: 'rgba(20, 83, 45, 0.22)',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    color: '#bbf7d0',
  },
  testResultErrorBox: {
    borderRadius: 14,
    border: '1px solid rgba(248, 113, 113, 0.35)',
    background: 'rgba(127, 29, 29, 0.22)',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    color: '#fecaca',
  },
  proxyResponseBox: {
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    border: '1px solid rgba(248, 113, 113, 0.26)',
    background: 'rgba(2, 6, 23, 0.46)',
  },
  proxyResponseTitle: {
    color: '#fecaca',
    fontSize: 14,
  },
  proxyResponsePre: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderRadius: 10,
    background: '#020617',
    border: '1px solid rgba(248, 113, 113, 0.16)',
    padding: 12,
    color: '#fee2e2',
    lineHeight: 1.6,
    overflowX: 'auto',
    fontSize: 13,
  },
  confirmOverlayStyle: {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(2, 6, 23, 0.86)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmModalStyle: {
    width: 'min(96vw, 420px)',
    borderRadius: 16,
    border: '1px solid rgba(148, 163, 184, 0.24)',
    background: 'rgba(15, 23, 42, 0.92)',
    boxShadow: '0 24px 60px rgba(2, 6, 23, 0.5)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  confirmHeaderStyle: {
    padding: '20px',
    borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
    color: '#e2e8f0',
  },
  confirmContentStyle: {
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  confirmTextStyle: {
    margin: 0,
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 1.6,
  },
  confirmButtonGroupStyle: {
    display: 'flex',
    gap: 8,
    padding: '16px 20px',
    borderTop: '1px solid rgba(148, 163, 184, 0.14)',
    justifyContent: 'flex-end',
  },
  confirmCancelButtonStyle: {
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 12,
    background: 'transparent',
    color: '#dbeafe',
    padding: '10px 16px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  confirmConfirmButtonStyle: {
    border: 'none',
    borderRadius: 12,
    background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
    color: '#f8fafc',
    padding: '10px 16px',
    cursor: 'pointer',
    fontWeight: 600,
  },
};

function FileOutlineIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3.75h5.5L18.25 8.5V20.25a.75.75 0 0 1-.75.75H8a.75.75 0 0 1-.75-.75V4.5A.75.75 0 0 1 8 3.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M13.5 3.75V8.5h4.75" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 12.25h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 15.25h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11 4.75a6.25 6.25 0 1 1 0 12.5a6.25 6.25 0 0 1 0-12.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

interface DuplicateDataConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function DuplicateDataConfirmDialog({ onConfirm, onCancel }: DuplicateDataConfirmDialogProps) {
  return (
    <div style={styles.confirmOverlayStyle} onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div style={styles.confirmModalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={styles.confirmHeaderStyle}>
          <strong id="confirm-title">데이터 중복 확인</strong>
        </div>
        <div style={styles.confirmContentStyle}>
          <p style={styles.confirmTextStyle}>
            직접 입력한 SQL과 업로드된 파일이 모두 포함되어 있습니다.
          </p>
          <p style={styles.confirmTextStyle}>
            두 데이터가 함께 분석되어 결과가 중복될 수 있습니다.
          </p>
          <p style={styles.confirmTextStyle}>
            그대로 진행하시겠습니까?
          </p>
        </div>
        <div style={styles.confirmButtonGroupStyle}>
          <button type="button" style={styles.confirmCancelButtonStyle} onClick={onCancel}>
            아니오
          </button>
          <button type="button" style={styles.confirmConfirmButtonStyle} onClick={onConfirm}>
            예
          </button>
        </div>
      </div>
    </div>
  );
}
