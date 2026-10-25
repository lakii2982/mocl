/**
 * claude-code 适配器测试脚手架（C5）：假 SDK + 假 Query + 假会话探测器。
 *
 * 纪律：**默认不启动真实 claude**（零额度）。真实 smoke 只在 `MOCL_LIVE=1` 时由
 * `live-smoke.test.ts` 使用真实 SDK。
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
  type ClaudeRuntimeProvider,
} from "../../../src/adapters/claude-code/index.ts";
import type { SessionProber } from "../../../src/adapters/claude-code/resume.ts";
import type { AsyncQueryLike, SdkApiLike, SdkMessage, SdkUserMessage } from "../../../src/adapters/claude-code/types.ts";

/** 假 Query：可注入消息、记录控制面调用。 */
export class FakeQuery implements AsyncQueryLike {
  readonly #items: SdkMessage[] = [];
  readonly #waiters: ((result: IteratorResult<SdkMessage>) => void)[] = [];
  readonly interrupts: number[] = [];
  readonly streamedInputs: SdkUserMessage[] = [];
  readonly models: (string | undefined)[] = [];
  readonly permissionModes: string[] = [];
  closed = false;
  #ended = false;

  push(message: SdkMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: message, done: false });
      return;
    }
    this.#items.push(message);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async interrupt(): Promise<unknown> {
    this.interrupts.push(Date.now());
    return {};
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  async streamInput(stream: AsyncIterable<SdkUserMessage>): Promise<void> {
    for await (const message of stream) this.streamedInputs.push(message);
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkMessage> {
    return {
      next: (): Promise<IteratorResult<SdkMessage>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolveNext) => {
          this.#waiters.push(resolveNext);
        });
      },
    };
  }
}

/** 假 SDK 门面：记录 query 调用与选项。 */
export class FakeSdk implements SdkApiLike {
  readonly queries: FakeQuery[] = [];
  readonly calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  readonly sessionInfo: Map<string, { sessionId: string; cwd?: string; summary?: string }> = new Map();

  query(params: { prompt: string | AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }): FakeQuery {
    this.calls.push({ prompt: params.prompt, options: params.options });
    const query = new FakeQuery();
    this.queries.push(query);
    return query;
  }

  async getSessionInfo(sessionId: string): Promise<{ sessionId: string; cwd?: string; summary?: string } | undefined> {
    return this.sessionInfo.get(sessionId);
  }

  async listSessions(): Promise<readonly unknown[]> {
    return [...this.sessionInfo.values()];
  }

  async forkSession(sessionId: string): Promise<{ sessionId: string }> {
    return { sessionId: `${sessionId}-fork` };
  }
}

/** 假探测器：只断言"适配器是否在续接前探测"。 */
export class FakeProber implements SessionProber {
  readonly probes: string[] = [];
  constructor(private readonly known: Set<string> = new Set()) {}
  async exists(sessionId: string): Promise<boolean> {
    this.probes.push(sessionId);
    return this.known.has(sessionId);
  }
  add(sessionId: string): void {
    this.known.add(sessionId);
  }
}

export const INIT_SESSION_ID = "0f7c1f0e-1111-4222-8333-944455556666";

export function initMessage(overrides: Partial<Record<string, unknown>> = {}): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: INIT_SESSION_ID,
    claude_code_version: "2.1.263",
    cwd: "/tmp/work",
    model: "claude-sonnet-5",
    permissionMode: "dontAsk",
    tools: ["Read", "Grep", "Glob", "Agent", "Write", "Bash"],
    agents: ["general-purpose"],
    apiKeySource: "oauth",
    ...overrides,
  } as SdkMessage;
}

export function fixedRuntime(maxActiveSubagents: number): ClaudeRuntimeProvider {
  return { read: () => ({ maxActiveSubagents }) };
}

export interface HarnessOptions {
  readonly capacity?: number;
  readonly adapter?: ClaudeCodeAdapterOptions;
  readonly prober?: FakeProber;
  readonly sdk?: FakeSdk;
}

export interface Harness {
  readonly adapter: ClaudeCodeAdapter;
  readonly sdk: FakeSdk;
  readonly prober: FakeProber;
  get queries(): FakeQuery[];
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const sdk = options.sdk ?? new FakeSdk();
  const prober = options.prober ?? new FakeProber();
  const adapter = new ClaudeCodeAdapter({
    runtime: options.capacity === undefined ? fixedRuntime(8) : fixedRuntime(options.capacity),
    sdkLoader: async () => sdk,
    sessionProber: prober,
    initTimeoutMs: 200,
    ...options.adapter,
  });
  return {
    adapter,
    sdk,
    prober,
    get queries(): FakeQuery[] {
      return sdk.queries;
    },
  };
}

/** 等一个宏任务（让 reader 循环/query 创建推进）。 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 等待条件成立（带超时，避免测试挂起）。 */
export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await tick();
  }
}

/** 读取录制帧 JSONL（SDK → 适配器消息序列）。 */
export async function loadMessages(name: string): Promise<readonly SdkMessage[]> {
  const path = new URL(`../../fixtures/claude-code/${name}.jsonl`, import.meta.url);
  const text = await readFile(path, "utf8");
  const out: SdkMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    out.push(JSON.parse(trimmed) as SdkMessage);
  }
  return out;
}

/** 临时工作目录（cwd 校验要求真实存在的绝对路径）。 */
export async function makeWorkdir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c5-"));
  return { dir, cleanup: async (): Promise<void> => rm(dir, { recursive: true, force: true }) };
}

/** 收集事件直到谓词/超时。 */
export async function collectEvents(
  adapter: ClaudeCodeAdapter,
  options: { readonly until?: (event: AdapterEvent) => boolean; readonly timeoutMs?: number; readonly maxEvents?: number } = {},
): Promise<AdapterEvent[]> {
  const until = options.until ?? (() => false);
  const timeoutMs = options.timeoutMs ?? 1_000;
  const maxEvents = options.maxEvents ?? 200;
  const events: AdapterEvent[] = [];
  const iterator = adapter.events()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (events.length < maxEvents) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<AdapterEvent>>((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), remaining).unref?.();
      }),
    ]);
    if (next.done === true) break;
    const event = next.value as AdapterEvent;
    events.push(event);
    if (until(event)) break;
  }
  return events;
}

/**
 * 标准 open：只建会话（stream 模式下 init 不会在 open 阶段到达）。
 * 需要 init 时用 `handshake(harness)` 手动注入。
 */
export async function openSession(
  harness: Harness,
  options: { readonly cwd: string; readonly sessionId?: string; readonly profile?: "read-only" | "safe-auto" | "yolo" },
): Promise<{ sessionId: string; remoteSessionId: string }> {
  const sessionId = options.sessionId ?? "sess_01J9ZQ8K3M4N5P6Q7R8S9C5AB";
  const result = await harness.adapter.open({
    sessionId,
    cwd: options.cwd,
    permissionProfile: options.profile ?? "read-only",
    epoch: 1,
  });
  await waitFor(() => harness.queries.length > 0);
  return { sessionId, remoteSessionId: result.remoteSessionId };
}

/** 向指定 query 注入 `system/init`（首个 send 期间到达）。 */
export async function handshake(harness: Harness, index = 0, overrides: Record<string, unknown> = {}): Promise<void> {
  const query = harness.queries[index];
  if (query === undefined) throw new Error(`no query at index ${index}`);
  query.push(initMessage({ session_id: harness.adapter.sessionIds[index] ?? INIT_SESSION_ID, ...overrides }));
  await tick();
}
