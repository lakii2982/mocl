/**
 * v1.2 分组仪表盘视图模型（W6）—— 设计真源：design-v12/DESIGN-v1.2.md §2/§3。
 *
 * - 纯函数、0 DOM、0 react：panel.tsx 只做渲染接线；tests/client-ui/groups.test.ts 直接测试。
 *   （react 是 esbuild external、不在 node_modules，vitest 无法 import panel.tsx，
 *   因此分组逻辑按 W5 惯例落在独立 .ts 模块。）
 * - 口径全部沿用既有纯层，不另建第二套：
 *   · 行主状态 = statusFor(agent).key（design/STATES.md §2 的 13 条优先级，status.ts）；
 *   · 四块计数 = 对全量快照按 statusFor 分类（§2.1 表：running 含 draining、不含 queued/recovering；
 *     queued 仅 queued；failed 仅 failed，不含 lost/aborted/blocked；completed 仅 completed，
 *     不含 archived/aborted）；total = 全量行数（含 lost），不受筛选与 lost 可见性影响（§1）。
 *   · 可见行 = §2.2 固定顺序：全量快照 → 状态分类 → lost 可见性；选中主组时即使开关打开
 *     也不混入 lost。该规则是 filter.ts applyPanelFilter 的超集（增加 v1.2 明确需要的 queued 段）；
 *     W6 冻结 filter.ts（其缺陷由另一 child 修复），待其增补 queued 键后两者口径一致。
 * - 组序固定：运行中 → 排队 → 失败 → 已完成 → 已丢失 →（兜底）其他状态；
 *   「其他状态」只有快照实际包含非主状态行时才出现（§3.1 兜底组，不改变 STATES.md 口径）。
 * - 组折叠状态持久化走独立键 `mocl.panel.groups.v1`（W6 §2：折叠状态记住；v1.2 §2.2 的
 *   筛选持久化键 `mocl.panel.filter.v1` 结构不变，两键不混用）。损坏/越界回退默认展开态。
 */
import { statusFor, type PanelAgent } from "./status.ts";
import { isLost, type FilterStorage } from "./filter.ts";

export type MetricKey = "running" | "queued" | "failed" | "completed";
export type GroupKey = MetricKey | "lost" | "other";
/** v1.2 筛选口径（§2.2）：在 v1.1 的 all/running/failed/completed 上增加 queued。 */
export type ViewFilterKey = "all" | MetricKey;

export interface ViewFilterState {
  readonly filter: ViewFilterKey;
  readonly hideLost: boolean;
}

/** 四个计数块顺序固定（§2.1）。 */
export const METRIC_KEYS = ["running", "queued", "failed", "completed"] as const;

/**
 * 计数块/组头短标签（§2.1/§3.1：「排队」用短标签；行内状态芯片仍用 statusFor 的
 * 「排队中」，STATES.md 主文案不变）。
 */
export const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  running: "运行中",
  queued: "排队",
  failed: "失败",
  completed: "已完成",
};

export const GROUP_KEYS: readonly GroupKey[] = ["running", "queued", "failed", "completed", "lost", "other"];

export const GROUP_LABELS: Readonly<Record<GroupKey, string>> = {
  ...METRIC_LABELS,
  lost: "已丢失",
  other: "其他状态",
};

/** 默认展开前三组；已完成/已丢失/兜底组默认折叠（§3.1）。 */
export const GROUP_DEFAULT_OPEN: Readonly<Record<GroupKey, boolean>> = {
  running: true,
  queued: true,
  failed: true,
  completed: false,
  lost: false,
  other: false,
};

/** 组折叠持久化键（独立于 mocl.panel.filter.v1；W6 §2「折叠状态记住」）。 */
export const GROUP_STORAGE_KEY = "mocl.panel.groups.v1";

/**
 * v1.2 新增文案。status.ts 的 TEXT 是 W2/W5 冻结的单一文案出处、W6 不改；
 * 这里只收 v1.2 增量，能复用 TEXT 的（共/个代理/已同步…）一律在渲染层复用 TEXT。
 */
export const PANEL_TEXT = {
  metricGroupLabel: "按状态查看",
  listToolsLabel: "按状态分组",
  showLostLabel: "显示已丢失",
  onlyThisPrefix: "只看",
  cancelFilterPrefix: "取消筛选",
  selectedOnlyHint: "✓ 只看此组，再次点击取消",
  groupListSuffix: "代理列表",
} as const;

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === "string" && (METRIC_KEYS as readonly string[]).includes(value);
}

export function isGroupKey(value: unknown): value is GroupKey {
  return typeof value === "string" && (GROUP_KEYS as readonly string[]).includes(value);
}

export function isViewFilterKey(value: unknown): value is ViewFilterKey {
  return value === "all" || isMetricKey(value);
}

/** 计数块点击语义（§2.1）：再点同块取消 → 回全部；点另一块直接切换。 */
export function nextViewFilter(key: MetricKey, current: ViewFilterKey): ViewFilterKey {
  return current === key ? "all" : key;
}

export interface DashboardCounts {
  readonly running: number;
  readonly queued: number;
  readonly failed: number;
  readonly completed: number;
  /** 全量行数（含 lost；§1：计数基于本次成功查询的全量快照）。 */
  readonly total: number;
}

/** 四块计数（§2.1 表）：与行主状态同一 statusFor 映射结果，不另建口径。 */
export function dashboardCounts(agents: readonly PanelAgent[]): DashboardCounts {
  let running = 0;
  let queued = 0;
  let failed = 0;
  let completed = 0;
  for (const agent of agents) {
    const key = statusFor(agent).key;
    if (key === "running") running += 1;
    else if (key === "queued") queued += 1;
    else if (key === "failed") failed += 1;
    else if (key === "completed") completed += 1;
  }
  return { running, queued, failed, completed, total: agents.length };
}

/** 快照中 lost 行数（§2.2「（隐藏 M 已丢失）」只看全量快照）。 */
export function lostCount(agents: readonly PanelAgent[]): number {
  let count = 0;
  for (const agent of agents) if (isLost(agent)) count += 1;
  return count;
}

/** 开关开启时被隐藏的 lost 行数；开关关闭为 0（无隐藏即无说明）。 */
export function hiddenLostCount(agents: readonly PanelAgent[], hideLost: boolean): number {
  return hideLost ? lostCount(agents) : 0;
}

/**
 * 可见行（§2.2 固定顺序：全量快照 → 状态分类 → lost 可见性）。
 * 选中主组时只按 statusFor 分类过滤，即使「显示已丢失」打开也不混入 lost（§2.2）。
 */
export function visibleRows(
  agents: readonly PanelAgent[],
  filter: ViewFilterKey,
  hideLost: boolean,
): readonly PanelAgent[] {
  if (filter !== "all") {
    return agents.filter((agent) => statusFor(agent).key === filter);
  }
  return agents.filter((agent) => !(hideLost && isLost(agent)));
}

/** 行所属组：五个主状态之外（等待输入/恢复中/已中止/已归档/已阻塞/待启动/未知）归兜底组。 */
export function groupKeyOf(agent: PanelAgent | null | undefined): GroupKey {
  const key = statusFor(agent).key;
  return key === "running" || key === "queued" || key === "failed" || key === "completed" || key === "lost"
    ? key
    : "other";
}

export interface PanelStatusGroup {
  readonly key: GroupKey;
  /** 组内行（快照顺序保持不变，W6 §3「组内顺序」）。 */
  readonly rows: readonly PanelAgent[];
}

/**
 * 固定组序分区（§3.1）：只返回非空组（空组不渲染 header）；
 * 「其他状态」仅在快照实际包含非主状态行时出现。
 */
export function groupRows(agents: readonly PanelAgent[]): readonly PanelStatusGroup[] {
  const buckets = new Map<GroupKey, PanelAgent[]>();
  for (const agent of agents) {
    const key = groupKeyOf(agent);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [agent]);
    else bucket.push(agent);
  }
  const groups: PanelStatusGroup[] = [];
  for (const key of GROUP_KEYS) {
    const rows = buckets.get(key);
    if (rows !== undefined && rows.length > 0) groups.push({ key, rows });
  }
  return groups;
}

/**
 * 展开组的行按组序扁平化（§3.3：键盘 ↑/↓ 与 roving tabindex 只走可见行，
 * 折叠组内的行不可聚焦）。isOpen 由渲染层传入（折叠状态在 panel 持有）。
 */
export function flattenGroupRows(
  groups: readonly PanelStatusGroup[],
  isOpen: (key: GroupKey) => boolean,
): readonly PanelAgent[] {
  const rows: PanelAgent[] = [];
  for (const group of groups) {
    if (isOpen(group.key)) rows.push(...group.rows);
  }
  return rows;
}

export type GroupOpenState = Partial<Record<GroupKey, boolean>>;

/** 形状越界一律丢弃（只保留已知组键上的布尔值），不做部分猜测。 */
export function normalizeGroupOpenState(raw: unknown): GroupOpenState {
  if (raw === null || typeof raw !== "object") return {};
  const result: GroupOpenState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isGroupKey(key) && typeof value === "boolean") result[key] = value;
  }
  return result;
}

/** 存储不可用/损坏 → 空覆盖表（回默认展开态），不影响会话内折叠。 */
export function loadGroupOpenState(storage: FilterStorage | null | undefined): GroupOpenState {
  if (storage === null || storage === undefined) return {};
  try {
    const raw = storage.getItem(GROUP_STORAGE_KEY);
    if (raw === null) return {};
    return normalizeGroupOpenState(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** 每次用户变更后立即保存；存储抛错（隐私模式等）静默吞掉。 */
export function saveGroupOpenState(storage: FilterStorage | null | undefined, state: GroupOpenState): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(GROUP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

/** 组当前是否展开：持久化覆盖优先，缺省用默认展开态（前三组开、其余折）。 */
export function isGroupOpen(key: GroupKey, saved: GroupOpenState): boolean {
  const savedValue = saved[key];
  return typeof savedValue === "boolean" ? savedValue : GROUP_DEFAULT_OPEN[key];
}
