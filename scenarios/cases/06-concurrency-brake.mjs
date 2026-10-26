/**
 * S06 — 并发上限跟随运行时：超限被拒、释放后可继续。
 *
 * 人物：一次想开多个子代理的开发者（DSH 设置页里 maxActiveSubagents 是有限的）。
 * 人类动作：连开 3 个 → 第 3 个被拒 → 关掉一个 → 再试成功 → 改设置后再试。
 * 判定：上限来自运行时（D-016），不是硬编码；错误是 limit.concurrency-exceeded；无半开会话。
 */
import { MutableRuntime, configFor, createStack } from "../lib/factories.mjs";
import { fakeAdapters } from "../lib/fake-backends.mjs";

export default {
  id: "S06",
  scope: "usage",
  title: "并发刹车与运行时跟随",
  persona: "一次想开多个子代理的开发者",
  goal: "确认超限被明确拒绝、关掉后可继续、上限随 DSH 运行时变化",
  async run(ctx) {
    const repo = await ctx.repo();
    const runtime = new MutableRuntime(2);
    const adapters = fakeAdapters();
    const stack = await createStack({
      ctx,
      config: configFor({ enabled: ["codex", "claude-code", "kimi"] }),
      runtime,
      adapters,
    });

    const first = await stack.host.callTool("subagent_agent", { backend: "codex", task: "任务 A", cwd: repo });
    const second = await stack.host.callTool("subagent_agent", { backend: "claude-code", task: "任务 B", cwd: repo });
    ctx.assert("open:first", first.ok === true, JSON.stringify(first));
    ctx.assert("open:second", second.ok === true, JSON.stringify(second));

    const third = await stack.host.callTool("subagent_agent", { backend: "kimi", task: "任务 C", cwd: repo });
    ctx.assert("limit:third-rejected", third.ok === false, JSON.stringify(third));
    ctx.assert(
      "limit:error-code",
      third.ok === false && third.error.code === "limit.concurrency-exceeded",
      JSON.stringify(third.error),
    );
    ctx.assert(
      "limit:retryable",
      third.ok === false && third.error.retryable === "backoff",
      JSON.stringify(third.error),
    );
    ctx.assert("limit:no-half-open", adapters.kimi.openCalls === 0, String(adapters.kimi.openCalls));
    ctx.assert("limit:list-count", (await stack.facade.list()).children.length === 2);

    await stack.facade.close(first.childId);
    const afterClose = await stack.host.callTool("subagent_agent", { backend: "kimi", task: "任务 C（重试）", cwd: repo });
    ctx.assert("slot:reopen-after-close", afterClose.ok === true, JSON.stringify(afterClose));

    // 用户在设置页把并发降到 1：已开的 2 个不受影响，新任务被拒。
    runtime.set(1);
    const lowered = await stack.host.callTool("subagent_agent", { backend: "codex", task: "任务 D", cwd: repo });
    ctx.assert("runtime:lowered-rejects", lowered.ok === false && lowered.error.code === "limit.concurrency-exceeded", JSON.stringify(lowered));

    await stack.facade.close(second.childId);
    await stack.facade.close(afterClose.childId);
    runtime.set(3);
    const a = await stack.host.callTool("subagent_agent", { backend: "codex", task: "任务 E", cwd: repo });
    const b = await stack.host.callTool("subagent_agent", { backend: "claude-code", task: "任务 F", cwd: repo });
    const c = await stack.host.callTool("subagent_agent", { backend: "kimi", task: "任务 G", cwd: repo });
    ctx.assert("runtime:raised-accepts", a.ok === true && b.ok === true && c.ok === true, JSON.stringify({ a: a.ok, b: b.ok, c: c.ok }));

    const status = await stack.facade.status(a.childId);
    ctx.assert("digest:runtime-derived", status.configDigest.includes('"maxConcurrent":"runtime"'), status.configDigest);
    ctx.assert("digest:no-secret", !status.configDigest.includes("MOCL_"), status.configDigest);

    for (const child of [a, b, c]) await stack.facade.close(child.childId);
    await ctx.artifact("concurrency.json", { third: third.error, lowered: lowered.error, configDigest: status.configDigest });
  },
};
