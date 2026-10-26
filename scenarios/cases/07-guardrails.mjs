/**
 * S07 — 权限与参数护栏：不该开的口子一个都不能开。
 *
 * 人物：好奇/手滑的开发者，以及一份写错的配置。
 * 人类动作：要求 yolo、传相对路径、传空任务、传错 backend、传越界 maxDepth、写错并发。
 * 判定：全部按 ABI 错误码拒绝；被拒请求不产生会话、不触达适配器；显式放行时 yolo 才可用。
 */
import { ConfigError, MoclFacade, validateConfig } from "../../src/facade/index.ts";
import { configFor, createStack, runtimeAt } from "../lib/factories.mjs";
import { fakeAdapters } from "../lib/fake-backends.mjs";

export default {
  id: "S07",
  scope: "usage",
  title: "权限与参数护栏",
  persona: "好奇/手滑的开发者 + 写错配置的运维",
  goal: "确认越权与非法参数被 ABI 错误码拒绝，且不会半开一个会话",
  async run(ctx) {
    const repo = await ctx.repo();
    const adapters = fakeAdapters();
    const stack = await createStack({
      ctx,
      config: configFor({ enabled: ["codex"] }),
      runtime: runtimeAt(4),
      adapters,
    });

    const agent = (args) => stack.host.callTool("subagent_agent", args);
    const expectCode = async (name, args, code) => {
      const result = await agent(args);
      const actual = result.ok === false ? result.error.code : "ok";
      return ctx.assert(name, actual === code, `actual=${actual} expected=${code} detail=${JSON.stringify(result).slice(0, 300)}`);
    };

    await expectCode("guard:yolo-denied", { backend: "codex", task: "x", cwd: repo, permissionMode: "yolo" }, "policy.escalation-required");
    await expectCode("guard:max-depth-over", { backend: "codex", task: "x", cwd: repo, maxDepth: 3 }, "limit.nesting-exceeded");
    await expectCode("guard:max-depth-zero", { backend: "codex", task: "x", cwd: repo, maxDepth: 0 }, "protocol.invalid-params");
    await expectCode("guard:relative-cwd", { backend: "codex", task: "x", cwd: "relative/path" }, "protocol.invalid-params");
    await expectCode("guard:empty-task", { backend: "codex", task: "   " }, "protocol.invalid-params");
    await expectCode("guard:unknown-backend", { backend: "gpt", task: "x" }, "protocol.invalid-params");
    ctx.assert("guard:no-adapter-call", adapters.codex.openCalls === 0, String(adapters.codex.openCalls));
    ctx.assert("guard:no-sessions", (await stack.facade.list()).children.length === 0);

    const badCursor = await stack.host.callTool("mocl_status", { cursor: -1 });
    ctx.assert(
      "guard:negative-cursor",
      badCursor.ok === false && badCursor.error.code === "protocol.invalid-params",
      JSON.stringify(badCursor.error),
    );

    // 人类显式打开危险档（三处开关都写对）后，yolo 才被允许。
    const dangerous = configFor({
      enabled: ["codex"],
      global: { dangerousModes: { allowed: true } },
      backends: { codex: { allowDangerousModes: true, worktreeIsolation: "always" } },
    });
    const dangerousStack = await createStack({
      ctx,
      config: dangerous,
      runtime: runtimeAt(4),
      adapters: fakeAdapters(),
      registryName: "sessions-dangerous.json",
    });
    const yolo = await dangerousStack.host.callTool("subagent_agent", {
      backend: "codex",
      task: "允许写入的任务",
      cwd: repo,
      permissionMode: "yolo",
    });
    ctx.assert("guard:explicit-yolo-allowed", yolo.ok === true, JSON.stringify(yolo));
    ctx.assert(
      "guard:explicit-yolo-forwarded",
      dangerousStack.adapters.codex.openRequests[0]?.permissionProfile === "yolo",
      JSON.stringify(dangerousStack.adapters.codex.openRequests[0]),
    );

    // 配置层护栏：硬上限/危险档组合非法时，启动即失败（fail-closed）。
    let progressIssue = null;
    try {
      validateConfig({ global: { progress: { maxItemsPerTurn: 9 } } });
    } catch (error) {
      progressIssue = error instanceof ConfigError ? error.issues.join("; ") : String(error);
    }
    ctx.assert("config:progress-hard-limit", String(progressIssue).includes("maxItemsPerTurn"), String(progressIssue));

    let dangerousIssue = null;
    try {
      validateConfig({ backends: { codex: { permissionMode: "yolo" } } });
    } catch (error) {
      dangerousIssue = error instanceof ConfigError ? error.issues.join("; ") : String(error);
    }
    ctx.assert("config:dangerous-requires-switch", String(dangerousIssue).includes("dangerousModes.allowed"), String(dangerousIssue));

    let capacityError = null;
    try {
      await MoclFacade.create({
        config: configFor({ enabled: ["codex"] }),
        configOverrides: { global: { maxConcurrent: 9 } },
        runtime: runtimeAt(2),
        adapters: fakeAdapters(),
        registryPath: `${ctx.dir}/sessions-capacity.json`,
      });
    } catch (error) {
      capacityError = error;
    }
    ctx.assert(
      "config:capacity-exceeds-runtime",
      capacityError instanceof ConfigError && String(capacityError.message).includes("exceeds runtime"),
      String(capacityError?.message ?? "no error"),
    );

    let runtimeError = null;
    try {
      await MoclFacade.create({
        config: configFor({ enabled: ["codex"] }),
        runtime: {
          read() {
            throw new Error("settings service unavailable");
          },
        },
        adapters: fakeAdapters(),
        registryPath: `${ctx.dir}/sessions-runtime.json`,
      });
    } catch (error) {
      runtimeError = error;
    }
    ctx.assert(
      "config:runtime-unavailable-fail-closed",
      runtimeError !== null && /runtime|settings/i.test(String(runtimeError?.message ?? "")),
      String(runtimeError?.message ?? "no error"),
    );

    await ctx.artifact("guardrails.json", {
      progressIssue,
      dangerousIssue,
      capacity: String(capacityError?.message ?? ""),
      runtime: String(runtimeError?.message ?? ""),
    });
  },
};
