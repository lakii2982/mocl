/**
 * S01 — 冷启动：默认配置必须 fail-closed。
 *
 * 人物：刚 clone 完仓库、还没改任何配置的新用户。
 * 人类动作：装好插件 → 看工具是否出现 → 试着让 codex 干活 → 被拒绝。
 * 判定：默认配置下不派发、不建会话、不写文件；错误必须是 ABI 的 policy 类，不能是内部异常。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig } from "../../src/facade/config.ts";
import { BACKENDS, configFor, createStack, runtimeAt } from "../lib/factories.mjs";
import { fakeAdapters } from "../lib/fake-backends.mjs";

export default {
  id: "S01",
  scope: "usage",
  title: "冷启动：默认配置 fail-closed",
  persona: "刚 clone 仓库、还没改配置的新用户",
  goal: "确认默认配置不会派发任务、不会偷偷建会话、不会写文件",
  async run(ctx) {
    const raw = JSON.parse(await readFile(join(ctx.repoRoot, "config.default.json"), "utf8"));
    const config = validateConfig(raw);

    ctx.assert("default:global-disabled", config.global.enabled === false, String(config.global.enabled));
    ctx.assert(
      "default:all-backends-disabled",
      BACKENDS.every((backend) => config.backends[backend].enabled === false),
      JSON.stringify(Object.fromEntries(BACKENDS.map((backend) => [backend, config.backends[backend].enabled]))),
    );
    ctx.assert(
      "default:read-only",
      BACKENDS.every((backend) => config.backends[backend].permissionMode === "read-only"),
    );
    ctx.assert("default:dangerous-modes-off", config.global.dangerousModes.allowed === false);
    ctx.assert(
      "default:progress-hard-limits",
      config.global.progress.maxItemsPerTurn === 8 &&
        config.global.progress.maxCharsPerTurn === 1200 &&
        config.global.progress.maxCharsPerItem === 400,
      JSON.stringify(config.global.progress),
    );
    ctx.assert(
      "default:matches-engine-defaults",
      JSON.stringify(config) === JSON.stringify(DEFAULT_CONFIG),
      "config.default.json 与 src/facade/config.ts 的 DEFAULT_CONFIG 不一致",
    );

    const repo = await ctx.repo();
    const before = await ctx.snapshot(repo);

    const adapters = fakeAdapters();
    const stack = await createStack({
      ctx,
      config,
      runtime: runtimeAt(4),
      adapters,
    });

    ctx.assert(
      "tools:registered",
      stack.host.toolNames().join(",") === "mocl_status,subagent_agent",
      stack.host.toolNames().join(","),
    );

    const list = await stack.host.callTool("mocl_status", {});
    ctx.assert("list:denied-while-disabled", list.ok === false, JSON.stringify(list));
    ctx.assert(
      "list:denied-is-policy",
      list.ok === false && list.error.code === "policy.permission-denied",
      JSON.stringify(list.error),
    );

    const dispatched = await stack.host.callTool("subagent_agent", {
      backend: "codex",
      task: "只读看一下这个仓库，回答 1+1",
      cwd: repo,
    });
    ctx.assert("dispatch:denied", dispatched.ok === false, JSON.stringify(dispatched));
    ctx.assert(
      "dispatch:policy-error",
      dispatched.ok === false && dispatched.error.code === "policy.permission-denied",
      JSON.stringify(dispatched.error),
    );
    ctx.assert("dispatch:no-adapter-call", adapters.codex.openCalls === 0, String(adapters.codex.openCalls));
    ctx.assert(
      "dispatch:no-session-leaked",
      !JSON.stringify(dispatched).includes("sess_"),
      JSON.stringify(dispatched),
    );

    // 人类常见误解：只打开 global.enabled，以为后端会自动可用。
    const globalOnly = await createStack({
      ctx,
      config: configFor({ enabled: [] }),
      runtime: runtimeAt(4),
      adapters: fakeAdapters(),
      registryName: "sessions-global-only.json",
    });
    const emptyList = await globalOnly.host.callTool("mocl_status", {});
    ctx.assert("list:empty-after-global-enable", emptyList.ok === true && emptyList.children.length === 0, JSON.stringify(emptyList));
    const stillDenied = await globalOnly.host.callTool("subagent_agent", { backend: "codex", task: "hello", cwd: repo });
    ctx.assert("dispatch:backend-still-disabled", stillDenied.ok === false, JSON.stringify(stillDenied));
    ctx.assert(
      "dispatch:backend-disabled-message",
      stillDenied.ok === false &&
        (stillDenied.error.code === "policy.permission-denied" || stillDenied.error.code === "capability.missing"),
      JSON.stringify(stillDenied.error),
    );

    const unknown = await globalOnly.host.callTool("mocl_status", { childId: "sess_does_not_exist" });
    ctx.assert("status:unknown-session", unknown.ok === false && unknown.error.code === "session.not-found", JSON.stringify(unknown));

    await ctx.assertUnchanged("repo:no-writes", repo, before);
    await ctx.artifact("dispatched.json", { dispatched, listDenied: list, stillDenied, unknown });
  },
};
