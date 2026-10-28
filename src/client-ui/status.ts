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
  // F3（v1.1 §4）：reported 也必须显式标「实际」；「≈配置值」改为直白「配置值」。
  modelReportedMark: "实际",
  modelConfiguredMark: "配置值",
  modelFallbackMark: "降级",
  // F1 筛选条（v1.1 §2/§7）。
  filterGroupLabel: "按状态筛选",
  filterAll: "全部",
  filterRunning: "运行中",
  filterFailed: "失败",
  filterCompleted: "已完成",
  hideLostLabel: "隐藏已丢失",
  filterCountUnit: "个代理",
  filterEmptyTitle: "该筛选下没有代理",
  filterEmptyDescription: "可切换状态，或查看全部代理。",
  showAll: "查看全部",
  // F2 详情两层（v1.1 §3/§7）：人话区组名与键名。
  taskGroup: "任务",
  copyFullTask: "复制完整任务",
  statusTimeGroup: "状态与时间",
  statusExplanationLabel: "状态说明",
  startedAtLabel: "开始时间",
  usageGroup: "用量",
  inputTokensLabel: "输入 tokens",
  outputTokensLabel: "输出 tokens",
  costLabel: "费用",
  usageDurationLabel: "耗时",
  estimatedNote: "估算值，不用于计费对账",
  runtimeGroup: "实际运行体",
  backendLabel: "后端",
  transportLabel: "通道",
  nativeSessionIdLabel: "原生会话 id",
  backendVersionLabel: "后端版本",
  modelGroup: "模型",
  modelKeyLabel: "实际生效模型",
  technicalDetails: "技术详情",
  technicalLocateHelp: "排障时把这两项提供给 MOCL 维护者，分别定位子代理和本轮日志。",
  technicalContextHelp: "排障时提供给 MOCL 维护者，用于核对任务目录和嵌套层级。",
  technicalRecoveryHelp: "排障时提供给 MOCL 维护者；该值表示该会话被恢复的次数。",
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
  /**
   * 服务端 UsageRef 的展示视图（W5 扩展）：durationMs（实测耗时）沿用 v1；
   * tokens/费用按 v1.1 §3.2 展示；precision=none → 整个用量组不渲染；
   * estimated=true → 数值前加 ≈ 并注明不用于计费对账。缺失 → 未知，不用 0 冒充。
   */
  readonly usage?: {
    readonly durationMs?: number | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly costUsd?: number | null;
    readonly precision?: string | null;
    readonly estimated?: boolean | null;
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

/** 原生会话 id 完整值（runtime.agentId ?? backendSessionId）；缺失 → null。它不是 childId。 */
export function nativeSessionId(agent: PanelAgent | null | undefined): string | null {
  const raw = agent?.runtime?.agentId ?? agent?.backendSessionId ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** 原生 id 短写（runtime.agentId ?? backendSessionId 的前 8 字符）；缺失返回空串。 */
export function nativeShortId(agent: PanelAgent | null | undefined): string {
  const full = nativeSessionId(agent);
  if (full === null) return "";
  return full.slice(0, NATIVE_ID_SHORT_CHARS);
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

export type PanelModelSource = "reported" | "configured" | "fallback" | "unknown";

/** 来源白名单（wire 四值）：越界/缺失一律视为 unknown，不伪装成已知来源。 */
export function isModelSource(value: unknown): value is PanelModelSource {
  return value === "reported" || value === "configured" || value === "fallback" || value === "unknown";
}

export interface PanelModelParts {
  /** 模型主体（缺失/来源不可靠 → 未知；不得截断主体，截断由 CSS 分段处理）。 */
  readonly name: string;
  /** 来源后缀（实际/配置值/降级）；无则空串。 */
  readonly note: string;
  /** 来源判定结果（行内与详情的着色键；仅 reported/configured/fallback 有后缀）。 */
  readonly source: PanelModelSource;
}

/** F3（DESIGN-v1.1 §4）：来源 → 后缀文案；host 侧可能尚未上报 reported，client 不依赖其存在。 */
export const MODEL_SOURCE_LABELS: Readonly<Record<"reported" | "configured" | "fallback", string>> = {
  reported: TEXT.modelReportedMark,
  configured: TEXT.modelConfiguredMark,
  fallback: TEXT.modelFallbackMark,
};

/**
 * 实际模型 + 来源后缀（DESIGN-v1.1 §4）：
 * - reported → 「实际」；configured → 「配置值」；fallback → 「降级」（模型显示原值，不编造档名）；
 * - unknown / 无法识别的来源 / 模型名缺失 → 整体「未知」，不把配置值伪装成实际模型。
 */
export function modelParts(agent: PanelAgent | null | undefined): PanelModelParts {
  const runtime = agent?.runtime ?? null;
  const model = runtime?.model;
  if (typeof model !== "string" || model.length === 0) return { name: UNKNOWN_TEXT, note: "", source: "unknown" };
  const raw = runtime?.modelSource;
  const source: PanelModelSource = isModelSource(raw) ? raw : "unknown";
  const note =
    source === "reported" || source === "configured" || source === "fallback" ? MODEL_SOURCE_LABELS[source] : "";
  if (note === "") return { name: UNKNOWN_TEXT, note: "", source: "unknown" };
  return { name: model, note, source };
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

/* ------------------------------------------------------------------ */
/* W5 F2/F1：状态说明、用量视图、开始时间、隐藏 lost 文案                  */
/* ------------------------------------------------------------------ */

/** 状态说明（DESIGN-v1.1 §3.1）：面向用户的短句，不展示判定优先级或内部架构。 */
export const STATUS_EXPLANATIONS: Readonly<Record<PanelStatusKey, string>> = {
  running: "后端正在执行本轮任务。",
  queued: "任务已接收，正在等待运行槽位。",
  waiting: "任务正在等待你的输入。",
  completed: "本轮任务已完成。",
  aborted: "本轮任务已中止。",
  failed: "本轮执行失败，可查看错误详情。",
  recovering: "正在尝试恢复该代理，尚不能确认已恢复。",
  lost: "当前只能显示代理丢失前的最后已知状态。",
  archived: "该代理已归档，以下内容仅供查看。",
  blocked: "任务已阻塞；原因未知时不作猜测。",
  created: "任务已创建，尚未开始运行。",
  unknown: "当前信息不足，无法判断任务状态。",
};

export function statusExplanation(status: PanelStatusView | PanelStatusKey): string {
  const key = typeof status === "string" ? status : status.key;
  return STATUS_EXPLANATIONS[key];
}

/** 开始时间展示：ISO → 本地 `YYYY-MM-DD HH:mm:ss`；非法/缺失 → null（显示为未知）。 */
export function formatEventTime(value: unknown): string | null {
  const ms = parseIsoMs(value);
  if (ms === null) return null;
  const at = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(
    at.getMinutes(),
  )}:${pad(at.getSeconds())}`;
}

export interface PanelUsageView {
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly costUsd: string;
  /** 与状态区「本轮耗时」同一原值（§3.2：不重复计算、不制造两个数字）。 */
  readonly duration: string;
  readonly estimated: boolean;
}

/**
 * 用量视图（DESIGN-v1.1 §3.2，precision/estimated 规则沿用）：
 * - usage 缺失或 precision=none → null（整个用量组不渲染，不用 0/未知拼假组）；
 * - estimated=true → 数值前加 ≈（「未知」「未开始」不加）；是否估算由调用方注明；
 * - 单项缺失显示「未知」；费用 0 是有效值（$0），负数/非有限数视为缺失。
 */
export function usageView(agent: PanelAgent | null | undefined, nowMs: number): PanelUsageView | null {
  const usage = agent?.usage;
  if (usage === null || usage === undefined) return null;
  if (usage.precision === "none") return null;
  const estimated = usage.estimated === true;
  const approx = estimated ? "≈" : "";
  const finiteNonNegative = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const numberOrUnknown = (value: unknown): string => {
    const num = finiteNonNegative(value);
    return num === null ? UNKNOWN_TEXT : `${approx}${String(num)}`;
  };
  const withApprox = (text: string): string =>
    text === UNKNOWN_TEXT || text === TEXT.notStarted ? text : `${approx}${text}`;
  const cost = finiteNonNegative(usage.costUsd);
  return {
    inputTokens: numberOrUnknown(usage.inputTokens),
    outputTokens: numberOrUnknown(usage.outputTokens),
    costUsd: cost === null ? UNKNOWN_TEXT : `${approx}$${cost}`,
    duration: withApprox(shown(durationText(agent, nowMs))),
    estimated,
  };
}

/** 汇总数旁的隐藏 lost 说明（§2.2）：`（隐藏 N 已丢失）`；无隐藏行时不追加空说明。 */
export function hiddenLostNote(count: number): string {
  return count > 0 ? `（隐藏 ${count} 已丢失）` : "";
}

/** 同上的无障碍名片段：`，隐藏 N 已丢失`；0 → 空串。 */
export function hiddenLostAriaNote(count: number): string {
  return count > 0 ? `，隐藏 ${count} 已丢失` : "";
}

/** 筛选项完整无障碍名（§2.3）：如「运行中，3 个代理」；无可信快照时计数为「未知」。 */
export function filterOptionAccessibleName(label: string, count: string): string {
  return `${label}，${count} ${TEXT.filterCountUnit}`;
}
