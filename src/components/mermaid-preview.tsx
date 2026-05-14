'use client';

import mermaid from 'mermaid';
import {
  CSSProperties,
  MouseEvent,
  PointerEvent,
  WheelEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

interface MermaidPreviewProps {
  chart: string;
  title?: string;
}

interface MermaidCanvasProps {
  chart: string;
  minHeight: number;
  interactive?: boolean;
}

interface SvgSize {
  width: number;
  height: number;
}

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
const ZOOM_STEP = 0.2;

export function MermaidPreview({ chart, title = 'Mermaid ERD' }: MermaidPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const instructionsId = useId();

  useEffect(() => {
    if (!isExpanded) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExpanded(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  function handleModalContentClick(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
  }

  return (
    <>
      <div style={previewWrapperStyle}>
        <div style={previewHeaderStyle}>
          <div style={helperTextGroupStyle}>
            <span style={helperTextStyle}>차트를 클릭하면 크게 볼 수 있습니다.</span>
            <span style={helperTextStyle}>( ERD 내에서의 테이블 컬럼은 PK만 표시됩니다. )</span>
          </div>
          <button type="button" style={actionButtonStyle} onClick={() => setIsExpanded(true)}>
            확대 보기
          </button>
        </div>

        <button
          type="button"
          style={chartButtonStyle}
          onClick={() => setIsExpanded(true)}
          aria-label={`${title} 확대 보기`}
        >
          <MermaidCanvas chart={chart} minHeight={240} />
        </button>
      </div>

      {isExpanded ? (
        <div
          style={overlayStyle}
          role="dialog"
          aria-modal="true"
          aria-label={`${title} 확대 보기`}
          aria-describedby={instructionsId}
          onClick={() => setIsExpanded(false)}
        >
          <div style={modalStyle} onClick={handleModalContentClick}>
            <div style={modalHeaderStyle}>
              <div style={modalTitleGroupStyle}>
                <strong>{title}</strong>
                <span id={instructionsId} style={modalHelperTextStyle}>
                  마우스 휠로 확대/축소하고, 드래그로 화면을 이동할 수 있습니다.
                </span>
              </div>
              <button type="button" style={actionButtonStyle} onClick={() => setIsExpanded(false)}>
                닫기
              </button>
            </div>
            <div style={modalBodyStyle}>
              <MermaidCanvas chart={chart} minHeight={520} interactive />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function MermaidCanvas({ chart, minHeight, interactive = false }: MermaidCanvasProps) {
  const id = useId().replace(/:/g, '-');
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(DEFAULT_SCALE);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [svgSize, setSvgSize] = useState<SvgSize | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!interactive) {
      return;
    }

    setScale(DEFAULT_SCALE);
    scaleRef.current = DEFAULT_SCALE;
    setIsDragging(false);
    dragStateRef.current = null;

    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  }, [chart, interactive]);

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      if (!containerRef.current) {
        return;
      }

      containerRef.current.innerHTML = '';
      setError(null);

      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: 'dark',
        });

        const { svg } = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;

          const svgElement = containerRef.current.querySelector('svg');
          if (interactive && svgElement instanceof SVGSVGElement) {
            const nextSvgSize = getSvgSize(svgElement, minHeight);
            setSvgSize(nextSvgSize);
            svgElement.style.display = 'block';
            svgElement.style.width = '100%';
            svgElement.style.height = '100%';
            svgElement.style.maxWidth = 'none';
          } else {
            setSvgSize(null);
          }
        }
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'Mermaid 렌더링에 실패했습니다.');
        }
      }
    }

    renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  function zoomTo(nextScale: number, focusPoint?: { x: number; y: number }) {
    if (!interactive) {
      return;
    }

    const viewport = viewportRef.current;
    const currentScale = scaleRef.current;
    const normalizedScale = clampScale(nextScale);
    if (!viewport || normalizedScale === currentScale) {
      scaleRef.current = normalizedScale;
      setScale(normalizedScale);
      return;
    }

    const focusX = focusPoint?.x ?? viewport.clientWidth / 2;
    const focusY = focusPoint?.y ?? viewport.clientHeight / 2;
    const contentX = viewport.scrollLeft + focusX;
    const contentY = viewport.scrollTop + focusY;
    const ratio = normalizedScale / currentScale;

    scaleRef.current = normalizedScale;
    setScale(normalizedScale);

    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, contentX * ratio - focusX);
      viewport.scrollTop = Math.max(0, contentY * ratio - focusY);
    });
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!interactive) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;

    zoomTo(scale + delta, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!interactive || event.button !== 0 || !viewportRef.current) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: viewportRef.current.scrollLeft,
      startScrollTop: viewportRef.current.scrollTop,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!interactive || !viewportRef.current || !dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragStateRef.current.startX;
    const deltaY = event.clientY - dragStateRef.current.startY;

    viewportRef.current.scrollLeft = dragStateRef.current.startScrollLeft - deltaX;
    viewportRef.current.scrollTop = dragStateRef.current.startScrollTop - deltaY;
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (!interactive || !dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    setIsDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const scaledWidth = svgSize ? Math.max(svgSize.width * scale, 1) : undefined;
  const scaledHeight = svgSize ? Math.max(svgSize.height * scale, minHeight) : minHeight;

  return (
    <div style={wrapperStyle}>
      {interactive && !error ? (
        <div style={interactiveHeaderStyle}>
          <div style={zoomSummaryStyle} aria-live="polite">
            배율 {Math.round(scale * 100)}%
          </div>
          <div style={zoomControlsStyle}>
            <button type="button" style={controlButtonStyle} onClick={() => zoomTo(scale - ZOOM_STEP)} aria-label="축소">
              −
            </button>
            <button
              type="button"
              style={controlButtonStyle}
              onClick={() => zoomTo(DEFAULT_SCALE)}
              aria-label="기본 배율로 재설정"
            >
              100%
            </button>
            <button type="button" style={controlButtonStyle} onClick={() => zoomTo(scale + ZOOM_STEP)} aria-label="확대">
              ＋
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={errorStyle}>{error}</div>
      ) : interactive ? (
        <div
          ref={viewportRef}
          style={{
            ...interactiveViewportStyle,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <div
            style={{
              ...interactiveContentStyle,
              width: scaledWidth,
              minHeight,
              height: scaledHeight,
            }}
          >
            <div ref={containerRef} style={interactiveChartStyle} />
          </div>
        </div>
      ) : (
        <div ref={containerRef} style={{ ...chartStyle, minHeight }} />
      )}
    </div>
  );
}

function getSvgSize(svg: SVGSVGElement, minHeight: number): SvgSize {
  const viewBox = svg.viewBox.baseVal;
  const width =
    (viewBox?.width && viewBox.width > 0 ? viewBox.width : null) ??
    parseSvgDimension(svg.getAttribute('width')) ??
    safeSvgBoxMeasurement(() => svg.getBBox().width) ??
    1200;
  const height =
    (viewBox?.height && viewBox.height > 0 ? viewBox.height : null) ??
    parseSvgDimension(svg.getAttribute('height')) ??
    safeSvgBoxMeasurement(() => svg.getBBox().height) ??
    minHeight;

  return {
    width: Math.max(width, 1),
    height: Math.max(height, minHeight),
  };
}

function parseSvgDimension(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeSvgBoxMeasurement(readMeasurement: () => number): number | null {
  try {
    const measurement = readMeasurement();
    return Number.isFinite(measurement) && measurement > 0 ? measurement : null;
  } catch {
    return null;
  }
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));
}

const wrapperStyle: CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(148, 163, 184, 0.14)',
  background: '#020617',
  padding: 16,
  overflow: 'hidden',
};

const chartStyle: CSSProperties = {
  overflow: 'auto',
  width: 'max-content',
  minWidth: '100%',
};

const errorStyle: CSSProperties = {
  color: '#fecaca',
};

const previewWrapperStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const previewHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const helperTextStyle: CSSProperties = {
  color: '#94a3b8',
  fontSize: 14,
};

const helperTextGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const chartButtonStyle: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.16)',
  borderRadius: 18,
  background: 'transparent',
  padding: 0,
  cursor: 'zoom-in',
  textAlign: 'left',
};

const actionButtonStyle: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.22)',
  borderRadius: 12,
  background: 'rgba(15, 23, 42, 0.88)',
  color: '#dbeafe',
  padding: '10px 12px',
  cursor: 'pointer',
};

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(2, 6, 23, 0.86)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const modalStyle: CSSProperties = {
  width: 'min(96vw, 1400px)',
  maxHeight: '90vh',
  borderRadius: 20,
  border: '1px solid rgba(148, 163, 184, 0.24)',
  background: '#020617',
  boxShadow: '0 24px 60px rgba(2, 6, 23, 0.5)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const modalHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  padding: 20,
  borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
  flexWrap: 'wrap',
};

const modalBodyStyle: CSSProperties = {
  padding: 20,
  overflow: 'hidden',
};

const modalTitleGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const modalHelperTextStyle: CSSProperties = {
  color: '#94a3b8',
  fontSize: 14,
  lineHeight: 1.5,
};

const interactiveHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  marginBottom: 12,
};

const zoomSummaryStyle: CSSProperties = {
  color: '#cbd5e1',
  fontSize: 14,
  lineHeight: 1.5,
};

const zoomControlsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const controlButtonStyle: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.22)',
  borderRadius: 12,
  background: 'rgba(15, 23, 42, 0.88)',
  color: '#dbeafe',
  minWidth: 56,
  padding: '10px 12px',
  cursor: 'pointer',
};

const interactiveViewportStyle: CSSProperties = {
  maxHeight: 'calc(90vh - 220px)',
  minHeight: 520,
  overflow: 'auto',
  borderRadius: 16,
  border: '1px solid rgba(148, 163, 184, 0.14)',
  background:
    'linear-gradient(0deg, rgba(15, 23, 42, 0.48), rgba(15, 23, 42, 0.48)), radial-gradient(circle at top, rgba(59, 130, 246, 0.08), transparent 40%)',
  touchAction: 'none',
};

const interactiveContentStyle: CSSProperties = {
  width: 'max-content',
  minWidth: '100%',
  padding: 12,
};

const interactiveChartStyle: CSSProperties = {
  width: '100%',
  height: '100%',
};
