/**
 * S04 — 长任务中断与关闭。
 *
 * 人物：发现子代理卡住、想立刻止损的开发者。
 * 人类动作：叫停 → 确认已中止 → 关掉会话 → 再开一个新任务，槽位应已释放。
 * 判定：interrupt 真的到达适配器；终态 aborted；close 幂等；并发槽位释放。
 *
 * 当前工具面没有 interrupt/close（KI-03），因此用门面验证兼容层契约。
 */
import { sleep } from "../lib/util.mjs";
import { configFor, createStack, runtimeAt } from "../lib/factories.mjs";
import { ScenarioAdapter } from "../lib/fake-backends.mjs";

export default {
  id: "S04",
  scope: "usage",
  title: "长任务中断、关闭与槽位释放",
  persona: "发现子代理卡住、想立刻止损的开发者",
  goal: "确认中断在有限时间内生效、关闭幂等、并发槽位不泄漏",
  async run(ctx) {
    const repo = await ctx.repo();
    const adapter = new ScenarioAdapter("codex", { hangOnSend: true });
    const stack = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(1), // 只留 1 个槽位，最容易暴露泄漏
      adapters: { codex: adapter },
    });

    const opened = await stack.host.callTool("subagent_agent", {
      backend: "codex",
      task: "跑一个会卡住的长任务",
      cwd: repo,
    });
    ctx.assert("open:ok", opened.ok === true, JSON.stringify(opened));
    ctx.assert("open:running", opened.state === "running", String(opened.state));

    await sleep(120);
    const running = (await stack.host.callTool("mocl_status", { childId: opened.childId })).status;
    ctx.assert("hang:still-running", running.state === "running", String(running.state));
    ctx.assert("hang:started-event", running.cursor.total >= 1, String(running.cursor.total));

    const missingTools = ["mocl_interrupt", "mocl_close"].filter((name) => !stack.host.tools.has(name));
    ctx.knownIssue("KI-03", missingTools.length > 0, `missing=${missingTools.join(",")}`);

    const interrupted = await stack.facade.interrupt(opened.childId);
    ctx.assert("interrupt:ack", interrupted.interrupted === true, JSON.stringify(interrupted));
    ctx.assert("interrupt:adapter-called", adapter.interruptCalls === 1, String(adapter.interruptCalls));

    await sleep(80);
    const aborted = await stack.facade.status(opened.childId, running.cursor.lastSeq ?? 0);
    ctx.assert("interrupt:state-aborted", aborted.state === "aborted", String(aborted.state));
    ctx.assert("interrupt:terminal-event", aborted.lastEventType === "turn.aborted", String(aborted.lastEventType));

    const closed = await stack.facade.close(opened.childId);
    ctx.assert("close:ack", closed.closed === true, JSON.stringify(closed));
    ctx.assert("close:adapter-called", adapter.closeCalls === 1, String(adapter.closeCalls));
    let secondCloseFailed = false;
    try {
      await stack.facade.close(opened.childId);
    } catch {
      secondCloseFailed = true;
    }
    ctx.assert("close:idempotent", secondCloseFailed === false, "第二次 close 不应抛错");

    const seqAfterClose = (await stack.facade.status(opened.childId)).cursor.total;
    await sleep(120);
    const seqLater = (await stack.facade.status(opened.childId)).cursor.total;
    ctx.assert("close:stream-stopped", seqLater === seqAfterClose, `${seqAfterClose} -> ${seqLater}`);

    // 槽位已释放：runtime=1 时还能再开一个新会话。
    const next = await stack.host.callTool("subagent_agent", { backend: "codex", task: "新任务", cwd: repo });
    ctx.assert("slot:released", next.ok === true && next.childId !== opened.childId, JSON.stringify(next));
    await stack.facade.close(next.childId);
    await ctx.artifact("interrupt.json", { running, aborted, seqAfterClose, seqLater });
  },
};
