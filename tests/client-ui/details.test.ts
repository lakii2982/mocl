/**
 * W5 F2/F3 详情视图模型测试（设计真源：design-v11/DESIGN-v1.1.md §3/§4）：
 * - 硬要求：默认展开（人话区）不含 cwd/depth/epoch/turnId 字样；技术详情恰为 5 个字段且只在第二层；
 * - 复制按钮目标正确（任务全文 / 原生会话 id 完整值 / childId / turnId / traceId）；
 * - 用量 precision/estimated 规则；模型来源标识；开始时间格式。
 * panel.tsx 只做通用渲染，因此断言视图模型即等价断言 DOM 内容与复制目标。
 */
import { describe, expect, it } from "vitest";
import {
  STATUS_EXPLANATIONS,
  TEXT,
  UNKNOWN_TEXT,
  durationText,
  formatEventTime,
  statusFor,
  type PanelAgent,
  type PanelStatusKey,
} from "../../src/client-ui/status.ts";
import {
  defaultDetailGroups,
  technicalDetailGroups,
  type DetailField,
  type DetailGroup,
} from "../../src/client-ui/details.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const STARTED_AT = "2026-10-27T11:58:37.000Z"; // NOW − 83s

function fullAgent(patch: Partial<PanelAgent> = {}): PanelAgent {
  return {
    childId: "95d9ebac-74c1-4db2-9f31-4a1f2b830f21",
    backend: "claude-code",
    backendSessionId: null,
    state: "running",
    activation: "active",
    turn: { state: "running" },
    label: "评审 PR#14 的 diff",
    cwd: "/Users/dev/mocl/.worktrees/issue-18",
    depth: 1,
    epoch: 7,
    lastTurnId: "turn-20261027-001",
    startedAt: STARTED_AT,
    lastActivityAt: "2026-10-27T11:59:48.000Z",
    runtime: {
      transport: "agent-sdk",
      agentId: "claude-session-95d9ebac74c1",
      backendVersion: "v2.1.310",
      model: "claude-sonnet-4-5",
      modelSource: "reported",
    },
    usage: { inputTokens: 12580, outputTokens: 1640, costUsd: 0.084, durationMs: 83_000, precision: "exact", estimated: false },
    error: null,
    ...patch,
  };
}

function groupStrings(group: DetailGroup): string[] {
  const parts: string[] = [group.title, group.taskText ?? "", group.taskCopyValue ?? "", group.note ?? ""];
  for (const field of group.fields ?? []) parts.push(...fieldStrings(field));
  return parts.filter((part) => part !== "");
}

function fieldStrings(field: DetailField): string[] {
  return [field.key, field.value, field.copyValue ?? "", field.suffixText ?? "", field.suffixSource ?? ""];
}

describe("默认展开（人话区）硬约束：技术字段只允许出现在第二层", () => {
  const TECHNICAL_WORDS = /\b(cwd|depth|epoch|turnId)\b/;

  it("完整代理：所有组名/键/值/复制目标/后缀均不含技术字段字样", () => {
    const groups = defaultDetailGroups(fullAgent(), NOW);
    const flat = groups.flatMap(groupStrings);
    expect(flat.length).toBeGreaterThan(0);
    for (const part of flat) expect(TECHNICAL_WORDS.test(part)).toBe(false);
  });

  it("各种缺失/异常形态（无 runtime、无 label、未知状态、排队）同样不泄漏技术字段", () => {
    const variants: PanelAgent[] = [
      {},
      fullAgent({ label: null, runtime: null, startedAt: null, usage: null, childId: null }),
      fullAgent({ state: "nonsense" }),
      fullAgent({ state: "created", activation: "queued", turn: { state: "accepted" }, usage: null }),
      fullAgent({ error: { code: "BACKEND_DISABLED", userMessage: "该后端已禁用。", retryable: "no", traceId: null } }),
    ];
    for (const agent of variants) {
      for (const group of defaultDetailGroups(agent, NOW)) {
        for (const part of groupStrings(group)) expect(TECHNICAL_WORDS.test(part)).toBe(false);
      }
    }
  });

  it("组顺序固定：任务 → 状态与时间 → 用量 → 实际运行体 → 模型（→ 错误，仅在有错误时）", () => {
    const clean = defaultDetailGroups(fullAgent(), NOW).map((group) => group.title);
    expect(clean).toEqual([TEXT.taskGroup, TEXT.statusTimeGroup, TEXT.usageGroup, TEXT.runtimeGroup, TEXT.modelGroup]);
    const withError = defaultDetailGroups(fullAgent({ error: { code: "X", userMessage: "y", retryable: "no", traceId: "t" } }), NOW);
    expect(withError.map((group) => group.title)).toEqual([
      TEXT.taskGroup,
      TEXT.statusTimeGroup,
      TEXT.usageGroup,
      TEXT.runtimeGroup,
      TEXT.modelGroup,
      TEXT.errorDetailsLabel,
    ]);
  });

  it("状态与时间的键与顺序：状态说明 / 开始时间 / 最后活动 / 本轮耗时", () => {
    const group = defaultDetailGroups(fullAgent(), NOW).find((item) => item.title === TEXT.statusTimeGroup);
    expect(group?.fields?.map((field) => field.key)).toEqual([
      TEXT.statusExplanationLabel,
      TEXT.startedAtLabel,
      TEXT.lastActivityLabel,
      TEXT.durationLabel,
    ]);
  });

  it("实际运行体：后端 / 通道 / 原生会话 id（短写）/ 后端版本；缺失为未知，不从 backend 名猜版本", () => {
    const group = defaultDetailGroups(fullAgent(), NOW).find((item) => item.title === TEXT.runtimeGroup);
    expect(group?.fields?.map((field) => [field.key, field.value])).toEqual([
      [TEXT.backendLabel, "claude-code"],
      [TEXT.transportLabel, "agent-sdk"],
      [TEXT.nativeSessionIdLabel, "claude-s"], // 前 8 位
      [TEXT.backendVersionLabel, "v2.1.310"],
    ]);
    const bare = defaultDetailGroups(fullAgent({ runtime: null, backend: null }), NOW).find(
      (item) => item.title === TEXT.runtimeGroup,
    );
    expect(bare?.fields?.every((field) => field.value === UNKNOWN_TEXT)).toBe(true);
  });
});

describe("第二层「技术详情」：恰 5 个字段 + 排障说明 + 复制目标", () => {
  it("字段与顺序固定：childId、turnId（可复制）→ cwd、depth → epoch", () => {
    const groups = technicalDetailGroups(fullAgent());
    const keys = groups.flatMap((group) => group.fields.map((field) => field.key));
    expect(keys).toEqual(["childId", "turnId", "cwd", "depth", "epoch"]);
    const childId = groups[0]?.fields[0];
    const turnId = groups[0]?.fields[1];
    expect(childId?.copyValue).toBe("95d9ebac-74c1-4db2-9f31-4a1f2b830f21");
    expect(turnId?.copyValue).toBe("turn-20261027-001"); // turnId 对应 lastTurnId
    // cwd/depth/epoch 原值展示，无复制按钮
    expect(groups[1]?.fields.map((field) => [field.key, field.value, field.copyValue === undefined])).toEqual([
      ["cwd", "/Users/dev/mocl/.worktrees/issue-18", true],
      ["depth", "1", true],
    ]);
    expect(groups[2]?.fields[0]).toMatchObject({ key: "epoch", value: "7" });
  });

  it("每组一句排障用途说明（不解释内部架构）；缺失值落未知且无复制目标", () => {
    const groups = technicalDetailGroups(fullAgent({ childId: null, lastTurnId: null, cwd: null, depth: null, epoch: null }));
    for (const group of groups) {
      expect(group.help).toContain("MOCL 维护者");
      expect(group.help.length).toBeGreaterThan(0);
    }
    expect(groups[0]?.help).toBe(TEXT.technicalLocateHelp);
    expect(groups[1]?.help).toBe(TEXT.technicalContextHelp);
    expect(groups[2]?.help).toBe(TEXT.technicalRecoveryHelp);
    expect(groups[0]?.fields.every((field) => field.value === UNKNOWN_TEXT && field.copyValue === undefined)).toBe(true);
  });
});

describe("复制按钮目标（视图模型的 copyValue 即按钮目标）", () => {
  it("任务组：全文可复制（不截断），复制不依赖主行 title", () => {
    const longLabel = "跨仓库评审包含异常恢复、订阅重连与多语言长路径变更的超长任务差异".repeat(5);
    const group = defaultDetailGroups(fullAgent({ label: longLabel }), NOW).find((item) => item.kind === "task");
    expect(group?.taskText).toBe(longLabel);
    expect(group?.taskCopyValue).toBe(longLabel);
    const noLabel = defaultDetailGroups(fullAgent({ label: null }), NOW).find((item) => item.kind === "task");
    expect(noLabel?.taskText).toBe(UNKNOWN_TEXT);
    expect(noLabel?.taskCopyValue).toBeUndefined(); // 无值 → 不渲染复制按钮
  });

  it("原生会话 id：展示前 8 位，复制完整原值；runtime.agentId 优先，backendSessionId 兜底", () => {
    const field = defaultDetailGroups(fullAgent(), NOW)
      .find((item) => item.title === TEXT.runtimeGroup)
      ?.fields?.find((item) => item.key === TEXT.nativeSessionIdLabel);
    expect(field?.value).toBe("claude-s");
    expect(field?.copyValue).toBe("claude-session-95d9ebac74c1");

    const fallback = defaultDetailGroups(fullAgent({ runtime: null, backendSessionId: "c21a4f09-80a2-46b2-9c7d-ea3b5210ad41" }), NOW)
      .find((item) => item.title === TEXT.runtimeGroup)
      ?.fields?.find((item) => item.key === TEXT.nativeSessionIdLabel);
    expect(fallback?.value).toBe("c21a4f09");
    expect(fallback?.copyValue).toBe("c21a4f09-80a2-46b2-9c7d-ea3b5210ad41");
  });

  it("错误块：code/userMessage/retryable 用原值，traceId 可复制；无错误时整组不渲染", () => {
    const group = defaultDetailGroups(
      fullAgent({
        error: { code: "SUBSCRIPTION_DISCONNECTED", userMessage: "订阅连接中断，请重试。", retryable: "backoff", traceId: "trace-0a71c94e2b3f4d8a" },
      }),
      NOW,
    ).find((item) => item.kind === "error");
    expect(group?.fields?.map((field) => [field.key, field.value])).toEqual([
      ["code", "SUBSCRIPTION_DISCONNECTED"],
      ["userMessage", "订阅连接中断，请重试。"],
      ["retryable", "backoff"], // ABI 原值，不翻译成 UI 操作承诺
      ["traceId", "trace-0a71c94e2b3f4d8a"],
    ]);
    const traceId = group?.fields?.find((field) => field.key === "traceId");
    expect(traceId?.copyValue).toBe("trace-0a71c94e2b3f4d8a");
    expect(defaultDetailGroups(fullAgent({ error: null }), NOW).some((item) => item.kind === "error")).toBe(false);
  });
});

describe("用量（precision/estimated 规则沿用）", () => {
  const groupsOf = (agent: PanelAgent): readonly DetailGroup[] => defaultDetailGroups(agent, NOW);
  const usageGroupOf = (agent: PanelAgent): DetailGroup | undefined => groupsOf(agent).find((group) => group.title === TEXT.usageGroup);

  it("precision=none 或 usage 缺失 → 整个用量组不渲染（不用 0/未知拼假组）", () => {
    expect(usageGroupOf(fullAgent({ usage: { precision: "none" } }))).toBeUndefined();
    expect(usageGroupOf(fullAgent({ usage: null }))).toBeUndefined();
    expect(usageGroupOf(fullAgent({ usage: undefined }))).toBeUndefined();
  });

  it("exact：输入/输出 tokens、费用、耗时按原值；缺失单项为未知；费用 0 是有效值", () => {
    const fields = usageGroupOf(fullAgent())?.fields ?? [];
    expect(fields.map((field) => [field.key, field.value])).toEqual([
      [TEXT.inputTokensLabel, "12580"],
      [TEXT.outputTokensLabel, "1640"],
      [TEXT.costLabel, "$0.084"],
      [TEXT.usageDurationLabel, "01:23"],
    ]);
    const zeroCost = usageGroupOf(fullAgent({ usage: { precision: "exact", costUsd: 0 } }));
    expect(zeroCost?.fields?.find((field) => field.key === TEXT.costLabel)?.value).toBe("$0");
    // 无当前轮（无 startedAt/turn 锚点）→ 单项缺失全部落「未知」，不造两个数字
    const missing = usageGroupOf(
      fullAgent({ usage: { precision: "coarse" }, startedAt: null, lastTurnId: null, turn: { state: null } }),
    );
    expect(missing?.fields?.map((field) => field.value)).toEqual([UNKNOWN_TEXT, UNKNOWN_TEXT, UNKNOWN_TEXT, UNKNOWN_TEXT]);
    expect(missing?.note).toBeUndefined();
  });

  it("estimated=true：数值前加 ≈，组旁注明「估算值，不用于计费对账」；未标记不加", () => {
    const estimated = usageGroupOf(fullAgent({ usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.01, durationMs: 37_000, precision: "coarse", estimated: true } }));
    expect(estimated?.fields?.map((field) => field.value)).toEqual(["≈100", "≈5", "≈$0.01", "≈00:37"]);
    expect(estimated?.note).toBe(TEXT.estimatedNote);
    const plain = usageGroupOf(fullAgent());
    expect(plain?.note).toBeUndefined();
    expect(plain?.fields?.[0]?.value).toBe("12580");
  });

  it("用量耗时与状态区「本轮耗时」同值：不制造两个不同数字", () => {
    const agent = fullAgent();
    const usageDuration = usageGroupOf(agent)?.fields?.find((field) => field.key === TEXT.usageDurationLabel)?.value;
    expect(usageDuration).toBe(shownDuration(durationText(agent, NOW)));
    // 无实测值时同样一致（都走 durationText 的推算/未知兜底）
    const liveAgent = fullAgent({ usage: { precision: "coarse" } });
    expect(usageGroupOf(liveAgent)?.fields?.find((field) => field.key === TEXT.usageDurationLabel)?.value).toBe(
      shownDuration(durationText(liveAgent, NOW)),
    );
  });

  function shownDuration(value: string | null): string {
    return value ?? UNKNOWN_TEXT;
  }
});

describe("模型来源标识（F3 / §4）", () => {
  const modelFieldOf = (agent: PanelAgent): DetailField | undefined =>
    defaultDetailGroups(agent, NOW)
      .find((group) => group.title === TEXT.modelGroup)
      ?.fields?.find((field) => field.key === TEXT.modelKeyLabel);

  it("reported → 模型名 + 「实际」；详情显示完整模型名", () => {
    const field = modelFieldOf(fullAgent());
    expect(field).toMatchObject({ value: "claude-sonnet-4-5", suffixText: TEXT.modelReportedMark, suffixSource: "reported" });
  });

  it("configured → 「配置值」；fallback → 模型原值 + 「降级」，不编造档名", () => {
    expect(modelFieldOf(fullAgent({ runtime: { transport: "app-server", model: "gpt-5.3-codex", modelSource: "configured" } })))
      .toMatchObject({ value: "gpt-5.3-codex", suffixText: TEXT.modelConfiguredMark, suffixSource: "configured" });
    expect(modelFieldOf(fullAgent({ runtime: { transport: "acp", model: "deepseek-v4.1-flash-free", modelSource: "fallback" } })))
      .toMatchObject({ value: "deepseek-v4.1-flash-free", suffixText: TEXT.modelFallbackMark, suffixSource: "fallback" });
  });

  it("unknown / host 未上报（W4 并行）→ 「未知」且无后缀；未知只描述模型，不隐藏其他运行信息", () => {
    // 实现对「无后缀」是整键省略（不是 suffixText: undefined），故按属性访问断言，不要求键存在。
    const noModel = modelFieldOf(fullAgent({ runtime: { transport: "acp", model: null, modelSource: "unknown" } }));
    expect(noModel?.value).toBe(UNKNOWN_TEXT);
    expect(noModel?.suffixText ?? undefined).toBeUndefined();
    const unknownSource = modelFieldOf(fullAgent({ runtime: { transport: "acp", model: "x", modelSource: "unknown" } }));
    expect(unknownSource?.value).toBe(UNKNOWN_TEXT);
    expect(unknownSource?.suffixText ?? undefined).toBeUndefined();
    expect(unknownSource?.suffixSource).toBeUndefined();
    // 其他已知信息仍在：运行体组照常渲染
    expect(defaultDetailGroups(fullAgent({ runtime: { model: "x", modelSource: "unknown" } }), NOW).some((group) => group.title === TEXT.runtimeGroup)).toBe(true);
  });
});

describe("开始时间与状态说明", () => {
  it("formatEventTime：ISO → YYYY-MM-DD HH:mm:ss 本地时间（格式化+本地解析可往返回同一时刻）；非法/缺失 → null", () => {
    const text = formatEventTime(STARTED_AT);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const roundTrip = Date.parse((text as string).replace(" ", "T"));
    expect(Number.isFinite(roundTrip)).toBe(true);
    expect(Math.abs(roundTrip - Date.parse(STARTED_AT))).toBeLessThanOrEqual(1000);
    expect(formatEventTime("not-a-date")).toBeNull();
    expect(formatEventTime(null)).toBeNull();
    expect(formatEventTime(undefined)).toBeNull();
    expect(formatEventTime(12345)).toBeNull();
  });

  it("开始时间缺失 → 详情落「未知」； queued 的本轮耗时为「未开始」", () => {
    const group = defaultDetailGroups(fullAgent({ startedAt: null }), NOW).find((item) => item.title === TEXT.statusTimeGroup);
    expect(group?.fields?.find((field) => field.key === TEXT.startedAtLabel)?.value).toBe(UNKNOWN_TEXT);
    const queued = defaultDetailGroups(
      fullAgent({ state: "created", activation: "queued", turn: { state: "accepted" }, usage: null }),
      NOW,
    ).find((item) => item.title === TEXT.statusTimeGroup);
    expect(queued?.fields?.find((field) => field.key === TEXT.durationLabel)?.value).toBe(TEXT.notStarted);
  });

  it("状态说明覆盖 12 个主状态，与行状态同一映射结果", () => {
    const fixtures: Array<[PanelStatusKey, Partial<PanelAgent>]> = [
      ["running", { state: "running" }],
      ["queued", { state: "created", activation: "queued" }],
      ["waiting", { state: "awaiting-input" }],
      ["completed", { state: "completed" }],
      ["aborted", { state: "aborted" }],
      ["failed", { turn: { state: "failed" } }],
      ["recovering", { state: "recovering" }],
      ["lost", { state: "lost" }],
      ["archived", { state: "archived" }],
      ["blocked", { state: "blocked" }],
      ["created", { state: "created", turn: null }],
      ["unknown", { state: "nonsense", activation: null, turn: null }],
    ];
    for (const [key, patch] of fixtures) {
      const agent = fullAgent(patch);
      expect(statusFor(agent).key).toBe(key);
      const group = defaultDetailGroups(agent, NOW).find((item) => item.title === TEXT.statusTimeGroup);
      expect(group?.fields?.find((field) => field.key === TEXT.statusExplanationLabel)?.value).toBe(
        STATUS_EXPLANATIONS[key],
      );
    }
    // 抽查两条设计文案
    expect(STATUS_EXPLANATIONS.running).toBe("后端正在执行本轮任务。");
    expect(STATUS_EXPLANATIONS.lost).toBe("当前只能显示代理丢失前的最后已知状态。");
  });
});
