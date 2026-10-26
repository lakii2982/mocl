/**
 * S02 — 启用 codex，派发第一个只读任务。
 *
 * 人物：照着 README/接入文档把 codex 打开的开发者。
 * 人类动作：在真实 git 仓库里让子代理「只读检查」，自己轮询状态直到完成。
 * 判定：能在不阻塞的情况下拿到 childId；终态、用量、父级投递上限、零写入都达标。
 */
import { gitStatus } from "../lib/util.mjs";
import { ScenarioAdapter } from "../lib/fake-backends.mjs";
import { configFor, createStack, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";

export default {
  id: "S02",
  scope: "usage",
  title: "启用 codex 并完成第一个只读任务",
  persona: "按文档启用 codex 的开发者",
  goal: "确认派发立即返回、状态可轮询到终态、用量可见、工作区零写入",
  async run(ctx) {
    const repo = await ctx.repo();
    const repoBefore = await ctx.snapshot(repo);
    const gitBefore = await gitStatus(repo);
    ctx.assert("fixture:git-clean", gitBefore.code === 0 && gitBefore.status === "", `${gitBefore.status}`);

    const adapter = new ScenarioAdapter("codex");
    const stack = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"], backends: { codex: { model: null } } }),
      runtime: runtimeAt(4),
      adapters: { codex: adapter },
    });

    const opened = await stack.host.callTool("subagent_agent", {
      backend: "codex",
      task: "只读检查这个仓库并回答 1+1。不要修改、创建或删除任何文件。",
      cwd: repo,
    });
    ctx.assert("open:ok", opened.ok === true, JSON.stringify(opened));
    ctx.assert("open:child-id", typeof opened.childId === "string" && opened.childId.startsWith("sess_"), String(opened.childId));
    ctx.assert("open:immediate", opened.state === "running", String(opened.state));
    ctx.assert("open:remote-bound", opened.remoteIdState === "bound", String(opened.remoteIdState));
    ctx.assert("open:not-deduplicated", opened.deduplicated === false, String(opened.deduplicated));

    const status = await waitForToolTerminal(stack.host, opened.childId, { timeoutMs: 5_000 });
    ctx.assert("state:terminal", status.state !== "running" && status.state !== "created", String(status.state));
    ctx.assert("state:completed", status.state === "completed", String(status.state));
    ctx.assert("error:none", status.error === null, JSON.stringify(status.error));
    ctx.assert("degraded:false", status.degraded === false, String(status.degraded));
    ctx.assert("events:present", status.cursor.total >= 4, String(status.cursor.total));
    ctx.assert("events:last-terminal", status.lastEventType === "turn.completed", String(status.lastEventType));
    ctx.assert("parent:<=1", status.parentDeliveries <= 1, String(status.parentDeliveries));
    ctx.assert("usage:present", status.usage !== null, JSON.stringify(status.usage));
    ctx.assert("usage:turn-scope", status.usage?.scope === "turn", JSON.stringify(status.usage));
    ctx.assert(
      "progress:hard-limits",
      status.progress.maxItemsPerTurn === 8 && status.progress.maxCharsPerTurn === 1200 && status.progress.maxCharsPerItem === 400,
      JSON.stringify(status.progress),
    );

    const openRequest = adapter.openRequests[0];
    ctx.assert("adapter:permission-read-only", openRequest?.permissionProfile === "read-only", JSON.stringify(openRequest));
    ctx.assert("adapter:cwd", openRequest?.cwd === repo, String(openRequest?.cwd));
    ctx.assert("adapter:task-forwarded", adapter.sendRequests[0]?.input?.[0]?.text?.includes("1+1") === true);
    ctx.assert("adapter:one-turn", adapter.sendCalls === 1, String(adapter.sendCalls));

    const gitAfter = await gitStatus(repo);
    ctx.assert("repo:git-status-unchanged", gitAfter.status === gitBefore.status, `${gitBefore.status} -> ${gitAfter.status}`);
    await ctx.assertUnchanged("repo:no-writes", repo, repoBefore);

    await stack.facade.close(opened.childId);
    ctx.assert("close:adapter-closed", adapter.closeCalls === 1, String(adapter.closeCalls));
    await ctx.artifact("status.json", status);
  },
};
