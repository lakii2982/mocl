/**
 * W6 v1.2 分组仪表盘视图模型测试（设计真源：design-v12/DESIGN-v1.2.md §2/§3）：
 * - 分组函数：固定组序（运行中→排队→失败→已完成→已丢失→其他状态）、组内保持快照顺序、
 *   空组不渲染、兜底组仅在快照确有非主状态时出现；
 * - 四块计数口径（§2.1 表）：running 含 draining、queued 仅 queued、failed 仅 failed、
 *   completed 仅 completed；total = 全量行数（含 lost）；
 * - 可见行 = §2.2 固定顺序：全量 → 分类 → lost 可见性；选中主组不混入 lost；
 * - 计数块点击语义：再点同块取消 → 全部；
 * - 组折叠持久化：独立键 mocl.panel.groups.v1，损坏/越界回默认，前三组默认展开；
 * - 行扁平化：折叠组内的行不可聚焦（键盘 roving tabindex 只走可见行）。
 * panel.tsx 只做渲染接线（react 为 esbuild external，vitest 不可 import），
 * 因此断言视图模型即等价断言 DOM 分组结构与 aria 输入。
 */
import { describe, expect, it } from "vitest";
import { statusFor, type PanelAgent } from "../../src/client-ui/status.ts";
import { FILTER_STORAGE_KEY, type FilterStorage } from "../../src/client-ui/filter.ts";
import {
  GROUP_DEFAULT_OPEN,
  GROUP_KEYS,
  GROUP_LABELS,
  GROUP_STORAGE_KEY,
  METRIC_KEYS,
  METRIC_LABELS,
  PANEL_TEXT,
  dashboardCounts,
  flattenGroupRows,
  groupKeyOf,
  groupRows,
  hiddenLostCount,
  isGroupOpen,
  isMetricKey,
  isViewFilterKey,
  loadGroupOpenState,
  lostCount,
  nextViewFilter,
  normalizeGroupOpenState,
  saveGroupOpenState,
  visibleRows,
  type GroupKey,
  type PanelStatusGroup,
} from "../../src/client-ui/groups.ts";

/* ------------------------------------------------------------------ */
/* 夹具：各主状态的最小判定输入（statusFor 的 13 条优先级见 status.ts） */
/* ------------------------------------------------------------------ */

function agent(patch: Partial<PanelAgent>): PanelAgent {
  return { ...patch };
}

const RUNNING_A = agent({ state: "running", activation: "active", turn: { state: "running" }, label: "评审 PR#14" });
const RUNNING_DRAIN = agent({ state: "running", activation: "draining", turn: { state: "running" }, label: "收尾中" });
const QUEUED = agent({ state: "created", activation: "queued", turn: { state: "accepted" }, label: "排队任务" });
const FAILED = agent({ state: "completed", turn: { state: "failed" }, label: "失败任务" });
const COMPLETED = agent({ state: "completed", activation: "inactive", turn: { state: "completed" }, label: "完成任务" });
const LOST = agent({ state: "lost", label: "丢失代理" });
const WAITING = agent({ state: "awaiting-input", label: "等待输入" });
const BLOCKED = agent({ state: "blocked", label: "已阻塞" });
const CREATED = agent({ state: "created", label: "待启动" });
const UNKNOWN = agent({ label: "无法判定" });
const RECOVERING = agent({ state: "recovering", label: "恢复中" });
const ABORTED = agent({ state: "aborted", label: "已中止" });
const ARCHIVED = agent({ state: "archived", label: "已归档" });

/** 乱序快照：覆盖六个组（含兜底组），并保证组内可断言「快照顺序」。 */
const SCRAMBLED: readonly PanelAgent[] = [
  COMPLETED,
  LOST,
  WAITING,
  RUNNING_DRAIN,
  QUEUED,
  RUNNING_A,
  FAILED,
  CREATED,
  UNKNOWN,
  BLOCKED,
];

function labelsOf(rows: readonly PanelAgent[]): string[] {
  return rows.map((row) => row.label ?? "");
}

function keysOf(groups: readonly PanelStatusGroup[]): GroupKey[] {
  return groups.map((group) => group.key);
}

/* ------------------------------------------------------------------ */
/* fake storage（FilterStorage 最小面，同 filter.test.ts 惯例）          */
/* ------------------------------------------------------------------ */

interface FakeStorage extends FilterStorage {
  readonly dump: Map<string, string>;
  failWrites(): void;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const dump = new Map<string, string>(Object.entries(initial));
  let failing = false;
  return {
    dump,
    failWrites() {
      failing = true;
    },
    getItem(key) {
      return dump.get(key) ?? null;
    },
    setItem(key, value) {
      if (failing) throw new Error("quota exceeded");
      dump.set(key, value);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 分组：组序 / 组内顺序 / 空组 / 兜底组                                  */
/* ------------------------------------------------------------------ */

describe("分组（§3.1：固定组序、空组不渲染、兜底组）", () => {
  it("组序固定：运行中 → 排队 → 失败 → 已完成 → 已丢失 → 其他状态", () => {
    expect(keysOf(groupRows(SCRAMBLED))).toEqual(["running", "queued", "failed", "completed", "lost", "other"]);
    expect(GROUP_KEYS).toEqual(["running", "queued", "failed", "completed", "lost", "other"]);
  });

  it("空组不渲染：没有排队的快照不产生排队组", () => {
    const groups = groupRows([RUNNING_A, COMPLETED]);
    expect(keysOf(groups)).toEqual(["running", "completed"]);
  });

  it("组内保持快照顺序（乱序输入不重排组内行）", () => {
    const groups = groupRows(SCRAMBLED);
    const running = groups.find((group) => group.key === "running");
    const other = groups.find((group) => group.key === "other");
    expect(labelsOf(running?.rows ?? [])).toEqual(["收尾中", "评审 PR#14"]);
    expect(labelsOf(other?.rows ?? [])).toEqual(["等待输入", "待启动", "无法判定", "已阻塞"]);
  });

  it("兜底组「其他状态」仅在快照实际包含非主状态行时出现；其余主状态行不消失", () => {
    // 纯主状态快照：无兜底组
    expect(keysOf(groupRows([RUNNING_A, QUEUED, FAILED, COMPLETED, LOST]))).toEqual([
      "running",
      "queued",
      "failed",
      "completed",
      "lost",
    ]);
    // 含非主状态：兜底组收留 waiting/recovering/aborted/archived/blocked/created/unknown
    const groups = groupRows([RUNNING_A, WAITING, RECOVERING, ABORTED, ARCHIVED, BLOCKED, CREATED, UNKNOWN]);
    const other = groups.find((group) => group.key === "other");
    expect(other).toBeDefined();
    expect(other?.rows).toHaveLength(7);
  });

  it("groupKeyOf 与 statusFor 同源：13 级主状态各归其组，其余归 other", () => {
    expect(groupKeyOf(RUNNING_A)).toBe("running");
    expect(groupKeyOf(RUNNING_DRAIN)).toBe("running");
    expect(groupKeyOf(QUEUED)).toBe("queued");
    expect(groupKeyOf(FAILED)).toBe("failed");
    expect(groupKeyOf(COMPLETED)).toBe("completed");
    expect(groupKeyOf(LOST)).toBe("lost");
    for (const row of [WAITING, RECOVERING, ABORTED, ARCHIVED, BLOCKED, CREATED, UNKNOWN]) {
      expect(groupKeyOf(row)).toBe("other");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 四块计数口径（§2.1 表）                                               */
/* ------------------------------------------------------------------ */

describe("四块计数（§2.1：全量快照 + statusFor 口径，不受筛选/开关影响）", () => {
  it("运行中含 draining；不含 queued/recovering", () => {
    const counts = dashboardCounts([RUNNING_A, RUNNING_DRAIN, QUEUED, RECOVERING]);
    expect(counts.running).toBe(2);
    expect(counts.queued).toBe(1);
  });

  it("失败仅 failed，不含 lost/aborted/blocked；已完成仅 completed，不含 archived/aborted", () => {
    const counts = dashboardCounts([FAILED, LOST, ABORTED, BLOCKED, COMPLETED, ARCHIVED]);
    expect(counts.failed).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.queued).toBe(0);
  });

  it("total 为全量行数（含 lost），四块合计可以小于 total", () => {
    const counts = dashboardCounts(SCRAMBLED);
    expect(counts).toEqual({ running: 2, queued: 1, failed: 1, completed: 1, total: 10 });
    expect(lostCount(SCRAMBLED)).toBe(1);
  });

  it("空快照全为 0（成功空查询显示 0，不用未知）", () => {
    expect(dashboardCounts([])).toEqual({ running: 0, queued: 0, failed: 0, completed: 0, total: 0 });
  });

  it("hiddenLostCount：只看全量快照与开关，不随筛选口径变化", () => {
    expect(hiddenLostCount(SCRAMBLED, true)).toBe(1);
    expect(hiddenLostCount(SCRAMBLED, false)).toBe(0);
    expect(hiddenLostCount([LOST, LOST], true)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 可见行：§2.2 固定顺序（全量 → 分类 → lost 可见性）                     */
/* ------------------------------------------------------------------ */

describe("可见行（§2.2：选中主组不混入 lost；开关只影响 all 视图）", () => {
  it("all + 隐藏已丢失（默认）：lost 不渲染", () => {
    expect(labelsOf(visibleRows(SCRAMBLED, "all", true))).not.toContain("丢失代理");
  });

  it("all + 显示已丢失：lost 行出现在结果中（渲染层置于组序末尾）", () => {
    expect(labelsOf(visibleRows(SCRAMBLED, "all", false))).toContain("丢失代理");
  });

  it("选中 running：含 draining 收尾，不含 queued/recovering；即使开关打开也不混入 lost", () => {
    const rows = visibleRows([RUNNING_A, RUNNING_DRAIN, QUEUED, RECOVERING, LOST], "running", false);
    expect(labelsOf(rows)).toEqual(["评审 PR#14", "收尾中"]);
  });

  it("选中 queued / failed / completed：严格按 statusFor 分类，不含相邻状态", () => {
    const pool = [QUEUED, FAILED, COMPLETED, LOST, ABORTED, CREATED];
    expect(labelsOf(visibleRows(pool, "queued", true))).toEqual(["排队任务"]);
    expect(labelsOf(visibleRows(pool, "failed", true))).toEqual(["失败任务"]);
    expect(labelsOf(visibleRows(pool, "completed", true))).toEqual(["完成任务"]);
  });
});

/* ------------------------------------------------------------------ */
/* 计数块点击语义（§2.1）：再点同块取消 → 全部                            */
/* ------------------------------------------------------------------ */

describe("计数块点击语义（§2.1）", () => {
  it("未选 → 只看该组；再点同块 → 回全部；点另一块 → 直接切换", () => {
    expect(nextViewFilter("running", "all")).toBe("running");
    expect(nextViewFilter("running", "running")).toBe("all");
    expect(nextViewFilter("queued", "failed")).toBe("queued");
  });

  it("筛选键集合 = all + 四块；isMetricKey/isViewFilterKey 不放行越界值", () => {
    expect(METRIC_KEYS).toEqual(["running", "queued", "failed", "completed"]);
    for (const key of METRIC_KEYS) {
      expect(isMetricKey(key)).toBe(true);
      expect(isViewFilterKey(key)).toBe(true);
    }
    expect(isViewFilterKey("all")).toBe(true);
    expect(isMetricKey("lost")).toBe(false);
    expect(isViewFilterKey("archived")).toBe(false);
    expect(isViewFilterKey(42)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 组折叠持久化（W6 §2「折叠状态记住」；键 mocl.panel.groups.v1）         */
/* ------------------------------------------------------------------ */

describe("组折叠持久化（键 mocl.panel.groups.v1，独立于筛选键）", () => {
  it("存储键与筛选键不同名（{filter,hideLost} 结构不被混用）", () => {
    expect(GROUP_STORAGE_KEY).toBe("mocl.panel.groups.v1");
    expect(GROUP_STORAGE_KEY).not.toBe(FILTER_STORAGE_KEY);
  });

  it("默认展开态：前三组开，已完成/已丢失/其他状态折叠", () => {
    expect(GROUP_DEFAULT_OPEN).toEqual({
      running: true,
      queued: true,
      failed: true,
      completed: false,
      lost: false,
      other: false,
    });
    const saved = loadGroupOpenState(fakeStorage());
    for (const key of GROUP_KEYS) {
      expect(isGroupOpen(key, saved)).toBe(GROUP_DEFAULT_OPEN[key]);
    }
  });

  it("读取：合法覆盖生效（已完成展开、运行中折叠），缺省键回默认", () => {
    const storage = fakeStorage({ [GROUP_STORAGE_KEY]: JSON.stringify({ completed: true, running: false }) });
    const saved = loadGroupOpenState(storage);
    expect(isGroupOpen("completed", saved)).toBe(true);
    expect(isGroupOpen("running", saved)).toBe(false);
    expect(isGroupOpen("queued", saved)).toBe(true);
    expect(isGroupOpen("lost", saved)).toBe(false);
  });

  it("读取：损坏 JSON / 非对象 / 越界键 / 非布尔值 → 丢弃该覆盖，不抛错", () => {
    expect(loadGroupOpenState(fakeStorage({ [GROUP_STORAGE_KEY]: "{not json" }))).toEqual({});
    expect(loadGroupOpenState(fakeStorage({ [GROUP_STORAGE_KEY]: "42" }))).toEqual({});
    expect(loadGroupOpenState(fakeStorage({ [GROUP_STORAGE_KEY]: JSON.stringify({ running: "yes", nope: true }) }))).toEqual({});
    expect(normalizeGroupOpenState(null)).toEqual({});
    expect(normalizeGroupOpenState([true])).toEqual({});
  });

  it("存储不可用（null）→ 空覆盖表；筛选/折叠仍可在会话内使用", () => {
    expect(loadGroupOpenState(null)).toEqual({});
    expect(loadGroupOpenState(undefined)).toEqual({});
  });

  it("保存：round-trip；写入抛错（隐私模式）静默吞掉；null 存储不抛错", () => {
    const storage = fakeStorage();
    saveGroupOpenState(storage, { completed: true, lost: true });
    expect(loadGroupOpenState(storage)).toEqual({ completed: true, lost: true });

    const broken = fakeStorage();
    broken.failWrites();
    expect(() => saveGroupOpenState(broken, { completed: true })).not.toThrow();
    expect(() => saveGroupOpenState(null, { completed: true })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 行扁平化（§3.3：键盘 roving tabindex 只走可见行）                      */
/* ------------------------------------------------------------------ */

describe("行扁平化（折叠组内的行不可聚焦）", () => {
  it("只收集展开组的行，顺序 = 组序 × 组内序", () => {
    const groups = groupRows(SCRAMBLED);
    const allOpen = flattenGroupRows(groups, () => true);
    expect(labelsOf(allOpen)).toEqual([
      "收尾中",
      "评审 PR#14", // running（组内快照序）
      "排队任务", // queued
      "失败任务", // failed
      "完成任务", // completed
      "丢失代理", // lost
      "等待输入",
      "待启动",
      "无法判定",
      "已阻塞", // other
    ]);
    const onlyCompletedOpen = flattenGroupRows(groups, (key) => key === "completed");
    expect(labelsOf(onlyCompletedOpen)).toEqual(["完成任务"]);
  });

  it("全部折叠 → 空扁平序（此时无行可聚焦）", () => {
    expect(flattenGroupRows(groupRows(SCRAMBLED), () => false)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* v1.2 文案面（短标签 / 开关语义；status.ts TEXT 冻结，增量收在 groups） */
/* ------------------------------------------------------------------ */

describe("v1.2 文案面", () => {
  it("组头/计数块用短标签「排队」，行内芯片仍是 statusFor 的「排队中」（STATES.md 口径不变）", () => {
    expect(METRIC_LABELS.queued).toBe("排队");
    expect(GROUP_LABELS.queued).toBe("排队");
    expect(statusFor(QUEUED).label).toBe("排队中");
    expect(GROUP_LABELS.lost).toBe("已丢失");
    expect(GROUP_LABELS.other).toBe("其他状态");
  });

  it("开关语义是「显示已丢失」（默认关 = 隐藏），与 v1.1「隐藏已丢失」相反", () => {
    expect(PANEL_TEXT.showLostLabel).toBe("显示已丢失");
    expect(PANEL_TEXT.metricGroupLabel).toBe("按状态查看");
    expect(PANEL_TEXT.listToolsLabel).toBe("按状态分组");
    expect(PANEL_TEXT.onlyThisPrefix).toBe("只看");
    expect(PANEL_TEXT.cancelFilterPrefix).toBe("取消筛选");
  });
});
