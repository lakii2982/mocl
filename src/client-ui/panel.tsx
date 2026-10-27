/**
 * 外部代理面板（W2 client 半）。
 *
 * - 视觉/四态/列宽/截断的真实参照：design/prototype.html（类名加 mocl- 前缀避免污染宿主）。
 * - 组件树/四态矩阵/键盘/复制：design/DESIGN.md §4/§5/§11；文案：§12（status.ts 的 TEXT）。
 * - 数据面：polling.ts（2s 轮询 + 心跳 + 可见性暂停）；纯逻辑：status.ts（node 可测）。
 * - 本文件由 tools/build-client.mjs 用 esbuild 打包。TSX 不在 tsc typecheck 范围内
 *   （tsconfig 只含 *.ts，且不引入 @types/react）——可测逻辑一律放 status.ts / polling.ts。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  TEXT,
  UNKNOWN_TEXT,
  durationText,
  isBackendDisabled,
  labelText,
  lastActivityText,
  modelParts,
  runtimeLine,
  shown,
  statusFor,
  summaryCounts,
  syncReadyText,
  type PanelAgent,
} from "./status.ts";
import {
  PANEL_LIST_PATH,
  PANEL_HEARTBEAT_PATH,
  createPanelDataController,
  initialPanelSnapshot,
  type PanelDataController,
  type PanelListBody,
  type PanelSnapshot,
} from "./polling.ts";

/* ------------------------------------------------------------------ */
/* 图标（路径数据照抄 design/prototype.html；统一 aria-hidden，语义由相邻中文承担） */
/* ------------------------------------------------------------------ */

const ICON_PATHS: Record<string, string> = {
  running: '<path d="M7 4.5 14 10l-7 5.5Z"/><path d="M3 10h2"/>',
  queued: '<path d="M3 5h9M3 9h7M3 13h5"/><circle cx="14" cy="13" r="4"/><path d="M14 11v2l1.5 1"/>',
  waiting: '<circle cx="10" cy="10" r="7"/><path d="M7.8 7.5a2.4 2.4 0 0 1 4.6 1c0 2-2.4 2-2.4 4M10 15.5h.01"/>',
  completed: '<circle cx="10" cy="10" r="7"/><path d="m6.5 10 2.2 2.2 4.8-5"/>',
  aborted: '<circle cx="10" cy="10" r="7"/><path d="M7 7h6v6H7Z"/>',
  failed: '<path d="M10 3 18 17H2Z"/><path d="M10 8v4M10 14.5h.01"/>',
  recovering: '<path d="M4 8a7 7 0 1 1 1 7M4 8V3M4 8h5"/>',
  lost: '<path d="m8 12-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M12 8l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0M8 8l4 4"/>',
  archived: '<path d="M3 5h14v4H3ZM5 9v7h10V9M8 12h4"/>',
  blocked: '<circle cx="10" cy="10" r="7"/><path d="M7 6v8M13 6v8"/>',
  created: '<circle cx="10" cy="10" r="6"/><path d="M10 3v2M10 15v2"/>',
  unknown: '<circle cx="10" cy="10" r="7"/><path d="M8 7a2 2 0 1 1 3 2c-1 .5-1 1-1 2M10 14h.01"/>',
};

function StatusIcon({ name }: { name: string }): ReactElement {
  return (
    <svg
      className="mocl-status-icon"
      viewBox="0 0 20 20"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? ICON_PATHS.unknown ?? "" }}
    />
  );
}

const RETRY_ICON_PATH = '<path d="M16 7a7 7 0 1 0 1 6M16 7V2M16 7h-5"/>';

function RetryIcon(): ReactElement {
  return (
    <svg
      className="mocl-status-icon"
      viewBox="0 0 20 20"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: RETRY_ICON_PATH }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 数据面接线（fetch + 心跳 + 可见性；dispose 全部回收） */
/* ------------------------------------------------------------------ */

async function fetchPanelList(signal: AbortSignal): Promise<PanelListBody> {
  const response = await fetch(PANEL_LIST_PATH, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`mocl-panel: http ${response.status}`);
  return (await response.json()) as PanelListBody;
}

/** 心跳：POST {rows, mounted, viewport}；失败静默（仅供 Lead 机器验收，不影响面板）。 */
function postHeartbeat(snapshot: PanelSnapshot, meta: { mounted: boolean }, root: HTMLElement | null): void {
  const body = JSON.stringify({
    rows: snapshot.children.length,
    mounted: meta.mounted,
    viewport: root === null ? null : root.clientWidth,
  });
  void fetch(PANEL_HEARTBEAT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 复制（DESIGN §11：可见文字反馈，不用自动弹窗） */
/* ------------------------------------------------------------------ */

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (previousFocus !== null && typeof (previousFocus as HTMLElement).focus === "function") {
    (previousFocus as HTMLElement).focus({ preventScroll: true });
  }
  if (!copied) throw new Error("mocl-panel: copy failed");
}

function CopyButton({ value, title }: { value: string | null; title: string }): ReactElement | null {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  if (value === null) return null;
  const scheduleReset = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setState("idle");
    }, 1400);
  };
  const onCopy = (): void => {
    void copyText(value).then(
      () => {
        setState("copied");
        scheduleReset();
      },
      () => {
        setState("failed");
        scheduleReset();
      },
    );
  };
  return (
    <button className="mocl-copy-button" type="button" onClick={onCopy} title={title}>
      {state === "copied" ? TEXT.copied : state === "failed" ? TEXT.copyFailed : TEXT.copy}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 汇总条与页面态视图（四态矩阵：DESIGN §5） */
/* ------------------------------------------------------------------ */

function Count({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span className="mocl-count">
      {label} <strong>{value}</strong>
    </span>
  );
}

function SummaryBar({
  mode,
  counts,
  syncText,
  onRetry,
}: {
  mode: "loading" | "error" | "ready";
  counts: { running: number; queued: number; failed: number; total: number };
  syncText: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="mocl-summary-bar">
      {mode === "loading" ? (
        <div className="mocl-count-group" aria-label={TEXT.countsLoadingLabel}>
          <span className="mocl-summary-skeleton" />
          <span className="mocl-summary-skeleton" />
          <span className="mocl-summary-skeleton" />
          <span className="mocl-summary-skeleton" />
        </div>
      ) : mode === "error" ? (
        <div className="mocl-count-group" aria-label={TEXT.countsUnknownLabel}>
          <Count label={TEXT.summaryRunning} value={UNKNOWN_TEXT} />
          <Count label={TEXT.summaryQueued} value={UNKNOWN_TEXT} />
          <Count label={TEXT.summaryFailed} value={UNKNOWN_TEXT} />
          <Count label={TEXT.summaryTotal} value={UNKNOWN_TEXT} />
        </div>
      ) : (
        <div
          className="mocl-count-group"
          aria-label={`运行中 ${counts.running}，排队 ${counts.queued}，失败 ${counts.failed}，共 ${counts.total}`}
        >
          <Count label={TEXT.summaryRunning} value={String(counts.running)} />
          <Count label={TEXT.summaryQueued} value={String(counts.queued)} />
          <Count label={TEXT.summaryFailed} value={String(counts.failed)} />
          <Count label={TEXT.summaryTotal} value={String(counts.total)} />
        </div>
      )}
      <span className="mocl-sync-status" title={syncText}>
        {syncText}
      </span>
      {mode === "error" ? (
        <button className="mocl-summary-retry" type="button" onClick={onRetry} aria-label={TEXT.retry} title={TEXT.retry}>
          <RetryIcon />
        </button>
      ) : null}
    </div>
  );
}

function LoadingView(): ReactElement {
  const row = (
    <div className="mocl-skeleton-row" aria-hidden="true">
      <span className="mocl-skeleton-block mocl-skeleton-status" />
      <span className="mocl-skeleton-stack">
        <span className="mocl-skeleton-block mocl-skeleton-label" />
        <span className="mocl-skeleton-block mocl-skeleton-meta" />
      </span>
      <span className="mocl-skeleton-block mocl-skeleton-time" />
    </div>
  );
  return (
    <div className="mocl-loading-view" aria-busy="true" aria-label={TEXT.loadingLabel}>
      {row}
      {row}
      {row}
    </div>
  );
}

function EmptyView(): ReactElement {
  return (
    <div className="mocl-state-view">
      <div className="mocl-state-view-inner">
        <h2 className="mocl-state-title">{TEXT.emptyTitle}</h2>
        <p className="mocl-state-description">{TEXT.emptyDescription}</p>
      </div>
    </div>
  );
}

function ErrorView({ code, onRetry }: { code: string; onRetry: () => void }): ReactElement {
  return (
    <div className="mocl-state-view" role="alert">
      <div className="mocl-state-view-inner">
        <h2 className="mocl-state-title">{TEXT.errorTitle}</h2>
        <p className="mocl-state-description">{TEXT.errorDescription}</p>
        <span className="mocl-error-code">
          code: <span className="mocl-code">{code}</span>
        </span>
        <button className="mocl-retry-button" type="button" onClick={onRetry}>
          <RetryIcon />
          {TEXT.retry}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 行与展开详情 */
/* ------------------------------------------------------------------ */

function DetailPair({ k, v, code = false }: { k: string; v: string; code?: boolean }): ReactElement {
  return (
    <div className="mocl-detail-pair">
      <dt>{k}</dt>
      <dd className={code ? "mocl-code" : undefined}>{v}</dd>
    </div>
  );
}

function CopyDetailPair({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <div className="mocl-detail-pair">
      <dt>{k}</dt>
      <dd>
        <span className="mocl-copy-line">
          <span className="mocl-code">{v}</span>
          <CopyButton value={v} title={`复制 ${k}`} />
        </span>
      </dd>
    </div>
  );
}

function ErrorDetails({ error }: { error: NonNullable<PanelAgent["error"]> }): ReactElement {
  const traceId = typeof error.traceId === "string" && error.traceId.length > 0 ? error.traceId : null;
  return (
    <section className="mocl-error-block" aria-label={TEXT.errorDetailsLabel}>
      <h3 className="mocl-error-title">{TEXT.errorDetailsLabel}</h3>
      <dl className="mocl-detail-list">
        <DetailPair k="code" v={shown(error.code)} code />
        <DetailPair k="userMessage" v={shown(error.userMessage)} />
        {/* retryable 展示 ABI 原值（no/once/backoff/after-recovery），缺失 → 未知。 */}
        <DetailPair k="retryable" v={shown(error.retryable)} />
        {traceId === null ? <DetailPair k="traceId" v={UNKNOWN_TEXT} code /> : <CopyDetailPair k="traceId" v={traceId} />}
      </dl>
    </section>
  );
}

function rowKey(agent: PanelAgent | undefined, index: number): string {
  const childId = typeof agent?.childId === "string" && agent.childId.length > 0 ? agent.childId : null;
  return childId ?? `#${index}`;
}

/* ------------------------------------------------------------------ */
/* 面板主体 */
/* ------------------------------------------------------------------ */

type KeyboardishEvent = { key: string; preventDefault(): void };

export function ExternalAgentPanel(): ReactElement {
  const rootRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(initialPanelSnapshot);
  const [retrying, setRetrying] = useState(false);
  const controllerRef = useRef<PanelDataController | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set<string>());
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [liveText, setLiveText] = useState("");
  const liveCountsRef = useRef("");

  useEffect(() => {
    const controller = createPanelDataController({
      fetchList: fetchPanelList,
      heartbeat: (snap, meta) => {
        postHeartbeat(snap, meta, rootRef.current);
      },
      isHidden: () => document.hidden,
      subscribeVisibility: (onChange) => {
        document.addEventListener("visibilitychange", onChange);
        return () => {
          document.removeEventListener("visibilitychange", onChange);
        };
      },
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((next) => {
      setSnapshot(next);
      setRetrying(false);
    });
    controller.start();
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const children = snapshot.children;

  // 行数变化时收敛 roving tabindex（不自动抢焦点，只保证 tabIndex 合法）。
  useEffect(() => {
    if (activeIndex > children.length - 1) {
      setActiveIndex(children.length > 0 ? children.length - 1 : 0);
    }
  }, [children.length, activeIndex]);

  // 礼貌 live region：仅在计数变化时更新，行内计时器不触发播报（DESIGN §11）。
  useEffect(() => {
    if (snapshot.phase !== "ready") return;
    const counts = summaryCounts(children);
    const text = `运行中 ${counts.running}，排队 ${counts.queued}，失败 ${counts.failed}，共 ${counts.total}`;
    if (text !== liveCountsRef.current) {
      liveCountsRef.current = text;
      setLiveText(text);
    }
  }, [snapshot, children]);

  const loading = snapshot.phase === "loading" || retrying;
  const failed = !loading && snapshot.phase === "error";
  const mode: "loading" | "error" | "ready" = loading ? "loading" : failed ? "error" : "ready";
  const nowMs = Date.now();
  const counts = summaryCounts(children);
  // route v1 不返回 lastSeq（seq 为可选字段）：缺 seq 时同步栏显示「已同步 · 相对时间」，不出 seq=未知。
  const syncText =
    snapshot.phase === "ready" && !loading && !failed
      ? syncReadyText(snapshot.lastSyncAt, null, nowMs)
      : failed
        ? TEXT.syncFailed
        : TEXT.syncPolling;

  const onRetry = useCallback(() => {
    setRetrying(true);
    void controllerRef.current?.refresh();
  }, []);

  const toggleKey = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const moveFocus = useCallback(
    (to: number) => {
      const count = children.length;
      if (count === 0) return;
      const clamped = Math.max(0, Math.min(count - 1, to));
      setActiveIndex(clamped);
      const button = rowRefs.current[clamped];
      if (button !== null && button !== undefined) {
        button.focus({ preventScroll: true });
        button.scrollIntoView({ block: "nearest" });
      }
    },
    [children.length],
  );

  const onRowKeyDown = useCallback(
    (event: KeyboardishEvent, index: number) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(index + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(index - 1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        moveFocus(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        moveFocus(children.length - 1);
        return;
      }
      if (event.key === "Escape") {
        // Esc 收起当前行并把焦点留在其触发器（DESIGN §11）。
        const key = rowKey(children[index], index);
        if (expandedKeys.has(key)) {
          event.preventDefault();
          toggleKey(key);
          const button = rowRefs.current[index];
          if (button !== null && button !== undefined) button.focus({ preventScroll: true });
        }
      }
    },
    [children, expandedKeys, moveFocus, toggleKey],
  );

  return (
    <section className="mocl-panel" aria-label="外部代理运行状态" ref={rootRef}>
      <div className="mocl-sr-only" role="status" aria-live="polite">
        {liveText}
      </div>
      <SummaryBar mode={mode} counts={counts} syncText={syncText} onRetry={onRetry} />
      <div className="mocl-scrollport">
        {loading ? (
          <LoadingView />
        ) : failed ? (
          <ErrorView code={snapshot.error?.code ?? UNKNOWN_TEXT} onRetry={onRetry} />
        ) : children.length === 0 ? (
          <EmptyView />
        ) : (
          <div className="mocl-agent-list" role="list" aria-label={TEXT.listLabel}>
            {children.map((agent, index) => {
              const status = statusFor(agent);
              const key = rowKey(agent, index);
              const expanded = expandedKeys.has(key);
              const fullLabel = shown(agent.label);
              const runtime = runtimeLine(agent);
              const model = modelParts(agent);
              const duration = durationText(agent, nowMs);
              const activity = lastActivityText(agent, nowMs);
              const modelTitle = model.note === "" ? model.name : `${model.name} ${model.note}`;
              return (
                <div className="mocl-agent-item" role="listitem" key={key}>
                  <button
                    type="button"
                    className="mocl-agent-row"
                    tabIndex={index === activeIndex ? 0 : -1}
                    aria-expanded={expanded}
                    aria-controls={`mocl-panel-details-${index}`}
                    aria-label={`${fullLabel}，${status.label}`}
                    onClick={() => toggleKey(key)}
                    onKeyDown={(event) => onRowKeyDown(event, index)}
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                  >
                    <span className={`mocl-status-column mocl-status-${status.key}`}>
                      <span className="mocl-status-primary">
                        <span className="mocl-status-dot" role="img" aria-label={`${TEXT.statusAriaPrefix}${status.label}`} />
                        <StatusIcon name={status.key} />
                        <span>{status.label}</span>
                      </span>
                      {status.secondary === "" ? null : <span className="mocl-status-secondary">{status.secondary}</span>}
                    </span>
                    <span className="mocl-task-column">
                      <span className="mocl-task-label" title={fullLabel}>
                        {labelText(agent)}
                      </span>
                      <span className="mocl-runtime-line">
                        <span className="mocl-runtime" title={runtime}>
                          <span className="mocl-runtime-text">{runtime}</span>
                        </span>
                        <span className="mocl-model" title={modelTitle}>
                          <span className="mocl-model-name">{model.name}</span>
                          {model.note === "" ? null : <span className="mocl-model-note">{model.note}</span>}
                        </span>
                      </span>
                    </span>
                    <span className="mocl-timing-column">
                      <span className="mocl-duration" title={TEXT.durationLabel}>
                        {duration ?? UNKNOWN_TEXT}
                      </span>
                      <span title={TEXT.lastActivityLabel}>{activity ?? UNKNOWN_TEXT}</span>
                    </span>
                    {isBackendDisabled(agent) ? <span className="mocl-backend-notice">{TEXT.backendDisabledNotice}</span> : null}
                  </button>
                  <div
                    className="mocl-details"
                    id={`mocl-panel-details-${index}`}
                    role="region"
                    aria-label={`${fullLabel}${TEXT.detailsSuffix}`}
                    hidden={!expanded}
                  >
                    <dl className="mocl-detail-list">
                      <CopyDetailPair k="childId" v={shown(agent.childId)} />
                      <DetailPair k="cwd" v={shown(agent.cwd)} code />
                      <DetailPair k="depth" v={shown(agent.depth)} />
                      <DetailPair k="epoch" v={shown(agent.epoch)} />
                      <DetailPair k="turnId" v={shown(agent.lastTurnId)} code />
                    </dl>
                    {/* P1-PROGRESS: 仅当未来进度数据完整且能力可用时挂载独立折叠面板（DESIGN §13；不得把 accepted/queued 猜成百分比）。 */}
                    {/* P1-USAGE: 仅在真实用量数据存在时挂载用量行；缺失仍是「未知」，不能用 0 token 代替。 */}
                    {/* P1-CHILD-TREE: 仅在真实父子关系可用时挂载外部原生子代理树；不根据 depth 或 childId 猜树。 */}
                    {agent.error === null || agent.error === undefined ? null : <ErrorDetails error={agent.error} />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
