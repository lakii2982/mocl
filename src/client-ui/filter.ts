/**
 * 面板筛选状态（W5 F1）—— 设计真源：design-v11/DESIGN-v1.1.md §2。
 *
 * - 0 DOM（localStorage 以最小接口注入）→ node + vitest 直接测试（tests/client-ui/filter.test.ts）。
 * - 计数口径：所有 N 基于**本次成功查询的全量行**，不受「隐藏已丢失」影响（§2.2）。
 * - 过滤顺序固定：全量快照 → 状态分类 → lost 可见性 → 渲染（§2.2）。
 * - 持久化键固定 `mocl.panel.filter.v1`；读取失败 / JSON 损坏 / 值越界 → 默认值；
 *   存储不可用时筛选仍可在当前会话使用（§2.4），不显示阻断错误。
 */
import { UNKNOWN_TEXT, statusFor, type PanelAgent } from "./status.ts";

export const FILTER_STORAGE_KEY = "mocl.panel.filter.v1";

export const FILTER_KEYS = ["all", "running", "failed", "completed"] as const;
export type PanelFilterKey = (typeof FILTER_KEYS)[number];

export interface PanelFilterState {
  readonly filter: PanelFilterKey;
  readonly hideLost: boolean;
}

/** 默认值（§2.4）：全部 + 隐藏已丢失。 */
export const DEFAULT_FILTER_STATE: PanelFilterState = { filter: "all", hideLost: true };

/** localStorage 的最小面（便于 node 测试注入 fake；panel 传 window.localStorage）。 */
export interface FilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isPanelFilterKey(value: unknown): value is PanelFilterKey {
  return typeof value === "string" && (FILTER_KEYS as readonly string[]).includes(value);
}

/** 形状/取值越界一律回默认值（§2.4），不做部分修正。 */
export function normalizeFilterState(raw: unknown): PanelFilterState {
  if (raw === null || typeof raw !== "object") return DEFAULT_FILTER_STATE;
  const candidate = raw as { filter?: unknown; hideLost?: unknown };
  if (!isPanelFilterKey(candidate.filter) || typeof candidate.hideLost !== "boolean") return DEFAULT_FILTER_STATE;
  return { filter: candidate.filter, hideLost: candidate.hideLost };
}

export function loadFilterState(storage: FilterStorage | null | undefined): PanelFilterState {
  if (storage === null || storage === undefined) return DEFAULT_FILTER_STATE;
  try {
    const raw = storage.getItem(FILTER_STORAGE_KEY);
    if (raw === null) return DEFAULT_FILTER_STATE;
    return normalizeFilterState(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_FILTER_STATE;
  }
}

/** 每次用户变更后立即保存；存储抛错（隐私模式等）静默吞掉，不影响会话内筛选。 */
export function saveFilterState(storage: FilterStorage | null | undefined, state: PanelFilterState): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

/** lost 是 wire 原值（statusFor(lost).key === "lost"，不等于 failed）。 */
export function isLost(agent: PanelAgent | null | undefined): boolean {
  return agent?.state === "lost";
}

/** 状态分类（§2.2 表）：running 含 draining 收尾；failed 只含 failed；completed 只含 completed。 */
export function matchesFilter(agent: PanelAgent | null | undefined, filter: PanelFilterKey): boolean {
  if (filter === "all") return true;
  return statusFor(agent).key === filter;
}

export interface PanelFilterCounts {
  readonly all: number;
  readonly running: number;
  readonly failed: number;
  readonly completed: number;
}

/** 四段计数：只依赖全量行，hideLost 不参与（分段 N 与汇总 N 始终不因开关改变）。 */
export function filterCounts(agents: readonly PanelAgent[]): PanelFilterCounts {
  let running = 0;
  let failed = 0;
  let completed = 0;
  for (const agent of agents) {
    const key = statusFor(agent).key;
    if (key === "running") running += 1;
    else if (key === "failed") failed += 1;
    else if (key === "completed") completed += 1;
  }
  return { all: agents.length, running, failed, completed };
}

export interface PanelFilterResult {
  readonly visible: readonly PanelAgent[];
  /** 开启隐藏时全量快照中被隐藏的 lost 行数（汇总「共 N（隐藏 M 已丢失）」用）。 */
  readonly hiddenLost: number;
}

/** 全量 → 分类 → lost 可见性（§2.2 固定顺序）。 */
export function applyPanelFilter(agents: readonly PanelAgent[], state: PanelFilterState): PanelFilterResult {
  const visible = agents.filter((agent) => matchesFilter(agent, state.filter) && !(state.hideLost && isLost(agent)));
  const hiddenLost = state.hideLost ? agents.filter((agent) => isLost(agent)).length : 0;
  return { visible, hiddenLost };
}

/** 「查看全部」（§2.5）：回 all 且关闭 lost 隐藏并持久化，保证真的显示全量行。 */
export function showAllFilterState(): PanelFilterState {
  return { filter: "all", hideLost: false };
}

/** 控件可用性（§2.5）：只有拿到可信全量快照（ready，含全局空态）才可用；加载/错误禁用。 */
export function filterControlsEnabled(mode: "loading" | "error" | "ready"): boolean {
  return mode === "ready";
}

/** 无可信快照时 N 显示「未知」，不显示 0（§2.2/§2.5）。 */
export function filterCountText(count: number | null): string {
  return count === null ? UNKNOWN_TEXT : String(count);
}
