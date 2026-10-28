/**
 * 外部代理面板（W6 client 半 v1.2：分组仪表盘）。
 *
 * - 视觉/分组/sticky/响应式的真实参照：design-v12/prototype.html + DESIGN-v1.2.md
 *   （kimi 定稿，`node design-v12/check.mjs` 63/63；类名加 mocl- 前缀避免污染宿主）。
 * - W6 只重做呈现层：13 级状态映射、筛选口径、两层详情、模型来源标识、2s 轮询、
 *   四种页面态全部沿用 W5，不推翻功能契约。
 * - 组件树：DESIGN-v1.2 §6 —— PanelTop（滚动区之外）= MetricGrid + OverviewLine + ListTools；
 *   PanelScrollport = 四态视图 / StatusGroup[sticky GroupHeader] → AgentList → AgentRow + 展开详情。
 * - 纯逻辑：status.ts / filter.ts / details.ts / groups.ts（node 可测）；本文件只做渲染与接线。
 *   （groups.ts 是 W6 新增的分组/计数/折叠持久化视图模型；v1.2 增量文案也收在那里，
 *   因为 status.ts 的 TEXT 属 W5 冻结面。）
 * - 本文件由 tools/build-client.mjs 用 esbuild 打包。TSX 不在 tsc typecheck 范围内
 *   （tsconfig 只含 *.ts，且不引入 @types/react）。
 * - 硬约束：cwd/depth/epoch/turnId 只在「技术详情」折叠区渲染（details.ts 保证数据面）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  TEXT,
  UNKNOWN_TEXT,
  durationText,
  filterOptionAccessibleName,
  hiddenLostAriaNote,
  hiddenLostNote,
  isBackendDisabled,
  labelText,
  lastActivityText,
  modelParts,
  runtimeLine,
  shown,
  statusFor,
  syncReadyText,
  type PanelAgent,
} from "./status.ts";
import {
  loadFilterState,
  saveFilterState,
  showAllFilterState,
  filterControlsEnabled,
  type FilterStorage,
  type PanelFilterState,
} from "./filter.ts";
import {
  defaultDetailGroups,
  technicalDetailGroups,
  type DetailField,
  type DetailGroup,
} from "./details.ts";
import {
  GROUP_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  PANEL_TEXT,
  dashboardCounts,
  flattenGroupRows,
  groupRows,
  hiddenLostCount,
  isGroupOpen,
  loadGroupOpenState,
  nextViewFilter,
  saveGroupOpenState,
  visibleRows,
  type GroupKey,
  type MetricKey,
  type ViewFilterState,
} from "./groups.ts";
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
/* 图标（路径数据照抄 design-v12/prototype.html；统一 aria-hidden，语义由相邻中文承担） */
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
  other: '<circle cx="5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
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

const CHEVRON_PATH = '<path d="m5 7.5 5 5 5-5"/>';

/** 组折叠箭头（aria-hidden：展开态由 aria-expanded 表达）。 */
function GroupChevron(): ReactElement {
  return (
    <svg
      className="mocl-group-chevron"
      viewBox="0 0 20 20"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: CHEVRON_PATH }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 数据面接线（fetch + 心跳 + 可见性；dispose 全部回收）—— W2 起不变 */
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

/** localStorage 解析（隐私模式/非浏览器 → null：筛选/折叠仍可在当前会话使用）。 */
function resolveFilterStorage(): FilterStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
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

function CopyButton({ value, title }: { value: string; title: string }): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
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
/* 顶部总览层（W6 §2 / DESIGN-v1.2 §2）：四个可点击计数块 + 一行总览 + lost 开关 */
/* ------------------------------------------------------------------ */

function MetricGrid({
  enabled,
  counts,
  filter,
  focusKey,
  gridRef,
  onSelect,
  onKeyDown,
}: {
  enabled: boolean;
  counts: Record<MetricKey, string>;
  filter: ViewFilterState["filter"];
  focusKey: MetricKey;
  gridRef: (node: HTMLDivElement | null) => void;
  onSelect: (key: MetricKey) => void;
  onKeyDown: (event: KeyboardishEvent) => void;
}): ReactElement {
  return (
    <div className="mocl-metric-grid" role="group" aria-label={PANEL_TEXT.metricGroupLabel} ref={gridRef} onKeyDown={onKeyDown}>
      {METRIC_KEYS.map((key) => {
        const countText = counts[key];
        const selected = filter === key;
        const accessibleCount = filterOptionAccessibleName(METRIC_LABELS[key], countText);
        return (
          <button
            key={key}
            type="button"
            className={`mocl-metric-card mocl-tone-${key}`}
            data-filter={key}
            aria-pressed={selected}
            aria-label={`${selected ? PANEL_TEXT.cancelFilterPrefix : PANEL_TEXT.onlyThisPrefix}${accessibleCount}`}
            title={accessibleCount}
            tabIndex={focusKey === key ? 0 : -1}
            disabled={!enabled}
            onClick={() => onSelect(key)}
          >
            <span className="mocl-metric-accent" aria-hidden="true" />
            <span className="mocl-metric-value" title={accessibleCount}>
              {countText}
            </span>
            <span className="mocl-metric-label">
              <StatusIcon name={key} />
              <span>{METRIC_LABELS[key]}</span>
            </span>
            {selected ? <span className="mocl-sr-only">{PANEL_TEXT.selectedOnlyHint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 一行总览：`共 N（隐藏 M 已丢失）` · `已同步 · 相对时间`；错误态给可见重试入口。 */
function OverviewLine({
  mode,
  total,
  hiddenLost,
  syncText,
  onRetry,
}: {
  mode: "loading" | "error" | "ready";
  total: number;
  hiddenLost: number;
  syncText: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="mocl-overview-line">
      {mode === "loading" ? (
        <span className="mocl-summary-skeleton" aria-label={TEXT.countsLoadingLabel} />
      ) : (
        <span className="mocl-total-count">
          {TEXT.summaryTotal} {mode === "error" ? UNKNOWN_TEXT : total}
          {mode === "ready" && hiddenLost > 0 ? (
            <span className="mocl-hidden-total-note">{hiddenLostNote(hiddenLost)}</span>
          ) : null}
        </span>
      )}
      <span className="mocl-sync-status" title={syncText}>
        {syncText}
      </span>
      {mode === "error" ? (
        <button className="mocl-summary-retry" type="button" onClick={onRetry}>
          {TEXT.retry}
        </button>
      ) : null}
    </div>
  );
}

/** 轻量工具行：左侧组说明、右侧「显示已丢失」（role=switch，默认关=隐藏 lost）。 */
function ListTools({
  enabled,
  showLost,
  onToggle,
}: {
  enabled: boolean;
  showLost: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="mocl-list-tools">
      <span className="mocl-list-tools-label">{PANEL_TEXT.listToolsLabel}</span>
      <button
        type="button"
        role="switch"
        className="mocl-lost-switch"
        aria-checked={showLost}
        aria-label={PANEL_TEXT.showLostLabel}
        disabled={!enabled}
        onClick={onToggle}
      >
        <span className="mocl-switch-track" aria-hidden="true">
          <span className="mocl-switch-knob" />
        </span>
        <span>{PANEL_TEXT.showLostLabel}</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 页面态视图（四态矩阵：DESIGN §5；筛选空态不是第五种页面态） */
/* ------------------------------------------------------------------ */

function LoadingView(): ReactElement {
  const row = (
    <div className="mocl-skeleton-row" aria-hidden="true">
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

/** 空筛选态（§3.1）：是正常列表的子状态，不是第五种页面态；无行可看时回「查看全部」。 */
function FilterEmptyView({ onShowAll }: { onShowAll: () => void }): ReactElement {
  return (
    <div className="mocl-state-view">
      <div className="mocl-state-view-inner">
        <h2 className="mocl-state-title">{TEXT.filterEmptyTitle}</h2>
        <p className="mocl-state-description">{TEXT.filterEmptyDescription}</p>
        <button className="mocl-retry-button" type="button" onClick={onShowAll}>
          {TEXT.showAll}
        </button>
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
/* 展开详情：人话区 + 技术详情折叠（W5 F2 原样沿用；数据面见 details.ts） */
/* ------------------------------------------------------------------ */

function ModelSuffix({ text, source }: { text: string; source: string }): ReactElement {
  return (
    <>
      {" "}
      <span className="mocl-model-note" data-source={source}>
        {text}
      </span>
    </>
  );
}

function DetailFieldRow({ field }: { field: DetailField }): ReactElement {
  const codeClass = field.code === true ? "mocl-code" : undefined;
  const suffix = field.suffixText === undefined ? null : <ModelSuffix text={field.suffixText} source={field.suffixSource ?? "unknown"} />;
  if (field.copyValue !== undefined) {
    return (
      <div className="mocl-detail-pair">
        <dt>{field.key}</dt>
        <dd>
          <span className="mocl-copy-line">
            <span className={codeClass}>{field.value}</span>
            {suffix}
            <CopyButton value={field.copyValue} title={`复制 ${field.key}`} />
          </span>
        </dd>
      </div>
    );
  }
  return (
    <div className="mocl-detail-pair">
      <dt>{field.key}</dt>
      <dd>
        <span className={codeClass}>{field.value}</span>
        {suffix}
      </dd>
    </div>
  );
}

function DetailGroupView({ group }: { group: DetailGroup }): ReactElement {
  if (group.kind === "task") {
    return (
      <section className="mocl-detail-group" aria-label={group.title}>
        <div className="mocl-detail-heading">
          <h3 className="mocl-detail-title">{group.title}</h3>
          {group.taskCopyValue === undefined ? null : <CopyButton value={group.taskCopyValue} title={TEXT.copyFullTask} />}
        </div>
        <p className="mocl-task-full">{group.taskText}</p>
      </section>
    );
  }
  if (group.kind === "error") {
    return (
      <section className="mocl-error-block" aria-label={group.title}>
        <h3 className="mocl-error-title">{group.title}</h3>
        <dl className="mocl-detail-list">
          {(group.fields ?? []).map((field) => (
            <DetailFieldRow key={field.key} field={field} />
          ))}
        </dl>
      </section>
    );
  }
  return (
    <section className="mocl-detail-group" aria-label={group.title}>
      <h3 className="mocl-detail-title">{group.title}</h3>
      <dl className="mocl-detail-list">
        {(group.fields ?? []).map((field) => (
          <DetailFieldRow key={field.key} field={field} />
        ))}
      </dl>
      {group.note === undefined ? null : <p className="mocl-usage-note">{group.note}</p>}
    </section>
  );
}

/** 技术详情（v1.1 §3.3）：原生 details 默认收起；收起时字段不进无障碍树、复制按钮不可聚焦。 */
function TechnicalDetails({ agent, idPrefix }: { agent: PanelAgent; idPrefix: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const groups = technicalDetailGroups(agent);
  return (
    <details
      className="mocl-technical-details"
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen((prev) => (prev === next ? prev : next));
      }}
    >
      <summary className="mocl-technical-summary" aria-expanded={open} aria-controls={`${idPrefix}-technical`}>
        {TEXT.technicalDetails}
      </summary>
      <div className="mocl-technical-content" id={`${idPrefix}-technical`}>
        {groups.map((group) => (
          <div className="mocl-technical-group" key={group.help}>
            <p className="mocl-technical-help">{group.help}</p>
            <dl className="mocl-detail-list">
              {group.fields.map((field) => (
                <DetailFieldRow key={field.key} field={field} />
              ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
  );
}

function rowKey(agent: PanelAgent | undefined, index: number): string {
  const childId = typeof agent?.childId === "string" && agent.childId.length > 0 ? agent.childId : null;
  return childId ?? `#${index}`;
}

/* ------------------------------------------------------------------ */
/* 代理行（W6 §3.3）：状态色条 + 状态芯片/任务名/runtime/模型 chip + 右列两段时间 */
/* ------------------------------------------------------------------ */

function AgentRow({
  agent,
  index,
  active,
  expanded,
  nowMs,
  onToggle,
  onKeyDown,
  rowRef,
}: {
  agent: PanelAgent;
  index: number;
  active: boolean;
  expanded: boolean;
  nowMs: number;
  onToggle: () => void;
  onKeyDown: (event: KeyboardishEvent) => void;
  rowRef: (node: HTMLButtonElement | null) => void;
}): ReactElement {
  const status = statusFor(agent);
  const key = rowKey(agent, index);
  const fullLabel = shown(agent.label);
  const runtime = runtimeLine(agent);
  const model = modelParts(agent);
  const duration = durationText(agent, nowMs);
  const activity = lastActivityText(agent, nowMs);
  const modelTitle = model.note === "" ? model.name : `${model.name} ${model.note}`;
  // 完整 accessible name（§3.3）：任务、状态（含副文案）、模型、耗时、最后活动。
  const accessibleName = [
    fullLabel,
    status.label,
    status.secondary,
    modelTitle,
    duration ?? UNKNOWN_TEXT,
    `${TEXT.lastActivityLabel} ${activity ?? UNKNOWN_TEXT}`,
  ]
    .filter((part) => part !== "")
    .join("，");
  return (
    <div className="mocl-agent-item" role="listitem">
      <button
        type="button"
        className="mocl-agent-row"
        tabIndex={active ? 0 : -1}
        aria-expanded={expanded}
        aria-controls={`mocl-panel-details-${index}`}
        aria-label={accessibleName}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        ref={rowRef}
      >
        <span className={`mocl-status-bar mocl-tone-${status.key}`} aria-hidden="true" />
        <span className="mocl-task-column">
          <span className="mocl-task-heading">
            <span className={`mocl-status-chip mocl-tone-${status.key}`}>
              <span className="mocl-status-dot" role="img" aria-label={`${TEXT.statusAriaPrefix}${status.label}`} />
              <StatusIcon name={status.key} />
              <span>{status.label}</span>
            </span>
            <span className="mocl-task-label" title={fullLabel}>
              {labelText(agent)}
            </span>
          </span>
          <span className="mocl-runtime-line">
            <span className="mocl-runtime" title={runtime}>
              {runtime}
            </span>
            <span className="mocl-model" title={modelTitle}>
              <span className="mocl-model-name">{model.name}</span>
              {model.note === "" ? null : (
                <span className="mocl-model-note" data-source={model.source}>
                  {model.note}
                </span>
              )}
            </span>
          </span>
        </span>
        <span className="mocl-timing-column">
          <span className="mocl-duration" title={TEXT.durationLabel}>
            {duration ?? UNKNOWN_TEXT}
          </span>
          <span title={`${TEXT.lastActivityLabel} ${activity ?? UNKNOWN_TEXT}`}>{activity ?? UNKNOWN_TEXT}</span>
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
        {defaultDetailGroups(agent, nowMs).map((group) => (
          <DetailGroupView key={group.title} group={group} />
        ))}
        {/* P1-PROGRESS: 仅当未来进度数据完整且能力可用时挂载独立折叠面板（DESIGN §13；不得把 accepted/queued 猜成百分比）。 */}
        {/* P1-CHILD-TREE: 仅在真实父子关系可用时挂载外部原生子代理树；不根据 childId 猜树。 */}
        <TechnicalDetails agent={agent} idPrefix={`mocl-panel-${index}`} />
      </div>
    </div>
  );
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
  // 筛选状态（localStorage 持久化；storage 不可用时仅本会话有效，键 mocl.panel.filter.v1）。
  const storageRef = useRef<FilterStorage | null | undefined>(undefined);
  const readStorage = (): FilterStorage | null => {
    if (storageRef.current === undefined) storageRef.current = resolveFilterStorage();
    return storageRef.current;
  };
  const [filterState, setFilterState] = useState<ViewFilterState>(() => loadFilterState(readStorage()));
  const firstFilterRunRef = useRef(true);
  const pendingFocusMetricRef = useRef<MetricKey | null>(null);
  const metricGridNodeRef = useRef<HTMLDivElement | null>(null);
  const [metricFocusKey, setMetricFocusKey] = useState<MetricKey>(() =>
    filterState.filter === "all" ? METRIC_KEYS[0] ?? "running" : filterState.filter,
  );
  const showAllFocusRef = useRef(false);
  // 组折叠状态（独立键 mocl.panel.groups.v1，W6 §2「折叠状态记住」）。
  // 恢复的筛选若指向某主组，则该组强制展开（§2.1 选中组不收起），避免恢复出"只剩折叠头"的空视图。
  const [groupOpen, setGroupOpen] = useState<Partial<Record<GroupKey, boolean>>>(() => {
    const saved = loadGroupOpenState(readStorage());
    return filterState.filter === "all" ? saved : { ...saved, [filterState.filter]: true };
  });
  const firstGroupRunRef = useRef(true);

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

  // 筛选/折叠：用户变更后立即持久化（首次挂载不回写）。
  useEffect(() => {
    if (firstFilterRunRef.current) {
      firstFilterRunRef.current = false;
      return;
    }
    // ViewFilterState 在结构上兼容 {filter, hideLost}；queued 段在 filter.ts 增补该键前，
    // 读取端按越界回退 all（W6 冻结 filter.ts，见 groups.ts 头注），会话内不受影响。
    saveFilterState(readStorage(), filterState as PanelFilterState);
  }, [filterState]);

  useEffect(() => {
    if (firstGroupRunRef.current) {
      firstGroupRunRef.current = false;
      return;
    }
    saveGroupOpenState(readStorage(), groupOpen);
  }, [groupOpen]);

  // 选择变化后焦点留在新计数块（roving tabindex；异步数据更新不抢焦点）。
  useEffect(() => {
    const pending = pendingFocusMetricRef.current;
    if (pending === null) return;
    pendingFocusMetricRef.current = null;
    const grid = metricGridNodeRef.current;
    if (grid === null) return;
    const button = grid.querySelector<HTMLButtonElement>(`[data-filter="${pending}"]`);
    if (button !== null) button.focus({ preventScroll: true });
  }, [filterState]);

  // 「查看全部」：操作后焦点进入第一行；若仍无行则焦点自然留在原处（§3.1）。
  useEffect(() => {
    if (!showAllFocusRef.current) return;
    showAllFocusRef.current = false;
    const button = rowRefs.current[0];
    if (button !== null && button !== undefined) button.focus({ preventScroll: true });
  }, [filterState]);

  const mode: "loading" | "error" | "ready" =
    snapshot.phase === "loading" || retrying ? "loading" : snapshot.phase === "error" ? "error" : "ready";

  // v1.2：全量 → 分类 → lost 可见性（§2.2 固定顺序）；加载/错误态无可信快照。
  const ready = mode === "ready";
  const visible = ready ? visibleRows(children, filterState.filter, filterState.hideLost) : [];
  const groupsRendered = ready ? groupRows(visible) : [];
  const hiddenLost = ready ? hiddenLostCount(children, filterState.hideLost) : 0;
  // 行扁平序（§3.3）：只含展开组的行；键盘 roving tabindex 只作用于这些行。
  const flatRows = flattenGroupRows(groupsRendered, (key) => isGroupOpen(key, groupOpen));

  // 行数变化时收敛 roving tabindex（不自动抢焦点，只保证 tabIndex 合法）。
  useEffect(() => {
    if (activeIndex > flatRows.length - 1) {
      setActiveIndex(flatRows.length > 0 ? flatRows.length - 1 : 0);
    }
  }, [flatRows.length, activeIndex]);

  // 礼貌 live region：仅在计数变化时更新，行内计时器不触发播报（DESIGN §11）。
  const nowMs = Date.now();
  const dash = dashboardCounts(children);
  useEffect(() => {
    if (snapshot.phase !== "ready") return;
    const text = `运行中 ${dash.running}，排队 ${dash.queued}，失败 ${dash.failed}，已完成 ${dash.completed}，共 ${dash.total}${hiddenLostAriaNote(hiddenLost)}`;
    if (text !== liveCountsRef.current) {
      liveCountsRef.current = text;
      setLiveText(text);
    }
  }, [snapshot, dash.running, dash.queued, dash.failed, dash.completed, dash.total, hiddenLost]);

  const loading = mode === "loading";
  const failed = mode === "error";
  // route v1 不返回 lastSeq（seq 为可选字段）：缺 seq 时同步栏显示「已同步 · 相对时间」，不出 seq=未知。
  const syncText = failed
    ? TEXT.syncFailed
    : loading
      ? TEXT.syncSubscribing
      : syncReadyText(snapshot.lastSyncAt, null, nowMs);

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

  // 计数块点击（§2.1）：未选 → 只看该组（组自动展开）；再点同块 → 取消回全部；
  // 点另一块 → 直接切换。焦点留在被点的块上。
  const selectMetric = useCallback(
    (key: MetricKey) => {
      const next = nextViewFilter(key, filterState.filter);
      pendingFocusMetricRef.current = key;
      setMetricFocusKey(key);
      setActiveIndex(0);
      setFilterState({ filter: next, hideLost: filterState.hideLost });
      if (next !== "all") setGroupOpen((prev) => ({ ...prev, [next]: true }));
    },
    [filterState.filter, filterState.hideLost],
  );

  // 「显示已丢失」开关只控制可见性，不改变任何计数或「共 N」（§2.2）。
  const toggleShowLost = useCallback(() => {
    setActiveIndex(0);
    setFilterState((prev) => ({ filter: prev.filter, hideLost: !prev.hideLost }));
  }, []);

  const onShowAll = useCallback(() => {
    showAllFocusRef.current = true;
    setActiveIndex(0);
    setFilterState(showAllFilterState());
  }, []);

  const toggleGroupOpen = useCallback((key: GroupKey) => {
    setGroupOpen((prev) => ({ ...prev, [key]: !isGroupOpen(key, prev) }));
  }, []);

  const attachMetricGrid = useCallback((node: HTMLDivElement | null) => {
    metricGridNodeRef.current = node;
  }, []);

  // 计数块键盘（§2.1）：←/→ 循环移动焦点，Home/End 到首/尾；Enter/Space 由原生 button 触发点击。
  const onMetricKeyDown = useCallback(
    (event: KeyboardishEvent): void => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      event.preventDefault();
      const current = METRIC_KEYS.indexOf(metricFocusKey);
      let next = current;
      if (event.key === "ArrowLeft") next = (current - 1 + METRIC_KEYS.length) % METRIC_KEYS.length;
      if (event.key === "ArrowRight") next = (current + 1) % METRIC_KEYS.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = METRIC_KEYS.length - 1;
      const target = METRIC_KEYS[next];
      if (target === undefined) return;
      setMetricFocusKey(target);
      const button =
        metricGridNodeRef.current?.querySelector<HTMLButtonElement>(`[data-filter="${target}"]`) ?? null;
      if (button !== null) button.focus({ preventScroll: true });
    },
    [metricFocusKey],
  );

  const moveFocus = useCallback(
    (to: number) => {
      const count = flatRows.length;
      if (count === 0) return;
      const clamped = Math.max(0, Math.min(count - 1, to));
      setActiveIndex(clamped);
      const button = rowRefs.current[clamped];
      if (button !== null && button !== undefined) {
        button.focus({ preventScroll: true });
        button.scrollIntoView({ block: "nearest" });
      }
    },
    [flatRows.length],
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
        moveFocus(flatRows.length - 1);
        return;
      }
      if (event.key === "Escape") {
        // Esc 收起当前行并把焦点留在其触发器（DESIGN §11）。
        const key = rowKey(flatRows[index], index);
        if (expandedKeys.has(key)) {
          event.preventDefault();
          toggleKey(key);
          const button = rowRefs.current[index];
          if (button !== null && button !== undefined) button.focus({ preventScroll: true });
        }
      }
    },
    [flatRows, expandedKeys, moveFocus, toggleKey],
  );

  const enabled = filterControlsEnabled(mode);
  const metricCounts: Record<MetricKey, string> = {
    running: enabled ? String(dash.running) : UNKNOWN_TEXT,
    queued: enabled ? String(dash.queued) : UNKNOWN_TEXT,
    failed: enabled ? String(dash.failed) : UNKNOWN_TEXT,
    completed: enabled ? String(dash.completed) : UNKNOWN_TEXT,
  };

  return (
    <section className="mocl-panel" aria-label="外部代理运行状态" ref={rootRef}>
      <div className="mocl-sr-only" role="status" aria-live="polite">
        {liveText}
      </div>
      <div className="mocl-panel-top">
        <MetricGrid
          enabled={enabled}
          counts={metricCounts}
          filter={filterState.filter}
          focusKey={metricFocusKey}
          gridRef={attachMetricGrid}
          onSelect={selectMetric}
          onKeyDown={onMetricKeyDown}
        />
        <OverviewLine
          mode={mode}
          total={dash.total}
          hiddenLost={hiddenLost}
          syncText={syncText}
          onRetry={onRetry}
        />
        <ListTools enabled={enabled} showLost={!filterState.hideLost} onToggle={toggleShowLost} />
      </div>
      <div className="mocl-scrollport">
        {loading ? (
          <LoadingView />
        ) : failed ? (
          <ErrorView code={snapshot.error?.code ?? UNKNOWN_TEXT} onRetry={onRetry} />
        ) : children.length === 0 ? (
          <EmptyView />
        ) : visible.length === 0 ? (
          <FilterEmptyView onShowAll={onShowAll} />
        ) : (
          groupsRendered.map((group) => {
            const open = isGroupOpen(group.key, groupOpen);
            return (
              <section
                className="mocl-group-section"
                role="group"
                aria-label={`${GROUP_LABELS[group.key]}，${group.rows.length} ${TEXT.filterCountUnit}`}
                key={group.key}
              >
                <h2 className="mocl-group-heading">
                  <button
                    type="button"
                    className={`mocl-group-header mocl-tone-${group.key}`}
                    aria-expanded={open}
                    aria-controls={`mocl-group-list-${group.key}`}
                    onClick={() => toggleGroupOpen(group.key)}
                  >
                    <StatusIcon name={group.key} />
                    <span className="mocl-group-name">{GROUP_LABELS[group.key]}</span>
                    <span className="mocl-group-count">{group.rows.length}</span>
                    <GroupChevron />
                  </button>
                </h2>
                <div
                  className="mocl-agent-list"
                  id={`mocl-group-list-${group.key}`}
                  role="list"
                  aria-label={`${GROUP_LABELS[group.key]}${PANEL_TEXT.groupListSuffix}`}
                  hidden={!open}
                >
                  {group.rows.map((agent) => {
                    const index = flatRows.indexOf(agent);
                    if (index < 0) return null;
                    const key = rowKey(agent, index);
                    return (
                      <AgentRow
                        key={key}
                        agent={agent}
                        index={index}
                        active={index === activeIndex}
                        expanded={expandedKeys.has(key)}
                        nowMs={nowMs}
                        onToggle={() => toggleKey(key)}
                        onKeyDown={(event) => onRowKeyDown(event, index)}
                        rowRef={(el) => {
                          rowRefs.current[index] = el;
                        }}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
