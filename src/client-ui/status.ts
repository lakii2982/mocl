/**
 * 面板纯函数层（W2）：状态优先级映射、文案、时间/截断格式化。
 *
 * - 0 依赖、0 DOM：node + vitest 直接测试（tests/client-ui/status.test.ts）。
 * - 规则真源：design/STATES.md §2（13 条组合判定优先级）；文案真源：design/DESIGN.md §12。
 * - 输入是服务端 StatusOutcome 的宽松视图（字段可缺、值可为 null；W1 扩展契约见
 *   .agentspec/issues/18/W1.md §1.1）——缺什么显示「未知」，不猜、不用 0 填充未知数值。
 */

export const UNKNOWN_TEXT = "未知";
export const LABEL_MAX_CHARS = 120;
export const NATIVE_ID_SHORT_CHARS = 8;

/** design/DESIGN.md §12 中文文案清单（单一出处，组件层不得另写文案）。 */
export const TEXT = {
  tab: "外部代理",
  /** W2 §6.1：guide 页入口卡片描述（未注册 guide 则面板不可达）。 */
  guideDescription: "查看 codex/claude-code/kimi/opencode 子代理的真实运行状态",
  summaryRunning: "运行中",
  summaryQueued: "排队",
  summaryFailed: "失败",
  summaryTotal: "共",
  syncSynced: "已同步",
  syncSubscribing: "订阅中",
  syncPolling: "轮询中",
  syncFailed: "同步失败",
  syncJustNow: "刚刚",
  queuedSecondary: "等待槽位",
  drainingSecondary: "正在收尾",
  modelConfiguredMark: "≈配置值",
  modelFallbackMark: "降级",
  emptyTitle: "无外部子代理",
  emptyDescription: "外部子代理会在这里出现",
  errorTitle: "无法获取外部代理状态",
  errorDescription: "请确认宿主已启用并可访问，然后重试。",
  backendDisabledNotice: "该后端已禁用，可在宿主设置中启用。",
  retry: "重试",
  copy: "复制",
  copied: "已复制",
  copyFailed: "复制失败，请手动复制",
  expand: "展开详情",
  collapse: "收起详情",
  durationLabel: "本轮耗时",
  lastActivityLabel: "最后活动",
  notStarted: "未开始",
  statusAriaPrefix: "状态：",
  detailsSuffix: "详情",
  errorDetailsLabel: "错误详情",
  listLabel: "外部子代理列表",
  loadingLabel: "正在加载外部代理状态",
  countsLoadingLabel: "计数加载中",
  countsUnknownLabel: "计数未知",
} as const;

/**
 * 服务端 StatusOutcome（含 W1 扩展）的客户端视图。
 * 全部字段可选：缺失/undefined/null 一律走「未知」兜底，不做跨字段猜测。
 */
export interface PanelAgent {
  readonly childId?: string | null;
  readonly backend?: string | null;
  readonly backendSessionId?: string | null;
  readonly remoteIdState?: string | null;
  readonly state?: string | null;
  readonly activation?: string | null;
  readonly turn?: { readonly state?: string | null } | null;
  readonly epoch?: number | null;
  readonly createdAt?: string | null;
  readonly lastTurnId?: string | null;
  /** W1：任务摘要（服务端已规范化 ≤120）；客户端展示层仍兜底 + 兜底截断。 */
  readonly label?: string | null;
  readonly cwd?: string | null;
  readonly depth?: number | string | null;
  /** W1：epoch ISO。 */
  readonly startedAt?: string | null;
  /** W1：最近事件时间（无事件 = createdAt）。 */
  readonly lastActivityAt?: string | null;
  readonly updatedAt?: string | null;
  readonly runtime?: {
    readonly agentName?: string | null;
    readonly agentId?: string | null;
    readonly backendVersion?: string | null;
    readonly transport?: string | null;
    readonly model?: string | null;
    readonly modelSource?: string | null;
  } | null;
  /** 服务端 UsageRef 的展示视图：v1 只读 durationMs（实测耗时）；缺失 → 未知，不用 0 冒充。 */
  readonly usage?: {
    readonly durationMs?: number | null;
  } | null;
  readonly error?: {
    readonly code?: string | null;
    readonly userMessage?: string | null;
    /** ABI wire 四值：no / once / backoff / after-recovery；展示原值，缺失 → 未知。 */
    readonly retryable?: string | null;
    readonly traceId?: string | null;
  } | null;
}

export type PanelStatusKey =
  | "lost"
  | "recovering"
  | "failed"
  | "aborted"
  | "archived"
  | "completed"
  | "queued"
  | "waiting"
  | "blocked"
  | "running"
  | "created"
  | "unknown";

/** 主状态中文文案（STATES.md §2「主文案」列）。 */
export const STATUS_LABELS: Readonly<Record<PanelStatusKey, string>> = {
  lost: "已丢失",
  recovering: "恢复中",
  failed: "失败",
  aborted: "已中止",
  archived: "已归档",
  completed: "已完成",
  queued: "排队中",
  waiting: "等待输入",
  blocked: "已阻塞",
  running: "运行中",
  created: "待启动",
  unknown: UNKNOWN_TEXT,
};

export interface PanelStatusView {
  readonly key: PanelStatusKey;
  /** 中文主文案（状态点 aria-label 与汇总口径都用它）。 */
  readonly label: string;
  /** 副文案（queued=等待槽位 / draining=正在收尾）；无则空串。 */
  readonly secondary: string;
  /** 图标名（panel.tsx 的 ICON_PATHS 键）。 */
  readonly icon: PanelStatusKey;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function view(key: PanelStatusKey, secondary = ""): PanelStatusView {
  return { key, label: STATUS_LABELS[key], secondary, icon: key };
}

/**
 * 组合判定优先级（design/STATES.md §2 的 13 条，从上到下取第一个命中）。
 * 排队永远不会显示为运行中（规则 7 在 10/11 之前）；失败排在完成之前。
 */
export function statusFor(agent: PanelAgent | null | undefined): PanelStatusView {
  const state = strOf(agent?.state);
  const activation = strOf(agent?.activation);
  const turnState = strOf(agent?.turn?.state);
  if (state === "lost") return view("lost");
  if (state === "recovering") return view("recovering");
  if (turnState === "failed") return view("failed");
  if (state === "aborted" || turnState === "aborted") return view("aborted");
  if (state === "archived") return view("archived");
  if (state === "completed" || turnState === "completed") return view("completed");
  if (activation === "queued") return view("queued", TEXT.queuedSecondary);
  if (state === "awaiting-input" || turnState === "awaiting-input") return view("waiting");
  if (state === "blocked") return view("blocked");
  if (activation === "draining" && (state === "running" || turnState === "running")) {
    return view("running", TEXT.drainingSecondary);
  }
  if (state === "running" || turnState === "running") return view("running");
  if (state === "created" || turnState === "accepted") return view("created");
  return view("unknown");
}

export interface PanelCounts {
  readonly running: number;
  readonly queued: number;
  readonly failed: number;
  readonly total: number;
}

/** 汇总口径（DESIGN §3.2）：与行主状态同一映射结果，不另建口径。 */
export function summaryCounts(agents: readonly PanelAgent[]): PanelCounts {
  let running = 0;
  let queued = 0;
  let failed = 0;
  for (const agent of agents) {
    const key = statusFor(agent).key;
    if (key === "running") running += 1;
    if (key === "queued") queued += 1;
    if (key === "failed") failed += 1;
  }
  return { running, queued, failed, total: agents.length };
}

/* ------------------------------------------------------------------ */
/* 文本兜底与截断                                                       */
/* ------------------------------------------------------------------ */

/** 通用缺失兜底：null / undefined / 空串 → 「未知」。 */
export function shown(value: unknown): string {
  return value === undefined || value === null || value === "" ? UNKNOWN_TEXT : String(value);
}

/**
 * UTF-16 安全截断（W1 §1.1：上限按 UTF-16 code unit 计，与 facade `truncateUtf16Safe`
 * 同语义——截断点落在代理对中间时丢弃高代理，即容忍截到 max-1 保持 emoji 完整）；
 * 超长直接截断，不加省略号（省略交给 CSS）。
 */
export function truncateLabel(value: string, max: number = LABEL_MAX_CHARS): string {
  if (value.length <= max) return value;
  let end = max;
  const lastUnit = value.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** 主行任务摘要：缺失 → 未知；展示值兜底截断 ≤120（title/accessibility name 保留全文）。 */
export function labelText(agent: PanelAgent | null | undefined): string {
  return truncateLabel(shown(agent?.label));
}

/* ------------------------------------------------------------------ */
/* 行内 runtime 与模型                                                   */
/* ------------------------------------------------------------------ */

/** 原生 id 短写（runtime.agentId ?? backendSessionId 的前 8 字符）；缺失返回空串。 */
export function nativeShortId(agent: PanelAgent | null | undefined): string {
  const raw = agent?.runtime?.agentId ?? agent?.backendSessionId ?? null;
  if (typeof raw !== "string" || raw.length === 0) return "";
  return raw.slice(0, NATIVE_ID_SHORT_CHARS);
}

/** 次行前部：`backend · 通道 · 原生 id 短写 · 版本`；任一项缺失为「未知」。 */
export function runtimeLine(agent: PanelAgent | null | undefined): string {
  return [
    shown(agent?.backend),
    shown(agent?.runtime?.transport),
    shown(nativeShortId(agent) === "" ? null : nativeShortId(agent)),
    shown(agent?.runtime?.backendVersion),
  ].join(" · ");
}

export interface PanelModelParts {
  /** 模型主体（缺失 → 未知；不得截断主体，截断由 CSS 分段处理）。 */
  readonly name: string;
  /** 配置/降级标记（≈配置值 / 降级）；无则空串。 */
  readonly note: string;
}

/**
 * 实际模型 + 标记（DESIGN §3.3 / STATES §4.3）：
 * - configured：显示 `≈配置值`（并非已确认的实际返回值）；
 * - fallback：显示 `降级`（DESIGN 示例 `降级:free` 的档名来自旧原型演示数据；
 *   W1 数据契约没有 fallback 档名字段，v1 只如实标注「降级」，不编造档名）。
 */
export function modelParts(agent: PanelAgent | null | undefined): PanelModelParts {
  const model = agent?.runtime?.model;
  if (typeof model !== "string" || model.length === 0) return { name: UNKNOWN_TEXT, note: "" };
  const source = agent?.runtime?.modelSource;
  const note = source === "configured" ? TEXT.modelConfiguredMark : source === "fallback" ? TEXT.modelFallbackMark : "";
  return { name: model, note };
}

/** 单后端禁用：行内提示（不是第五种页面态，不升级整页错误）。 */
export function isBackendDisabled(agent: PanelAgent | null | undefined): boolean {
  return agent?.error?.code === "BACKEND_DISABLED";
}

/* ------------------------------------------------------------------ */
/* 时间                                                                 */
/* ------------------------------------------------------------------ */

export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 秒表格式：`01:23`；≥1h 用 `01:02:03`；非法/负值 → null（显示为未知）。 */
export function formatElapsedMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 相对时间：`12s 前` / `2m 前` / `3h 前` / `5d 前`；负差值（时钟偏斜）按 0 处理。 */
export function formatAge(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

const LIVE_KEYS: readonly PanelStatusKey[] = ["running", "recovering", "waiting", "blocked"];

/** 服务端实测耗时（UsageRef.durationMs）：非有限数/负值 → null（缺失显示为未知，不用 0 冒充）。 */
function usageDurationMs(agent: PanelAgent | null | undefined): number | null {
  const raw = agent?.usage?.durationMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * 当前轮开始时间：v1 wire 没有 turn 级开始时间字段，仅当确有当前轮
 * （lastTurnId / turn.state 任一存在）时才允许用 epoch startedAt 近似；
 * 从未开过轮的记录（lastTurnId=null 且 usage=null）返回 null →「未知」。
 */
function currentTurnStartMs(agent: PanelAgent | null | undefined): number | null {
  const hasTurn = strOf(agent?.lastTurnId) !== null || strOf(agent?.turn?.state) !== null;
  if (!hasTurn) return null;
  return parseIsoMs(agent?.startedAt);
}

/**
 * 右列第一行「本轮耗时」（DESIGN §3.3：queued 尚未开始可显示「未开始」；其他缺失为「未知」）：
 * - queued → 「未开始」；
 * - usage.durationMs（服务端实测）存在 → 直接格式化（>1h 进位 h:mm:ss）；
 * - 无实测值：仅进行中且有当前轮 → now − 当前轮开始时间；
 * - 其余（终态/待启动/未知，或从未开过轮）→ null（显示为未知）——
 *   不拿 lastActivityAt − startedAt 或 epoch 时长冒充实测耗时（不出现 00:00 假 0）。
 */
export function durationText(agent: PanelAgent | null | undefined, nowMs: number): string | null {
  const key = statusFor(agent).key;
  if (key === "queued") return TEXT.notStarted;
  const measured = usageDurationMs(agent);
  if (measured !== null) return formatElapsedMs(measured);
  if (!LIVE_KEYS.includes(key)) return null;
  const start = currentTurnStartMs(agent);
  return start === null ? null : formatElapsedMs(nowMs - start);
}

/** 右列第二行「最后活动」：缺失 → null（显示为未知），不虚构绝对时间。 */
export function lastActivityText(agent: PanelAgent | null | undefined, nowMs: number): string | null {
  const at = parseIsoMs(agent?.lastActivityAt);
  return at === null ? null : formatAge(nowMs - at);
}

/**
 * 同步状态（DESIGN §3.2）：v1 只有轮询（SSE 为 P1）。成功同步后：
 * - 有 lastSeq → `已同步 seq=<n> · <相对时间>`；
 * - 无 lastSeq（seq 为可选，route v1 不返回）→ `已同步 · <相对时间>`，不显示 `seq=未知` 噪声；
 * - 相对时间 <5s → 「刚刚」；无同步时刻 → 「轮询中」。
 */
export function syncReadyText(lastSyncAtMs: number | null, lastSeq: number | null, nowMs: number): string {
  if (lastSyncAtMs === null) return TEXT.syncPolling;
  const ageMs = nowMs - lastSyncAtMs;
  const ageText = Number.isFinite(ageMs) && ageMs < 5_000 ? TEXT.syncJustNow : formatAge(ageMs);
  const seqText = typeof lastSeq === "number" && Number.isSafeInteger(lastSeq) && lastSeq > 0 ? ` seq=${lastSeq}` : "";
  return `${TEXT.syncSynced}${seqText} · ${ageText}`;
}
