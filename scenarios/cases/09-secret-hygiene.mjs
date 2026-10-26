/**
 * S09 — 密钥卫生：用户提供的密钥不得进入状态、注册表或报告。
 *
 * 人物：在 env / 任务文本里放了真实 key 的维护者。
 * 人类动作：配置凭据 → 派发任务 → 检查 MOCL 自己产出的所有可观测面。
 * 判定：
 * - 配置里的 env 值不会出现在错误信息/摘要里；
 * - 任务文本里的密钥不会被 status/list/注册表/报告回显；
 * - configDigest 不展开 env。
 *
 * KI-05：per-backend `env` 的自由键被 deepMerge 当成 unknown key，实际无法配置凭据。
 * 说明：后端**原生错误文本**的内容过滤不在本套件承诺范围内（见 README 的边界）。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, validateConfig } from "../../src/facade/index.ts";
import { configFor, createStack, runtimeAt, waitForToolTerminal } from "../lib/factories.mjs";
import { ScenarioAdapter } from "../lib/fake-backends.mjs";

export default {
  id: "S09",
  scope: "usage",
  title: "密钥卫生（配置 / 任务 / 状态 / 注册表）",
  persona: "在 env 或任务里放了真实 key 的维护者",
  goal: "确认 MOCL 产出的可观测面不含凭据值，configDigest 不展开 env",
  async run(ctx) {
    const secret = ctx.secret(`scenario-secret-${randomBytes(12).toString("hex")}`);

    // 1) 配置凭据：当前 env 自由键会被拒绝；拒绝信息只能带键名，不能带值。
    let envError = null;
    try {
      validateConfig({
        backends: { codex: { env: { MOCL_SCENARIO_API_KEY: secret } } },
      });
    } catch (error) {
      envError = error;
    }
    ctx.knownIssue(
      "KI-05",
      envError instanceof ConfigError,
      envError === null ? "env 配置已被接受（请删除基线）" : `${envError.name}: ${envError.message}`,
    );
    if (envError instanceof ConfigError) {
      ctx.assert("secret:config-error-no-value", !envError.message.includes(secret), "配置错误信息回显了密钥值");
      ctx.assert("secret:config-error-names-key", envError.message.includes("MOCL_SCENARIO_API_KEY"), envError.message);
    }

    // 2) 任务文本里的密钥：不得被 status/list/注册表回显。
    const repo = await ctx.repo();
    const config = configFor({ enabled: ["codex"], global: { logLevel: "debug" } });
    const adapter = new ScenarioAdapter("codex");
    const stack = await createStack({ ctx, config, runtime: runtimeAt(4), adapters: { codex: adapter } });

    const opened = await stack.host.callTool("subagent_agent", {
      backend: "codex",
      task: `只回复 OK。排查时参考这个临时值：${secret}`,
      cwd: repo,
    });
    ctx.assert("dispatch:ok", opened.ok === true, JSON.stringify(opened));
    const status = await waitForToolTerminal(stack.host, opened.childId, { timeoutMs: 5_000 });
    const list = await stack.host.callTool("mocl_status", {});

    const registryText = await readFile(join(ctx.dir, "sessions.json"), "utf8");
    const surfaces = {
      open: JSON.stringify(opened),
      status: JSON.stringify(status),
      list: JSON.stringify(list),
      configDigest: status.configDigest,
      registry: registryText,
    };
    for (const [name, text] of Object.entries(surfaces)) {
      ctx.assert(`secret:${name}`, !text.includes(secret), `${name} 泄漏了密钥值`);
    }
    ctx.assert("digest:no-env-expansion", !status.configDigest.includes("MOCL_SCENARIO_API_KEY") && !status.configDigest.includes('"env"'));
    ctx.assert("adapter:still-receives-task", adapter.sendRequests[0]?.input?.[0]?.text?.includes(secret) === true);

    await ctx.artifact("surfaces.json", Object.fromEntries(
      Object.entries(surfaces).map(([name, text]) => [name, text.split(secret).join("<leaked>")]),
    ));
    await stack.facade.close(opened.childId);
  },
};
