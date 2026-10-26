/**
 * S05 — 宿主重启 / 后端进程崩溃后的会话发现与续接。
 *
 * 人物：DSH 崩溃/重启后，回来找之前子代理结果的开发者。
 * 人类动作：mocl_status 列出会话 → 看到 lost → 尝试续接 → 判断能不能继续。
 * 判定：会话可被发现、远端 id 不丢；读不到就如实报 session.not-found，不伪造成功、不重复建会话。
 *
 * KI-02：当前 `facade.resume()` 只做远端探测，不回填门面运行时，因此 resume 之后
 * send 仍是 session.not-found。这里按现状记录缺口，修好后场景会自动提示删基线。
 */
import { join } from "node:path";
import { configFor, createStack, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";
import { ScenarioAdapter } from "../lib/fake-backends.mjs";

export default {
  id: "S05",
  scope: "usage",
  title: "宿主重启后的会话发现与续接",
  persona: "DSH 重启后回来找子代理结果的开发者",
  goal: "确认重启后能发现旧会话、续接不伪造成功、不产生重复会话/turn",
  async run(ctx) {
    const repo = await ctx.repo();
    const adapterA = new ScenarioAdapter("codex", { remoteId: "remote_codex_A" });
    const hostState = join(ctx.dir, "host");
    const stackA = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters: { codex: adapterA },
      stateDir: hostState,
    });
    const opened = await stackA.host.callTool("subagent_agent", { backend: "codex", task: "第一轮", cwd: repo });
    ctx.assert("before-crash:ok", opened.ok === true, JSON.stringify(opened));
    const completed = await waitForToolTerminal(stackA.host, opened.childId, { timeoutMs: 5_000 });
    ctx.assert("before-crash:completed", completed.state === "completed", String(completed.state));

    // 模拟宿主/后端进程死亡：不 close，直接掐断事件流。
    adapterA.kill();

    const adapterB = new ScenarioAdapter("codex", { remoteId: "remote_codex_A" });
    const stackB = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters: { codex: adapterB },
      stateDir: hostState,
    });

    const list = await stackB.host.callTool("mocl_status", {});
    ctx.assert("restart:list-ok", list.ok === true, JSON.stringify(list));
    const found = list.children.find((child) => child.childId === opened.childId);
    ctx.assert("restart:session-found", found !== undefined, JSON.stringify(list.children.map((child) => child.childId)));
    ctx.assert("restart:state-lost", found?.state === "lost", String(found?.state));
    ctx.assert("restart:inactive", found?.active === false, String(found?.active));
    ctx.assert("restart:remote-id-kept", found?.backendSessionId === "remote_codex_A", String(found?.backendSessionId));

    const beforeResume = await stackB.facade.status(opened.childId);
    ctx.assert("restart:epoch-kept", beforeResume.epoch === 1, String(beforeResume.epoch));
    ctx.assert("restart:no-error-fabricated", beforeResume.error === null, JSON.stringify(beforeResume.error));

    const resumed = await stackB.facade.resume(opened.childId);
    ctx.assert("resume:strategy", resumed.strategy === "resume", JSON.stringify(resumed));
    ctx.assert("resume:remote-bound", resumed.remoteIdState === "bound", String(resumed.remoteIdState));
    ctx.assert("resume:not-degraded", resumed.degraded === false, String(resumed.degraded));
    ctx.assert("resume:probe-called", adapterB.resumeCalls === 1, String(adapterB.resumeCalls));

    const afterResume = await stackB.facade.status(opened.childId);
    let sendBlocked = false;
    let sendCode = null;
    try {
      await stackB.facade.send(opened.childId, "重启后继续");
    } catch (error) {
      sendBlocked = true;
      sendCode = error.code ?? error.name;
    }
    ctx.knownIssue(
      "KI-02",
      afterResume.state === "lost" && sendBlocked,
      `state=${afterResume.state} send=${sendBlocked ? sendCode : "ok"}`,
    );
    ctx.assert("resume:no-duplicate-session", (await stackB.facade.list()).children.length === 1);
    if (sendBlocked) {
      ctx.assert("resume:no-duplicate-turn", adapterB.sendCalls === 0, String(adapterB.sendCalls));
      ctx.assert("resume:error-is-abi", sendCode === "session.not-found", String(sendCode));
    }

    // 远端会话已被清理：必须报 session.not-found，不能 reseed 假成功。
    const adapterC = new ScenarioAdapter("codex", { remoteId: "remote_codex_C" });
    const stackC = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters: { codex: adapterC },
      stateDir: join(ctx.dir, "host-deleted"),
    });
    const openedC = await stackC.host.callTool("subagent_agent", { backend: "codex", task: "会被清理的任务", cwd: repo });
    const completedC = await waitForToolTerminal(stackC.host, openedC.childId, { timeoutMs: 5_000 });
    ctx.assert("deleted:first-turn-ok", completedC.state === "completed", String(completedC.state));
    adapterC.deleteRemote();
    let missingCode = null;
    try {
      await stackC.facade.resume(openedC.childId);
    } catch (error) {
      missingCode = error.code ?? error.name;
    }
    ctx.assert("deleted:resume-rejected", missingCode === "session.not-found", String(missingCode));
    const remaining = await stackC.facade.list();
    ctx.assert(
      "deleted:no-reseed",
      remaining.children.length === 1,
      JSON.stringify(remaining.children.map((child) => ({ id: child.childId, state: child.state }))),
    );

    await ctx.artifact("restart.json", { found, beforeResume, resumed, afterResume, sendBlocked, sendCode, missingCode });
  },
};
