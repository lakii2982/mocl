/**
 * W5 F1 筛选条纯逻辑测试（设计真源：design-v11/DESIGN-v1.1.md §2）：
 * - 四种筛选 + hideLost 的行数/计数口径（含 lost 被隐藏时的「共 N（隐藏 M 已丢失）」）；
 * - localStorage 持久化：写入/读取、非法值回默认、切换后刷新恢复、存储不可用仍可用；
 * - 空筛选态与「查看全部」语义；错误/加载态控件禁用、计数显示「未知」不显示 0。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER_STATE,
  FILTER_KEYS,
  FILTER_STORAGE_KEY,
  applyPanelFilter,
  filterControlsEnabled,
  filterCountText,
  filterCounts,
  isPanelFilterKey,
  loadFilterState,
  matchesFilter,
  normalizeFilterState,
  saveFilterState,
  showAllFilterState,
  type FilterStorage,
  type PanelFilterState,
} from "../../src/client-ui/filter.ts";
import {
  TEXT,
  UNKNOWN_TEXT,
  hiddenLostAriaNote,
  hiddenLostNote,
  statusFor,
  type PanelAgent,
} from "../../src/client-ui/status.ts";

function agentOf(patch: Partial<PanelAgent>): PanelAgent {
  return { ...patch };
}

/** 覆盖所有分类的固定全量快照：2 运行中（含 draining 收尾）/1 排队/1 失败/2 已完成/2 已丢失/1 待启动。 */
function fullSnapshot(): PanelAgent[] {
  return [
    agentOf({ childId: "c1", state: "running", activation: "active", turn: { state: "running" } }),
    agentOf({ childId: "c2", state: "running", activation: "draining", turn: { state: "running" } }),
    agentOf({ childId: "c3", state: "created", activation: "queued", turn: { state: "accepted" } }),
    agentOf({ childId: "c4", state: "running", turn: { state: "failed" } }),
    agentOf({ childId: "c5", state: "completed", turn: { state: "completed" } }),
    agentOf({ childId: "c6", state: "completed" }),
    agentOf({ childId: "c7", state: "lost" }),
    agentOf({ childId: "c8", state: "lost" }),
    agentOf({ childId: "c9", state: "created" }),
  ];
}

function memoryStorage(initial: Record<string, string> = {}): FilterStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

const ALL = DEFAULT_FILTER_STATE;

describe("状态分类口径（§2.2 表）", () => {
  it("running 含 draining 收尾；queued/待启动/恢复中不属于任何分段", () => {
    expect(matchesFilter(agentOf({ state: "running", activation: "draining" }), "running")).toBe(true);
    expect(matchesFilter(agentOf({ state: "running", activation: "active" }), "running")).toBe(true);
    expect(matchesFilter(agentOf({ state: "created", activation: "queued" }), "running")).toBe(false);
    expect(matchesFilter(agentOf({ state: "recovering" }), "running")).toBe(false);
    expect(matchesFilter(agentOf({ state: "created" }), "completed")).toBe(false);
  });

  it("failed 只含 failed：lost ≠ failed，aborted 也不是 failed", () => {
    expect(matchesFilter(agentOf({ state: "running", turn: { state: "failed" } }), "failed")).toBe(true);
    expect(matchesFilter(agentOf({ state: "lost" }), "failed")).toBe(false);
    expect(matchesFilter(agentOf({ state: "aborted" }), "failed")).toBe(false);
  });

  it("completed 只含 completed：archived/aborted 不算已完成", () => {
    expect(matchesFilter(agentOf({ state: "completed", turn: { state: "completed" } }), "completed")).toBe(true);
    expect(matchesFilter(agentOf({ state: "archived" }), "completed")).toBe(false);
    expect(matchesFilter(agentOf({ state: "aborted" }), "completed")).toBe(false);
  });

  it("all 匹配一切（含 lost）；四个键齐全且是字面量集合", () => {
    for (const agent of fullSnapshot()) {
      expect(matchesFilter(agent, "all")).toBe(true);
    }
    expect([...FILTER_KEYS]).toEqual(["all", "running", "failed", "completed"]);
    expect(isPanelFilterKey("running")).toBe(true);
    expect(isPanelFilterKey("lost")).toBe(false);
    expect(isPanelFilterKey(42)).toBe(false);
  });
});

describe("四段计数（§2.2：基于全量行，不随 hideLost 改变）", () => {
  it("all=全量（含 lost），running/failed/completed 各按主状态", () => {
    expect(filterCounts(fullSnapshot())).toEqual({ all: 9, running: 2, failed: 1, completed: 2 });
  });

  it("空快照 → 全 0（全局空态四项均 0，控件仍可用）", () => {
    expect(filterCounts([])).toEqual({ all: 0, running: 0, failed: 0, completed: 0 });
  });

  it("lost 行只进 all，不进 failed（lost ≠ failed）", () => {
    const counts = filterCounts([agentOf({ state: "lost" })]);
    expect(counts).toEqual({ all: 1, running: 0, failed: 0, completed: 0 });
  });
});

describe("过滤管线（§2.2 固定顺序：全量 → 分类 → lost 可见性）", () => {
  it("all + 默认隐藏已丢失：visible 去掉 lost，hiddenLost=2", () => {
    const { visible, hiddenLost } = applyPanelFilter(fullSnapshot(), ALL);
    expect(visible).toHaveLength(7);
    expect(visible.some((agent) => agent.state === "lost")).toBe(false);
    expect(hiddenLost).toBe(2);
  });

  it("all + 关闭隐藏：全量行可见（含 lost），hiddenLost=0", () => {
    const { visible, hiddenLost } = applyPanelFilter(fullSnapshot(), { filter: "all", hideLost: false });
    expect(visible).toHaveLength(9);
    expect(visible.some((agent) => agent.state === "lost")).toBe(true);
    expect(hiddenLost).toBe(0);
  });

  it("running + 隐藏：只渲染运行中（含 draining）；hiddenLost 仍按全量 lost 计数", () => {
    const { visible, hiddenLost } = applyPanelFilter(fullSnapshot(), { filter: "running", hideLost: true });
    expect(visible).toHaveLength(2);
    expect(visible.every((agent) => statusFor(agent).key === "running")).toBe(true);
    expect(hiddenLost).toBe(2);
  });

  it("failed / completed 各只渲染对应分类，lost 即使开关关闭也不混入（分类先于 lost）", () => {
    const failed = applyPanelFilter(fullSnapshot(), { filter: "failed", hideLost: false });
    expect(failed.visible.map((agent) => agent.childId)).toEqual(["c4"]);
    expect(failed.hiddenLost).toBe(0);

    const completed = applyPanelFilter(fullSnapshot(), { filter: "completed", hideLost: true });
    expect(completed.visible.map((agent) => agent.childId)).toEqual(["c5", "c6"]);
  });
});

describe("汇总隐藏说明（共 N（隐藏 M 已丢失））", () => {
  it("有隐藏行 → 追加说明；无隐藏行 → 空串（不追加空说明）", () => {
    expect(hiddenLostNote(4)).toBe("（隐藏 4 已丢失）");
    expect(hiddenLostNote(1)).toBe("（隐藏 1 已丢失）");
    expect(hiddenLostNote(0)).toBe("");
  });

  it("无障碍名片段用逗号衔接；汇总口径与全量一致", () => {
    expect(hiddenLostAriaNote(4)).toBe("，隐藏 4 已丢失");
    expect(hiddenLostAriaNote(0)).toBe("");
    const { hiddenLost } = applyPanelFilter(fullSnapshot(), ALL);
    expect(`运行中 2，排队 1，失败 1，共 9${hiddenLostAriaNote(hiddenLost)}`).toBe("运行中 2，排队 1，失败 1，共 9，隐藏 2 已丢失");
  });
});

describe("持久化（§2.4，键 mocl.panel.filter.v1）", () => {
  it("保存为 {filter,hideLost} JSON；读取原样恢复（刷新后不变）", () => {
    const storage = memoryStorage();
    saveFilterState(storage, { filter: "failed", hideLost: false });
    expect(JSON.parse(storage.dump()[FILTER_STORAGE_KEY] as string)).toEqual({ filter: "failed", hideLost: false });
    expect(loadFilterState(storage)).toEqual({ filter: "failed", hideLost: false });
  });

  it("无存储值 / 空存储 → 默认 {all, hideLost:true}（默认隐藏已丢失）", () => {
    expect(loadFilterState(memoryStorage())).toEqual(DEFAULT_FILTER_STATE);
    expect(loadFilterState(null)).toEqual(DEFAULT_FILTER_STATE);
    expect(loadFilterState(undefined)).toEqual(DEFAULT_FILTER_STATE);
    expect(DEFAULT_FILTER_STATE).toEqual({ filter: "all", hideLost: true });
  });

  it("JSON 损坏 / 非对象 → 回默认", () => {
    expect(loadFilterState(memoryStorage({ [FILTER_STORAGE_KEY]: "not-json-at-all" }))).toEqual(DEFAULT_FILTER_STATE);
    expect(loadFilterState(memoryStorage({ [FILTER_STORAGE_KEY]: "42" }))).toEqual(DEFAULT_FILTER_STATE);
    expect(loadFilterState(memoryStorage({ [FILTER_STORAGE_KEY]: "null" }))).toEqual(DEFAULT_FILTER_STATE);
  });

  it("值越界 → 回默认：filter 非法、hideLost 非 boolean，均不做部分修正", () => {
    expect(normalizeFilterState({ filter: "lost", hideLost: true })).toEqual(DEFAULT_FILTER_STATE);
    expect(normalizeFilterState({ filter: "all", hideLost: "yes" })).toEqual(DEFAULT_FILTER_STATE);
    expect(normalizeFilterState({ filter: "all" })).toEqual(DEFAULT_FILTER_STATE);
    expect(normalizeFilterState("running")).toEqual(DEFAULT_FILTER_STATE);
    expect(loadFilterState(memoryStorage({ [FILTER_STORAGE_KEY]: '{"filter":"nonsense","hideLost":true}' }))).toEqual(
      DEFAULT_FILTER_STATE,
    );
    // 合法值不被动过
    expect(normalizeFilterState({ filter: "completed", hideLost: false })).toEqual({
      filter: "completed",
      hideLost: false,
    });
  });

  it("用户切换后立即保存 → 重新 load 等于最新选择（切换后刷新恢复）", () => {
    const storage = memoryStorage();
    let state: PanelFilterState = loadFilterState(storage);
    state = { filter: state.filter, hideLost: false };
    saveFilterState(storage, state);
    state = { filter: "completed", hideLost: state.hideLost };
    saveFilterState(storage, state);
    expect(loadFilterState(storage)).toEqual({ filter: "completed", hideLost: false });
  });

  it("存储抛错（隐私模式）：读取回默认、保存不抛；筛选仍可在当前会话使用", () => {
    const hostile: FilterStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(loadFilterState(hostile)).toEqual(DEFAULT_FILTER_STATE);
    expect(() => saveFilterState(hostile, { filter: "failed", hideLost: true })).not.toThrow();
  });

  it("存储不可用（null）：load 默认值、save 静默 —— 会话内仍可用", () => {
    expect(() => saveFilterState(null, { filter: "failed", hideLost: true })).not.toThrow();
    expect(loadFilterState(null)).toEqual(DEFAULT_FILTER_STATE);
  });
});

describe("空筛选态与「查看全部」（§2.5）", () => {
  it("成功快照非空但可见行为 0 → 进入空筛选态的判定条件", () => {
    // 空筛选态前提是「当前筛选可见 0」：移除 fullSnapshot 仅有的 2 个已完成行（c5/c6，
    // 上方「四段计数」与分类用例断言它们恰为已完成）构造非空但无已完成的快照。
    const agents = fullSnapshot().filter((agent) => agent.childId !== "c5" && agent.childId !== "c6");
    const { visible } = applyPanelFilter(agents, { filter: "completed", hideLost: true });
    expect(visible).toHaveLength(0);
    expect(agents.length).toBeGreaterThan(0); // 非全局空态：EmptyView 不该出现
    // 全局空态（children=[]）永远不进空筛选态：
    expect(applyPanelFilter([], { filter: "completed", hideLost: true }).visible).toHaveLength(0);
  });

  it("「查看全部」= {all, hideLost:false}：应用后真的显示全量行（含 lost）", () => {
    const agents = fullSnapshot();
    const reset = showAllFilterState();
    expect(reset).toEqual({ filter: "all", hideLost: false });
    const { visible, hiddenLost } = applyPanelFilter(agents, reset);
    expect(visible).toHaveLength(agents.length);
    expect(visible.some((agent) => agent.state === "lost")).toBe(true);
    expect(hiddenLost).toBe(0);
  });

  it("空筛选态文案存在且与设计一致（复用空态排版，不加插画）", () => {
    expect(TEXT.filterEmptyTitle).toBe("该筛选下没有代理");
    expect(TEXT.filterEmptyDescription).toBe("可切换状态，或查看全部代理。");
    expect(TEXT.showAll).toBe("查看全部");
    // 全局空态没有「查看全部」：其标题不同。
    expect(TEXT.emptyTitle).toBe("无外部子代理");
  });
});

describe("四态下的控件可用性与计数（§2.5 矩阵）", () => {
  it("加载中/错误态禁用；正常态（含全局空态）可用", () => {
    expect(filterControlsEnabled("loading")).toBe(false);
    expect(filterControlsEnabled("error")).toBe(false);
    expect(filterControlsEnabled("ready")).toBe(true);
  });

  it("无可信快照时计数显示「未知」，不显示 0", () => {
    expect(filterCountText(null)).toBe(UNKNOWN_TEXT);
    expect(filterCountText(0)).toBe("0");
    expect(filterCountText(3)).toBe("3");
  });

  it("筛选条与选项的文案/无障碍名齐备", () => {
    expect(TEXT.filterGroupLabel).toBe("按状态筛选");
    expect(TEXT.filterAll).toBe("全部");
    expect(TEXT.filterRunning).toBe("运行中");
    expect(TEXT.filterFailed).toBe("失败");
    expect(TEXT.filterCompleted).toBe("已完成");
    expect(TEXT.hideLostLabel).toBe("隐藏已丢失");
    expect(TEXT.filterCountUnit).toBe("个代理");
  });
});
