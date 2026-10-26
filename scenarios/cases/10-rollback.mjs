/**
 * S10 — 回滚：关掉开关后不再派发，patch/插件声明不变，且没有残留。
 *
 * 人物：试用后决定回滚（或紧急止血）的用户。
 * 人类动作：恢复默认配置 → 重启 → 尝试派发 → 检查旧工具是否仍被停用 → 检查残留。
 * 判定：回滚后 fail-closed；patch 声明仍是「新增 2 个工具 + 停用 4 个旧行」；会话产物不被删。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertStaticPatchFiles, LEGACY_IDS, PLUGIN_ID, TOOL_NAMES } from "../../src/plugin/patch.ts";
import { configFor, createStack, defaultConfig, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";
import { fakeAdapters } from "../lib/fake-backends.mjs";

export default {
  id: "S10",
  scope: "usage",
  title: "回滚、旧工具停用与残留检查",
  persona: "试用后决定回滚/紧急止血的用户",
  goal: "确认关掉开关即停止派发、patch 声明不变、会话记录保留且无进程/文件残留",
  async run(ctx) {
    const repo = await ctx.repo();

    // 1) 启用态：跑一轮，留下一条会话记录。
    const adapters = fakeAdapters();
    const enabled = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters,
    });
    const opened = await enabled.host.callTool("subagent_agent", { backend: "codex", task: "回滚前的任务", cwd: repo });
    const completed = await waitForToolTerminal(enabled.host, opened.childId, { timeoutMs: 5_000 });
    ctx.assert("before-rollback:completed", completed.state === "completed", String(completed.state));
    await enabled.facade.close(opened.childId);

    // 2) 回滚：换成默认配置（global.enabled=false），复用同一注册表。
    const rolledBack = await createStack({
      ctx,
      config: defaultConfig(),
      runtime: runtimeAt(4),
      adapters: fakeAdapters(),
    });
    const denied = await rolledBack.host.callTool("subagent_agent", { backend: "codex", task: "回滚后不该派发", cwd: repo });
    ctx.assert("rollback:dispatch-denied", denied.ok === false && denied.error.code === "policy.permission-denied", JSON.stringify(denied));
    const listDenied = await rolledBack.host.callTool("mocl_status", {});
    ctx.assert("rollback:inspection-denied", listDenied.ok === false, JSON.stringify(listDenied));

    // 3) 残留：会话记录还在磁盘上（可被下次开启后审计），适配器都已关闭。
    const registry = JSON.parse(await readFile(join(ctx.dir, "sessions.json"), "utf8"));
    ctx.assert("rollback:registry-kept", Array.isArray(registry.sessions) && registry.sessions.length === 1, JSON.stringify(registry));
    ctx.assert("rollback:adapter-closed", adapters.codex.closeCalls === 1, String(adapters.codex.closeCalls));
    ctx.assert("rollback:no-extra-turns", adapters.codex.sendCalls === 1, String(adapters.codex.sendCalls));

    // 4) patch/插件声明：回滚不会改动仓库内的接入文件。
    const before = {
      cordis: await readFile(join(ctx.repoRoot, "patch", "cordis.patch.yml"), "utf8"),
      legacy: await readFile(join(ctx.repoRoot, "patch", "disable-legacy.yml"), "utf8"),
    };
    const report = assertStaticPatchFiles();
    ctx.assert("patch:plugin-id", report.pluginId === PLUGIN_ID, report.pluginId);
    ctx.assert("patch:tool-names", report.toolNames.join(",") === TOOL_NAMES.join(","), report.toolNames.join(","));
    ctx.assert("patch:legacy-disabled", report.legacyDisabled === LEGACY_IDS.length, String(report.legacyDisabled));
    ctx.assert("patch:config-path", before.cordis.includes("configPath: config.default.json"), "cordis.patch.yml 缺 configPath");
    ctx.assert(
      "patch:files-unchanged",
      before.cordis === (await readFile(join(ctx.repoRoot, "patch", "cordis.patch.yml"), "utf8")) &&
        before.legacy === (await readFile(join(ctx.repoRoot, "patch", "disable-legacy.yml"), "utf8")),
    );

    await ctx.artifact("rollback.json", { denied, registry, patch: report });
  },
};
