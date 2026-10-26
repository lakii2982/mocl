/**
 * S12 — 真实装配自检：插件不注入假件时，四个后端能不能被装起来。
 *
 * 人物：按文档打开某个后端的用户。
 * 人类动作：改配置 → 重启 DSH → 看插件能不能初始化。
 * 判定：每个启用的后端都能通过 `createBackendAdapter` 装配（懒连接，不联网、不花额度）。
 *
 * 为什么重要：CI 的单元测试都注入假适配器，装配路径坏了不会被发现。
 * KI-01 已修复（issue #8）：opencode 装配改为注入 http/acp 客户端；未配置凭据时
 * 必须 fail-closed 抛 ABI `auth.missing-credential`，而不是 TypeError。
 */
import { join } from "node:path";
import { MoclFacade } from "../../src/facade/index.ts";
import { BACKENDS, configFor, runtimeAt } from "../lib/factories.mjs";

export default {
  id: "S12",
  scope: "usage",
  title: "真实装配自检（不注入假适配器）",
  persona: "按文档打开某个后端并重启 DSH 的用户",
  goal: "确认四后端都能走真实装配路径，而不是只在测试注入假件时可用",
  async run(ctx) {
    for (const backend of BACKENDS) {
      let error = null;
      let enabled = null;
      try {
        const facade = await MoclFacade.create({
          config: configFor({ enabled: [backend] }),
          runtime: runtimeAt(4),
          registryPath: join(ctx.dir, `registry-${backend}.json`),
        });
        enabled = facade.enabledBackendIds.join(",");
      } catch (caught) {
        error = caught;
      }

      if (backend === "opencode") {
        // With credentials configured, assembly must succeed (client construction is lazy:
        // no network or child process happens here).
        delete process.env.MOCL_OPENCODE_URL;
        delete process.env.MOCL_OPENCODE_PASSWORD;
        let failClosed = null;
        try {
          await MoclFacade.create({
            config: configFor({ enabled: [backend] }),
            runtime: runtimeAt(4),
            registryPath: join(ctx.dir, "registry-opencode-unconfigured.json"),
          });
        } catch (caught) {
          failClosed = caught;
        }
        ctx.assert(
          "assembly:opencode:fail-closed",
          failClosed !== null &&
            failClosed.name === "MoclError" &&
            failClosed.code === "auth.missing-credential",
          failClosed === null ? "expected an auth.missing-credential error" : `${failClosed.name}: ${String(failClosed.code ?? failClosed.message)}`,
        );

        process.env.MOCL_OPENCODE_URL = "http://127.0.0.1:1";
        process.env.MOCL_OPENCODE_PASSWORD = "scenario-password";
        try {
          const facade = await MoclFacade.create({
            config: configFor({ enabled: [backend] }),
            runtime: runtimeAt(4),
            registryPath: join(ctx.dir, "registry-opencode-configured.json"),
          });
          ctx.assert(
            "assembly:opencode",
            facade.enabledBackendIds.join(",") === "opencode",
            facade.enabledBackendIds.join(","),
          );
        } catch (caught) {
          ctx.assert("assembly:opencode", false, `${caught.name}: ${caught.message}`);
        } finally {
          delete process.env.MOCL_OPENCODE_URL;
          delete process.env.MOCL_OPENCODE_PASSWORD;
        }
        continue;
      }

      ctx.assert(
        `assembly:${backend}`,
        error === null && enabled === backend,
        error === null ? `enabled=${String(enabled)}` : `${error.name}: ${error.message}`,
      );
    }

    await ctx.artifact("assembly.json", { backends: BACKENDS });
  },
};
