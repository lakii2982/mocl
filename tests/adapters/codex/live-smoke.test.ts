/**
 * codex 真实 smoke（**默认不跑**）：仅当 `MOCL_LIVE=1` 时执行 1 轮真实 app-server。
 *
 * 零额度纪律：默认路径完全走假 transport（见 `transport/client/events/adapter` 测试）；
 * 本文件在 CI 中始终 skipped，只有人工验证时才允许消耗额度。
 *
 * 运行方式：
 * ```bash
 * MOCL_LIVE=1 pnpm -s test -- --run tests/adapters/codex/live-smoke.test.ts
 * # 可用 MOCL_CODEX_BIN 指定基线二进制、MOCL_CODEX_EXPECT 指定期望版本
 * ```
 * 若账号对该模型不可用（`model_not_found`），测试按约定标记 `skipped:model-unavailable` 而不是失败。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { CodexAdapter } from "../../../src/adapters/codex/index.ts";

const LIVE = process.env["MOCL_LIVE"] === "1";

/** 从 DSH desktop patch 读取运行时 `subagent.maxActiveSubagents`（D-016 的真实来源）。 */
function readSeamCapacity(): number | undefined {
  try {
    const patch = readFileSync(join(homedir(), ".dsh/profiles/desktop/cordis.patch.yml"), "utf8");
    const match = /maxActiveSubagents:\s*(\d+)/.exec(patch);
    if (match?.[1] === undefined) return undefined;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function collectUntilTerminal(adapter: CodexAdapter, timeoutMs: number): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const iterator = adapter.events()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<AdapterEvent>>((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), remaining).unref?.();
      }),
    ]);
    if (next.done === true) break;
    const event = next.value as AdapterEvent;
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted") return events;
  }
  return events;
}

describe("codex live smoke（MOCL_LIVE=1 才执行）", () => {
  it.skipIf(!LIVE)(
    "真实 app-server：open(ephemeral:false) → 1 turn → resume",
    async () => {
      const seamCapacity = readSeamCapacity();
      if (seamCapacity === undefined) {
        console.warn("skipped:runtime-unavailable（读不到 subagent.maxActiveSubagents，fail-closed）");
        return;
      }
      const cwd = process.cwd();
      const adapter = new CodexAdapter({
        ...(process.env["MOCL_CODEX_BIN"] === undefined ? {} : { binaryPath: process.env["MOCL_CODEX_BIN"] }),
        expectedVersion: process.env["MOCL_CODEX_EXPECT"] ?? "0.164.0",
        runtime: { read: () => ({ maxActiveSubagents: seamCapacity }) },
        allowedRoots: [cwd],
        maxTurnMs: 180_000,
      });
      const sessionId = "sess_01J9ZQ8K3M4N5P6Q7R8S9T0LIVE";
      try {
        const opened = await adapter.open({ sessionId, cwd, permissionProfile: "read-only", epoch: 1 });
        expect(opened.remoteSessionId.length).toBeGreaterThan(0);
        expect(adapter.capabilities.bits).toHaveLength(34);

        await adapter.send({ sessionId, remoteSessionId: opened.remoteSessionId, input: [{ type: "text", text: "只回复 OK，不要使用任何工具" }], idempotencyKey: "live-1" });
        const events = await collectUntilTerminal(adapter, 180_000);
        const terminal = events.find((event) => event.type === "turn.completed" || event.type === "turn.failed");
        if (terminal?.type === "turn.failed") {
          const code = (terminal.payload as { error?: { code?: string; message?: string } }).error;
          if (code?.message?.includes("model_not_found") || code?.code === "auth.provider-mismatch") {
            console.warn(`skipped:model-unavailable（${code.code}: ${code.message}）`);
            return;
          }
        }
        expect(terminal).toBeDefined();
        // 续接：新建的线程至少已发出首个 user message（materialized）
        const resumed = await adapter.resume({ sessionId, remoteSessionId: opened.remoteSessionId, fromSeq: 0 });
        expect(resumed.exists).toBe(true);
      } finally {
        await adapter.dispose();
      }
    },
    240_000,
  );
});
