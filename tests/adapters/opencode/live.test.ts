/**
 * 真实 free 模型 smoke（默认跳过；仅 `MOCL_LIVE=1` 且能解析 service 配置时运行）。
 *
 * 运行：
 *   MOCL_LIVE=1 MOCL_OPENCODE_URL=http://127.0.0.1:49374 \
 *     pnpm exec vitest run tests/adapters/opencode/live.test.ts
 *
 * 断言（D-019）：
 * - 生产模型可用 → 一轮成功；
 * - 生产模型 401 api_key_expired（异步经 SSE 到达）→ 适配器显式降级（model=free-fallback），
 *   用免费模型重发一轮成功（禁止静默）。
 */
import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { OpenCodeAdapter } from "../../../src/adapters/opencode/index.ts";
import { OpenCodeHttpClient, resolveHttpConfig } from "../../../src/adapters/opencode/http-client.ts";
import { FREE_FALLBACK_MARKER, PRODUCTION_MODEL } from "../../../src/adapters/opencode/models.ts";
import { fixedRuntime } from "./helpers.ts";

const live = process.env["MOCL_LIVE"] === "1";
const config = live ? resolveHttpConfig(process.env) : undefined;
const input = [{ type: "text" as const, text: "只回复两个字符：OK" }];
const TERMINAL = new Set(["turn.completed", "turn.failed", "turn.aborted"]);

type Terminal = { readonly type: string; readonly payload: unknown };

/** 后台泵：把事件流灌进数组，再轮询等待终态（避免丢弃 pending next()）。 */
class EventPump {
  readonly events: AdapterEvent[] = [];
  #cursor = 0;
  readonly #done: Promise<void>;

  constructor(iterable: AsyncIterable<AdapterEvent>) {
    this.#done = (async () => {
      for await (const event of iterable) this.events.push(event);
    })();
    this.#done.catch(() => undefined);
  }

  /** 取「下一个尚未消费的终态」（每次调用前进游标，支持一轮失败后重发再等成功）。 */
  takeTerminal(): Terminal | undefined {
    while (this.#cursor < this.events.length) {
      const event = this.events[this.#cursor];
      this.#cursor += 1;
      if (event !== undefined && TERMINAL.has(event.type)) return { type: event.type, payload: event.payload };
    }
    return undefined;
  }
}

async function waitTerminal(pump: EventPump, timeoutMs: number): Promise<Terminal | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = pump.takeTerminal();
    if (terminal !== undefined) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe.skipIf(!live || config === undefined)("live free-model smoke（MOCL_LIVE=1）", () => {
  it(
    "生产模型优先；401 api_key_expired 时显式降级 free 并完成一轮",
    async () => {
      if (config === undefined) throw new Error("MOCL_LIVE requires MOCL_OPENCODE_URL and a readable service password");
      const http = new OpenCodeHttpClient({ ...config, timeoutMs: 90_000 });
      const adapter = new OpenCodeAdapter({
        transport: "http",
        http,
        runtime: fixedRuntime(2),
        initialModel: PRODUCTION_MODEL,
      });
      const pump = new EventPump(adapter.events());
      try {
        const opened = await adapter.open({
          sessionId: "sess_live",
          cwd: "/tmp",
          permissionProfile: "read-only",
          epoch: 1,
        });
        expect(opened.remoteSessionId).toMatch(/^ses_/);

        await adapter.send({
          sessionId: "sess_live",
          remoteSessionId: opened.remoteSessionId,
          input,
          idempotencyKey: "live-1",
        });
        const first = await waitTerminal(pump, 90_000);
        expect(first).toBeDefined();

        if (first?.type !== "turn.completed") {
          // 付费 key 过期：错误异步经 SSE 到达 → 适配器必须已显式降级
          expect(first?.type).toBe("turn.failed");
          expect(JSON.stringify(first?.payload)).toContain("auth.credential-expired");
          for (let index = 0; index < 40 && !adapter.modelState.degraded; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(adapter.modelState.degraded).toBe(true);
          expect(JSON.stringify(adapter.modelState)).toContain(FREE_FALLBACK_MARKER);

          // 降级后用免费模型重发一轮（新 turnId，不重放旧轮）
          await adapter.send({
            sessionId: "sess_live",
            remoteSessionId: opened.remoteSessionId,
            input,
            idempotencyKey: "live-2",
          });
          const second = await waitTerminal(pump, 90_000);
          expect(second?.type).toBe("turn.completed");
        } else {
          expect(adapter.modelState.model).toBe(PRODUCTION_MODEL);
        }
      } finally {
        await adapter.dispose();
      }
    },
    240_000,
  );
});
