/**
 * kimi 真实烟雾测试（默认 **不跑**；`MOCL_LIVE=1` 才执行 1 轮，消耗额度）。
 *
 * 目的：验证契约测试的假件假设与真实后端一致（§12.3 K1/K7 的实机对照）：
 * - ACP `initialize` 回 `protocolVersion=1` / `agentInfo.version=2.3.1`；
 * - `session/new` 可用、`set_mode`/`set_config_option` 可切档；
 * - 一轮 `session/prompt` 走到 `stopReason:"end_turn"`（含 fs/read_text_file 反向请求）。
 *
 * 失败不阻塞：真实环境缺登录/网络时本文件在 `MOCL_LIVE=1` 下会失败，属**预期可观测**，
 * 默认 CI（不设该变量）永远 skip。
 */
import { describe, expect, it } from "vitest";
import { KimiAdapter } from "../../../src/adapters/kimi/index.ts";
import { readKimiConfigProbe } from "../../../src/adapters/kimi/permissions.ts";
import { defaultKimiBinary, spawnKimiAcpTransport, KimiAcpClient } from "../../../src/adapters/kimi/acp-client.ts";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { fixedRuntime } from "./helpers.ts";

const LIVE = process.env["MOCL_LIVE"] === "1";

describe.skipIf(!LIVE)("kimi 真实 ACP 冒烟（MOCL_LIVE=1）", () => {
  it(
    "握手断言 + 一轮 prompt（end_turn）",
    async () => {
      const cwd = process.cwd();
      const transport = spawnKimiAcpTransport({ binaryPath: defaultKimiBinary(), cwd });
      const client = new KimiAcpClient({
        transport,
        watchdogMs: 90_000,
        maxTurnMs: 240_000,
        allowedRoots: [cwd],
        permissionHandler: async () => ({ optionId: "reject" }),
      });
      try {
        const init = await client.initialize({ name: "mocl-live", version: "0.1" });
        expect(init.protocolVersion).toBe(1);
        expect(init.agentInfo?.version).toBe("2.3.1");

        const created = await client.newSession({ cwd });
        expect(created.sessionId).toMatch(/^session_/);
        // 显式切到只读规划档（§3.2 严格档）
        try {
          await client.setMode(created.sessionId, "plan");
        } catch {
          await client.setConfigOption(created.sessionId, "mode", "plan");
        }
        const result = await client.prompt(created.sessionId, "只回复 OK");
        expect(result.stopReason).toBe("end_turn");
      } finally {
        await client.terminate();
      }
    },
    300_000,
  );

  it(
    "适配器端到端：open + send + close",
    async () => {
      const cwd = process.cwd();
      const adapter = new KimiAdapter({
        transport: "acp",
        runtime: fixedRuntime(2),
        allowedRoots: [cwd],
        configProbe: () => readKimiConfigProbe(),
        maxTurnMs: 240_000,
      });
      const events: AdapterEvent[] = [];
      const pump = (async () => {
        for await (const event of adapter.events()) {
          events.push(event);
          if (event.type === "turn.completed" || event.type === "turn.failed") return;
        }
      })();
      try {
        const opened = await adapter.open({
          sessionId: "live-s1",
          cwd,
          permissionProfile: "read-only",
          epoch: 0,
        });
        expect(opened.remoteSessionId).toMatch(/^session_/);
        await adapter.send({
          sessionId: "live-s1",
          remoteSessionId: opened.remoteSessionId,
          input: [{ type: "text", text: "只回复 OK" }],
          idempotencyKey: "live-k1",
        });
        await pump;
        expect(events.map((event) => event.type)).toContain("turn.completed");
        await adapter.close({ sessionId: "live-s1", remoteSessionId: opened.remoteSessionId, reason: "completed" });
      } finally {
        await adapter.dispose();
      }
    },
    300_000,
  );

  it("二进制存在（预检 §2.4）", () => {
    const binary = defaultKimiBinary();
    expect(binary.length).toBeGreaterThan(0);
  });
});
