/**
 * S08 — 四后端巡检：每个后端都能派发，并如实报告自己的状态。
 *
 * 人物：准备把四个后端都接进来的团队负责人。
 * 人类动作：对每个 backend 各派一个「只回复 OK」，看状态/能力/降级/远端 id。
 * 判定：四后端都完成；kimi pending id 不假装 bound；opencode 降级显式可见；能力位齐全。
 *
 * KI-04：mocl_status 目前不暴露 capabilities（F6 要求「统一入口列出后端与能力位」）。
 */
import { CAPABILITY_BITS } from "../../src/abi/index.ts";
import { configFor, createStack, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";
import { fakeAdapters } from "../lib/fake-backends.mjs";

const EXPECTED_TRANSPORT = {
  codex: "app-server-jsonrpc",
  "claude-code": "agent-sdk",
  kimi: "acp-stdio",
  opencode: "http-api",
};

export default {
  id: "S08",
  scope: "usage",
  title: "四后端巡检（能力/降级/pending id）",
  persona: "准备把四个后端都接进来的团队负责人",
  goal: "确认四后端都能派发；缺失能力与降级状态如实上报，不撒谎",
  async run(ctx) {
    const repo = await ctx.repo();
    const adapters = fakeAdapters({
      kimi: { remoteId: "", remoteIdAfterTurn: "remote_kimi_after_turn", pendingResumeFailures: 1 },
      opencode: { degrade: { code: "model.free-fallback", message: "paid model rejected; model=free-fallback" } },
    });
    const config = configFor({
      enabled: ["codex", "claude-code", "kimi", "opencode"],
      backends: {
        kimi: { channel: "cli" },
        opencode: { channel: "http" },
      },
    });
    const stack = await createStack({ ctx, config, runtime: runtimeAt(8), adapters });

    const statuses = {};
    for (const backend of ["codex", "claude-code", "kimi", "opencode"]) {
      const opened = await stack.host.callTool("subagent_agent", { backend, task: `只回复 OK（${backend}）`, cwd: repo });
      ctx.assert(`tour:${backend}:open`, opened.ok === true, JSON.stringify(opened));
      if (opened.ok !== true) continue;
      if (backend === "kimi") {
        ctx.assert(`tour:${backend}:pending-id`, opened.remoteIdState === "pending", String(opened.remoteIdState));
        ctx.assert(`tour:${backend}:no-fake-remote-id`, opened.backendSessionId === null, String(opened.backendSessionId));
      } else {
        ctx.assert(`tour:${backend}:bound-id`, opened.remoteIdState === "bound", String(opened.remoteIdState));
      }
      const status = await waitForToolTerminal(stack.host, opened.childId, { timeoutMs: 5_000 });
      statuses[backend] = status;
      ctx.assert(`tour:${backend}:completed`, status.state === "completed", String(status.state));
      ctx.assert(`tour:${backend}:error-none`, status.error === null, JSON.stringify(status.error));
    }

    // kimi：探测失败保持 pending；之后 resume 探测成功才回填 bound。
    const kimiStatus = statuses.kimi;
    ctx.assert("kimi:pending-honest", kimiStatus?.remoteIdState === "pending", String(kimiStatus?.remoteIdState));
    const kimiChild = stack.host.calls
      .filter((call) => call.name === "subagent_agent" && call.args.backend === "kimi")
      .at(-1)?.result?.childId;
    const resumed = await stack.facade.resume(kimiChild);
    ctx.assert("kimi:resume-backfills", resumed.remoteIdState === "bound", JSON.stringify(resumed));
    const kimiAfter = await stack.facade.status(kimiChild);
    ctx.assert("kimi:id-bound-after-probe", kimiAfter.backendSessionId === "remote_kimi_after_turn", String(kimiAfter.backendSessionId));

    // opencode：降级必须是显式的（degraded + warning + 完成态）。
    const opencodeStatus = statuses.opencode;
    ctx.assert("opencode:degraded-flag", opencodeStatus?.degraded === true, String(opencodeStatus?.degraded));
    ctx.assert(
      "opencode:degrade-warning",
      Array.isArray(opencodeStatus?.warnings) && opencodeStatus.warnings.includes("model.free-fallback"),
      JSON.stringify(opencodeStatus?.warnings),
    );
    ctx.assert("opencode:still-completes", opencodeStatus?.state === "completed", String(opencodeStatus?.state));
    ctx.assert(
      "opencode:fallback-configured",
      config.backends.opencode.fallbackModel === "opencode/deepseek-v4.1-flash-free",
      String(config.backends.opencode.fallbackModel),
    );

    // 能力位：适配器声明齐全；工具面是否暴露（KI-04）。
    for (const backend of ["codex", "claude-code", "kimi", "opencode"]) {
      const capabilities = adapters[backend].capabilities;
      ctx.assert(`capability:${backend}:bits`, capabilities.bits.length === CAPABILITY_BITS.length, String(capabilities.bits.length));
      ctx.assert(`capability:${backend}:transport`, capabilities.transport === EXPECTED_TRANSPORT[backend], String(capabilities.transport));
      ctx.assert(
        `capability:${backend}:states`,
        capabilities.bits.every((entry) => ["native", "emulated", "unavailable"].includes(entry.state)),
      );
    }
    const list = await stack.host.callTool("mocl_status", {});
    const lacksCapabilities = list.ok === true && list.children.every((child) => !("capabilities" in child));
    ctx.knownIssue("KI-04", lacksCapabilities, `listKeys=${JSON.stringify(Object.keys(list.children[0] ?? {}))}`);

    await ctx.artifact("tour.json", { statuses, capabilities: Object.fromEntries(
      Object.entries(adapters).map(([backend, adapter]) => [backend, {
        transport: adapter.capabilities.transport,
        version: adapter.capabilities.backendVersion,
        bits: adapter.capabilities.bits.length,
      }]),
    ) });
  },
};
