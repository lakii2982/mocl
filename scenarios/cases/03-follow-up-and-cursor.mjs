/**
 * S03 — 同一会话追问第二轮，并用 cursor 增量读取。
 *
 * 人物：已经拿到第一轮结论、想继续追问的开发者。
 * 人类动作：读 mocl_status 的 cursor → 再问一轮 → 只拉新事件，不重复读旧事件。
 * 判定：复用同一会话/远端 id，不新开会话；cursor 严格前进且幂等。
 *
 * 注意：当前工具面只暴露 subagent_agent / mocl_status，没有 send（KI-03）。
 * 这里先用门面 send 验证兼容层契约，同时把「工具面缺失」记入已知缺口。
 */
import { sleep } from "../lib/util.mjs";
import { configFor, createStack, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";
import { ScenarioAdapter } from "../lib/fake-backends.mjs";

/** 等「本轮的终态事件」落进总线：不能只看 state，因为 #terminal 会保留上一轮结果。 */
async function waitForTurnEnd(facade, childId, fromSeq, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await facade.status(childId, fromSeq);
  while (Date.now() < deadline) {
    if (last.cursor.lastSeq > fromSeq && last.lastEventType === "turn.completed") return last;
    await sleep(30);
    last = await facade.status(childId, fromSeq);
  }
  return last;
}

export default {
  id: "S03",
  scope: "usage",
  title: "追问第二轮 + cursor 增量读取",
  persona: "拿到第一轮结论后继续追问的开发者",
  goal: "确认续接复用同一会话、事件增量不重不漏、cursor 读取幂等",
  async run(ctx) {
    const repo = await ctx.repo();
    const adapter = new ScenarioAdapter("codex");
    const stack = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters: { codex: adapter },
    });

    const opened = await stack.host.callTool("subagent_agent", {
      backend: "codex",
      task: "第一轮：只回复 OK",
      cwd: repo,
    });
    ctx.assert("turn1:ok", opened.ok === true, JSON.stringify(opened));
    const first = await waitForToolTerminal(stack.host, opened.childId, { timeoutMs: 5_000 });
    ctx.assert("turn1:completed", first.state === "completed", String(first.state));
    const firstSeq = first.cursor.lastSeq;
    ctx.assert("cursor:first-lastSeq", typeof firstSeq === "number" && firstSeq >= 4, String(firstSeq));

    // KI-03：人类无法从工具面发起第二轮（缺 send/resume/interrupt/close）。
    const missingTools = ["mocl_send", "mocl_resume", "mocl_interrupt", "mocl_close"].filter(
      (name) => !stack.host.tools.has(name),
    );
    ctx.knownIssue("KI-03", missingTools.length > 0, `missing=${missingTools.join(",")}`);

    const second = await stack.facade.send(opened.childId, "第二轮：复述第一轮你回答了什么");
    ctx.assert("turn2:sent", typeof second.turnId === "string" && second.turnId.startsWith("turn_"), JSON.stringify(second));
    ctx.assert("turn2:new-turn-id", second.turnId !== opened.turnId, `${second.turnId} vs ${opened.turnId}`);
    ctx.assert("turn2:no-new-session", adapter.openCalls === 1, String(adapter.openCalls));
    ctx.assert("turn2:same-remote-id", adapter.sendRequests[1]?.remoteSessionId === adapter.sendRequests[0]?.remoteSessionId);

    // KI-06：send 的返回值仍带着上一轮的终态（#terminal 未在 send 时清空）。
    ctx.knownIssue("KI-06", second.state !== "running", `send.state=${second.state}`);

    const secondStatus = await waitForTurnEnd(stack.facade, opened.childId, firstSeq);
    ctx.assert("turn2:completed", secondStatus.state === "completed", String(secondStatus.state));
    ctx.assert("turn2:parent-deliveries", secondStatus.parentDeliveries === 2, String(secondStatus.parentDeliveries));

    const incremental = await stack.facade.status(opened.childId, firstSeq);
    ctx.assert("cursor:fromSeq-echo", incremental.cursor.fromSeq === firstSeq, JSON.stringify(incremental.cursor));
    ctx.assert("cursor:only-new-events", incremental.cursor.events > 0, JSON.stringify(incremental.cursor));
    ctx.assert("cursor:advances", incremental.cursor.lastSeq > firstSeq, JSON.stringify(incremental.cursor));
    ctx.assert(
      "cursor:no-overlap",
      incremental.cursor.total === firstSeq + incremental.cursor.events,
      `total=${incremental.cursor.total} first=${firstSeq} new=${incremental.cursor.events}`,
    );

    const reread = await stack.facade.status(opened.childId, incremental.cursor.lastSeq);
    ctx.assert("cursor:idempotent", reread.cursor.events === 0, JSON.stringify(reread.cursor));
    ctx.assert("cursor:total-stable", reread.cursor.total === incremental.cursor.total, `${reread.cursor.total}`);

    await stack.facade.close(opened.childId);
    await ctx.artifact("cursor.json", { firstSeq, incremental: incremental.cursor, reread: reread.cursor });
  },
};
