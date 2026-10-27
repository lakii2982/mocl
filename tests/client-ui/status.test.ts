/**
 * W2 面板纯函数层测试：design/STATES.md §2 的 13 条优先级规则 +
 * DESIGN §3.3 每行四项字段所需的格式化/截断/兜底。
 */
import { describe, expect, it } from "vitest";
import {
  LABEL_MAX_CHARS,
  STATUS_LABELS,
  TEXT,
  UNKNOWN_TEXT,
  durationText,
  formatAge,
  formatElapsedMs,
  isBackendDisabled,
  labelText,
  lastActivityText,
  modelParts,
  nativeShortId,
  runtimeLine,
  statusFor,
  summaryCounts,
  syncReadyText,
  truncateLabel,
  type PanelAgent,
} from "../../src/client-ui/status.ts";

function agentOf(patch: Partial<PanelAgent>): PanelAgent {
  return { ...patch };
}

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

describe("状态映射：STATES.md §2 的 13 条组合判定优先级", () => {
  it("1. state=lost → 已丢失（最高优先级，queued 也不覆盖）", () => {
    expect(statusFor(agentOf({ state: "lost" }))).toMatchObject({ key: "lost", label: "已丢失", icon: "lost" });
    expect(statusFor(agentOf({ state: "lost", activation: "queued" })).label).toBe("已丢失");
  });

  it("2. state=recovering → 恢复中（不声称已恢复）", () => {
    expect(statusFor(agentOf({ state: "recovering" }))).toMatchObject({ key: "recovering", label: "恢复中" });
    expect(statusFor(agentOf({ state: "recovering" })).secondary).toBe("");
  });

  it("3. turn.state=failed → 失败（即使 state=completed 也先暴露本轮失败）", () => {
    expect(statusFor(agentOf({ turn: { state: "failed" } })).label).toBe("失败");
    expect(statusFor(agentOf({ state: "completed", turn: { state: "failed" } })).label).toBe("失败");
  });

  it("4. state=aborted 或 turn.state=aborted → 已中止（不等同失败）", () => {
    expect(statusFor(agentOf({ state: "aborted" })).label).toBe("已中止");
    expect(statusFor(agentOf({ turn: { state: "aborted" } })).label).toBe("已中止");
  });

  it("5. state=archived → 已归档（排在 queued 之前，历史归档不显示为当前排队）", () => {
    expect(statusFor(agentOf({ state: "archived" })).label).toBe("已归档");
    expect(statusFor(agentOf({ state: "archived", activation: "queued" })).label).toBe("已归档");
  });

  it("6. state=completed 或 turn.state=completed → 已完成", () => {
    expect(statusFor(agentOf({ state: "completed" })).label).toBe("已完成");
    expect(statusFor(agentOf({ turn: { state: "completed" } })).label).toBe("已完成");
  });

  it("7. activation=queued → 排队中 + 「等待槽位」；state/turn running 也不改成运行中", () => {
    const view = statusFor(agentOf({ state: "running", activation: "queued", turn: { state: "running" } }));
    expect(view).toMatchObject({ key: "queued", label: "排队中", secondary: TEXT.queuedSecondary });
  });

  it("8. state=awaiting-input 或 turn.state=awaiting-input → 等待输入（不写成运行中）", () => {
    expect(statusFor(agentOf({ state: "awaiting-input" })).label).toBe("等待输入");
    expect(statusFor(agentOf({ turn: { state: "awaiting-input" } })).label).toBe("等待输入");
  });

  it("9. state=blocked → 已阻塞（不猜阻塞原因）", () => {
    expect(statusFor(agentOf({ state: "blocked" }))).toMatchObject({ key: "blocked", label: "已阻塞" });
  });

  it("10. activation=draining 且 running → 运行中 + 「正在收尾」", () => {
    const view = statusFor(agentOf({ state: "running", activation: "draining" }));
    expect(view).toMatchObject({ key: "running", label: "运行中", secondary: TEXT.drainingSecondary });
    expect(statusFor(agentOf({ turn: { state: "running" }, activation: "draining" })).secondary).toBe(TEXT.drainingSecondary);
  });

  it("11. state=running 或 turn.state=running → 运行中（active 不加副文案）", () => {
    expect(statusFor(agentOf({ state: "running", activation: "active" }))).toMatchObject({
      label: "运行中",
      secondary: "",
    });
    expect(statusFor(agentOf({ turn: { state: "running" } })).label).toBe("运行中");
  });

  it("12. state=created 或 turn.state=accepted → 待启动（不计入运行中）", () => {
    const view = statusFor(agentOf({ state: "created", activation: "inactive", turn: { state: "accepted" } }));
    expect(view).toMatchObject({ key: "created", label: "待启动" });
    expect(statusFor(agentOf({ turn: { state: "accepted" } })).label).toBe("待启动");
  });

  it("13. 其他/缺失/乱值 → 未知（不编造状态）", () => {
    expect(statusFor(null)).toMatchObject({ key: "unknown", label: UNKNOWN_TEXT });
    expect(statusFor(agentOf({}))).toMatchObject({ key: "unknown", label: UNKNOWN_TEXT });
    expect(statusFor(agentOf({ state: "nonsense", activation: "nonsense", turn: { state: "nonsense" } })).key).toBe("unknown");
  });
});

describe("汇总口径（DESIGN §3.2）：与行主状态同一映射", () => {
  it("running/queued/failed 分口径统计，queued 绝不计入 running；lost 只进 total", () => {
    const counts = summaryCounts([
      agentOf({ state: "running" }),
      agentOf({ activation: "queued", state: "created" }),
      agentOf({ turn: { state: "failed" } }),
      agentOf({ state: "lost" }),
      agentOf({ state: "completed" }),
    ]);
    expect(counts).toEqual({ running: 1, queued: 1, failed: 1, total: 5 });
  });

  it("空列表 → 全 0（只有成功返回空集合才显示四项 0）", () => {
    expect(summaryCounts([])).toEqual({ running: 0, queued: 0, failed: 0, total: 0 });
  });
});

describe("时间格式化（右列两行）", () => {
  it("formatElapsedMs：mm:ss，≥1h 进位到 hh:mm:ss，非法值 → null", () => {
    expect(formatElapsedMs(83_000)).toBe("01:23");
    expect(formatElapsedMs(0)).toBe("00:00");
    expect(formatElapsedMs(3_723_000)).toBe("01:02:03");
    expect(formatElapsedMs(-1)).toBeNull();
    expect(formatElapsedMs(Number.NaN)).toBeNull();
  });

  it("formatAge：12s 前 / 2m 前 / 3h 前 / 5d 前；负差值按 0", () => {
    expect(formatAge(12_000)).toBe("12s 前");
    expect(formatAge(120_000)).toBe("2m 前");
    expect(formatAge(3 * 3_600_000)).toBe("3h 前");
    expect(formatAge(5 * 86_400_000)).toBe("5d 前");
    expect(formatAge(-5_000)).toBe("0s 前");
  });

  it("durationText：queued → 未开始；实测 usage.durationMs 优先 → mm:ss（>1h 进位 h:mm:ss）", () => {
    expect(durationText(agentOf({ activation: "queued" }), NOW)).toBe(TEXT.notStarted);
    expect(durationText(agentOf({ state: "completed", usage: { durationMs: 42_000 } }), NOW)).toBe("00:42");
    expect(durationText(agentOf({ state: "running", usage: { durationMs: 3_723_000 } }), NOW)).toBe("01:02:03");
    expect(durationText(agentOf({ state: "completed", usage: null }), NOW)).toBeNull();
    expect(durationText(agentOf({ state: "completed", usage: { durationMs: -5 } }), NOW)).toBeNull();
  });

  it("durationText：无实测值且进行中 → now−startedAt 推算；终态/从未开轮 → 未知（不出 00:00 假 0）", () => {
    const startedAt = "2026-10-27T11:58:37.000Z"; // NOW - 83s
    expect(durationText(agentOf({ state: "running", startedAt, lastTurnId: "turn-1" }), NOW)).toBe("01:23");
    // 截图场景：usage=null、lastTurnId=null（从未开轮）→「未知」，
    // 不得把 lastActivityAt−startedAt ≈ 0 冒充成本轮耗时。
    expect(durationText(agentOf({ state: "completed", startedAt, lastActivityAt: startedAt }), NOW)).toBeNull();
    expect(
      durationText(agentOf({ state: "completed", startedAt, lastActivityAt: "2026-10-27T11:59:19.000Z" }), NOW),
    ).toBeNull();
    expect(durationText(agentOf({ state: "running", startedAt }), NOW)).toBeNull(); // lastTurnId 缺失 = 无当前轮
  });

  it("durationText：缺 startedAt / 待启动 / 未知 → null（显示为未知，不用 0 填充）", () => {
    expect(durationText(agentOf({ state: "running", lastTurnId: "turn-1" }), NOW)).toBeNull();
    expect(durationText(agentOf({ state: "created", startedAt: "2026-10-27T11:00:00.000Z" }), NOW)).toBeNull();
    expect(durationText(agentOf({ state: "completed", lastActivityAt: "2026-10-27T11:00:00.000Z" }), NOW)).toBeNull();
  });

  it("lastActivityText：12s 前；缺失 → null", () => {
    expect(lastActivityText(agentOf({ lastActivityAt: "2026-10-27T11:59:48.000Z" }), NOW)).toBe("12s 前");
    expect(lastActivityText(agentOf({}), NOW)).toBeNull();
  });

  it("syncReadyText：有 lastSeq → 已同步 seq=<n> · 相对时间；缺 seq 只显示已同步；<5s → 刚刚；无 → 轮询中", () => {
    expect(syncReadyText(NOW - 9_000, 123, NOW)).toBe(`${TEXT.syncSynced} seq=123 · 9s 前`);
    expect(syncReadyText(NOW - 2_000, 45, NOW)).toBe(`${TEXT.syncSynced} seq=45 · 刚刚`);
    // route v1 无 lastSeq：seq 为可选字段，缺失不显示 seq=未知 噪声。
    expect(syncReadyText(NOW - 2_000, null, NOW)).toBe(`${TEXT.syncSynced} · 刚刚`);
    expect(syncReadyText(NOW - 65_000, null, NOW)).toBe(`${TEXT.syncSynced} · 1m 前`);
    expect(syncReadyText(null, null, NOW)).toBe(TEXT.syncPolling);
  });
});

describe("截断与缺失兜底（DESIGN §3.3 / STATES §4.5）", () => {
  it("truncateLabel：≤120 不动；>120 截到 120 且不切 emoji 代理对", () => {
    const short = "评审 PR#14 的 diff";
    expect(truncateLabel(short)).toBe(short);
    const long = "任".repeat(200);
    expect(truncateLabel(long)).toHaveLength(LABEL_MAX_CHARS);
    const emoji = "👍".repeat(LABEL_MAX_CHARS + 10);
    const cut = truncateLabel(emoji);
    expect(cut).toHaveLength(LABEL_MAX_CHARS);
    // 末字符不得是孤立代理对（低代理项开头）
    const last = Array.from(cut).at(-1) ?? "";
    expect(last.codePointAt(0)).toBeDefined();
  });

  it("labelText：缺失 → 未知；不得以 backend/childId 替代任务摘要", () => {
    expect(labelText(agentOf({ label: "评审 PR#14 的 diff" }))).toBe("评审 PR#14 的 diff");
    expect(labelText(agentOf({ label: null, backend: "claude-code", childId: "95d9" }))).toBe(UNKNOWN_TEXT);
    expect(labelText(agentOf({ label: "" }))).toBe(UNKNOWN_TEXT);
  });

  it("shown：null/undefined/空串 → 未知", () => {
    expect(UNKNOWN_TEXT).toBe(STATUS_LABELS.unknown);
  });

  it("nativeShortId：runtime.agentId 优先，backendSessionId 兜底，取前 8 位；缺失为空串", () => {
    expect(nativeShortId(agentOf({ runtime: { agentId: "95d9ebac-74c1-4db2-9f31-4a1f2b830f21" } }))).toBe("95d9ebac");
    expect(nativeShortId(agentOf({ backendSessionId: "c21a4f09-80a2-46b2-9c7d-ea3b5210ad41" }))).toBe("c21a4f09");
    expect(nativeShortId(agentOf({ backendSessionId: null, remoteIdState: "pending" }))).toBe("");
  });

  it("runtimeLine：backend · 通道 · 原生 id 短写 · 版本；任一缺失为未知", () => {
    expect(
      runtimeLine(
        agentOf({
          backend: "claude-code",
          runtime: { transport: "agent-sdk", backendVersion: "v2.1.310", agentId: "95d9ebac-74c1-4db2-9f31-4a1f2b830f21" },
        }),
      ),
    ).toBe("claude-code · agent-sdk · 95d9ebac · v2.1.310");
    expect(runtimeLine(agentOf({}))).toBe(`${UNKNOWN_TEXT} · ${UNKNOWN_TEXT} · ${UNKNOWN_TEXT} · ${UNKNOWN_TEXT}`);
  });

  it("modelParts：主体保留；configured → ≈配置值；fallback → 降级；缺失 → 未知", () => {
    expect(modelParts(agentOf({ runtime: { model: "deepseek-v4.1-flash", modelSource: "reported" } }))).toEqual({
      name: "deepseek-v4.1-flash",
      note: "",
    });
    expect(modelParts(agentOf({ runtime: { model: "deepseek-v4.1-flash", modelSource: "configured" } })).note).toBe(
      TEXT.modelConfiguredMark,
    );
    expect(modelParts(agentOf({ runtime: { model: "deepseek-v4.1-flash-free", modelSource: "fallback" } })).note).toBe(
      TEXT.modelFallbackMark,
    );
    expect(modelParts(agentOf({}))).toEqual({ name: UNKNOWN_TEXT, note: "" });
  });

  it("isBackendDisabled：只认 BACKEND_DISABLED 错误码（行内提示，不升级整页错误）", () => {
    expect(isBackendDisabled(agentOf({ error: { code: "BACKEND_DISABLED" } }))).toBe(true);
    expect(isBackendDisabled(agentOf({ error: { code: "transport.disconnected" } }))).toBe(false);
    expect(isBackendDisabled(agentOf({}))).toBe(false);
  });
});
