/**
 * S12 — 真实装配自检：插件不注入假件时，四个后端能不能被装起来。
 *
 * 人物：按文档打开某个后端的用户。
 * 人类动作：改配置 → 重启 DSH → 看插件能不能初始化。
 * 判定：每个启用的后端都能通过 `createBackendAdapter` 装配（懒连接，不联网、不花额度）。
 *
 * 为什么重要：CI 的单元测试都注入假适配器，装配路径坏了不会被发现。
 * KI-01：opencode 真实装配当前直接抛 TypeError（OpenCodeAdapter 需要 http/acp 实例）。
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
        ctx.knownIssue(
          "KI-01",
          error !== null,
          error === null ? "opencode 装配已成功（请删除基线）" : `${error.name}: ${error.message}`,
        );
        if (error === null) ctx.assert("assembly:opencode", enabled === "opencode", String(enabled));
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
