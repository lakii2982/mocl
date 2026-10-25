/**
 * claude-code 真实 smoke（**默认不跑**）：仅当 `MOCL_LIVE=1` 时用真实 Agent SDK 跑 1 轮。
 *
 * 本机套餐可能 429/无权限：按约定打 `skipped:quota` 而不是失败。
 * 运行：`MOCL_LIVE=1 pnpm -s test -- --run tests/adapters/claude-code/live-smoke.test.ts`
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { ClaudeCodeAdapter } from "../../../src/adapters/claude-code/index.ts";

const LIVE = process.env["MOCL_LIVE"] === "1";

/** 从 DSH desktop patch 读取 `subagent.maxActiveSubagents`（D-016 的真实运行时来源）。 */
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

async function collectUntilTerminal(adapter: ClaudeCodeAdapter, timeoutMs: number): Promise<AdapterEvent[]> {
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

describe("claude-code live smoke（MOCL_LIVE=1 才执行）", () => {
  it.skipIf(!LIVE)(
    "真实 Agent SDK：open(persistSession) → 1 turn",
    async () => {
      const seam = readSeamCapacity();
      if (seam === undefined) {
        console.warn("skipped:runtime-unavailable（读不到 subagent.maxActiveSubagents）");
        return;
      }
      const cwd = process.cwd();
      const adapter = new ClaudeCodeAdapter({
        runtime: { read: () => ({ maxActiveSubagents: seam }) },
        allowedRoots: [cwd],
        initTimeoutMs: 60_000,
        expectedCliVersion: process.env["MOCL_CLAUDE_EXPECT"] ?? "2.1.263",
        maxTurns: 4,
      });
      const sessionId = "sess_01J9ZQ8K3M4N5P6Q7R8S9T0LIVE";
      try {
        const opened = await adapter.open({ sessionId, cwd, permissionProfile: "read-only", epoch: 1 });
        expect(opened.remoteSessionId.length).toBeGreaterThan(0);
        expect(adapter.capabilities.bits).toHaveLength(34);
        await adapter.send({
          sessionId,
          remoteSessionId: opened.remoteSessionId,
          input: [{ type: "text", text: "只回复 OK，不要使用任何工具" }],
          idempotencyKey: "live-1",
        });
        const events = await collectUntilTerminal(adapter, 180_000);
        const terminal = events.find(
          (event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted",
        );
        console.log(`live terminal: ${String(terminal?.type)}`);
        if (terminal?.type !== "turn.completed") {
          const error = (terminal?.payload as { error?: { code?: string; message?: string } } | undefined)?.error;
          const quotaLike = ["quota.rate-limited", "quota.usage-exhausted", "auth.credential-rejected", "auth.provider-mismatch", "auth.missing-credential"];
          if (error?.code !== undefined && quotaLike.includes(error.code)) {
            console.warn(`skipped:quota（${error.code}: ${error.message ?? ""}）`);
            return;
          }
          expect(terminal, `unexpected live failure: ${JSON.stringify(error)}`).toMatchObject({ type: "turn.completed" });
        }
        expect(terminal).toMatchObject({ type: "turn.completed" });
        // 冷恢复探测：会话文件已落盘（persistSession:true），新适配器能只读确认可续接。
        await adapter.dispose();
        const prober = new ClaudeCodeAdapter({
          runtime: { read: () => ({ maxActiveSubagents: seam }) },
          allowedRoots: [cwd],
          initTimeoutMs: 60_000,
        });
        try {
          const resumed = await prober.resume({ sessionId, remoteSessionId: opened.remoteSessionId, fromSeq: 0 });
          console.log(`live resume probe: exists=${String(resumed.exists)}`);
          expect(resumed.exists).toBe(true);
        } finally {
          await prober.dispose();
        }
      } finally {
        await adapter.dispose();
      }
    },
    240_000,
  );
});
