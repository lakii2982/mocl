/**
 * C7 opencode 适配器测试假件（默认零额度；不触碰真实 service）。
 *
 * 提供：
 * - `fixedRuntime` / `failingRuntime`：D-016 运行时派生容量；
 * - `FakeFetch`：可注入 fetch（记录调用、按路由返回 Response / SSE 流）；
 * - `FakeHttpApi`：`OpenCodeHttpApi` 假实现（适配器测试用）；
 * - `FakeAcp` / `FakeTransport`：ACP 假实现（stdio 行管道）；
 * - `drainUntil`：从 `events()` 异步迭代器收集事件；
 * - fixture 读取与临时目录。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import type { RuntimeConfigProvider, RuntimeSnapshot } from "../../../src/broker/concurrency.ts";
import { moclError, type MoclError } from "../../../src/broker/errors.ts";
import type { AcpApi, AcpInitResult, AcpTransport } from "../../../src/adapters/opencode/acp-client.ts";
import type { OpenCodeHttpApi } from "../../../src/adapters/opencode/http-client.ts";
import type {
  FetchLike,
  InboxItem,
  InboxUser,
  InterruptResult,
  ModelRef,
  OpenApiDocument,
  OpenCodePermissionDecision,
  OpenCodePermissionRequest,
  OpenCodeSessionInfo,
  ServerInfo,
  SseFrame,
} from "../../../src/adapters/opencode/types.ts";
import type { AcpConfigOption, AcpNewSessionResult, AcpPromptResult, AcpSessionUpdateParams } from "../../../src/adapters/opencode/types.ts";

/* ---------------------------- runtime ---------------------------- */

export function fixedRuntime(capacity: number): RuntimeConfigProvider {
  return { read: (): RuntimeSnapshot => ({ maxActiveSubagents: capacity }) };
}

export function failingRuntime(): RuntimeConfigProvider {
  return {
    read: (): RuntimeSnapshot => {
      throw new Error("runtime unavailable");
    },
  };
}

export function invalidRuntime(): RuntimeConfigProvider {
  return { read: (): RuntimeSnapshot => ({ maxActiveSubagents: 0 }) };
}

/* ---------------------------- fixtures ---------------------------- */

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/opencode", import.meta.url));

export function loadFrames(name: "sse-success" | "sse-auth-expired" | "catalog-noise"): SseFrame[] {
  return readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SseFrame);
}

/* ---------------------------- fake fetch ---------------------------- */

export interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type RouteHandler = (call: FetchCall) => Response | Promise<Response>;

/** 可注入 fetch：按 `METHOD /path` 路由；未命中 → 404。 */
export class FakeFetch {
  readonly calls: FetchCall[] = [];
  readonly #routes = new Map<string, RouteHandler>();

  constructor(routes: Record<string, RouteHandler | Response> = {}) {
    for (const [key, value] of Object.entries(routes)) {
      this.#routes.set(key, typeof value === "function" ? value : () => value);
    }
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? tryParse(rawBody) : undefined;
    const call: FetchCall = { method, url, headers, body };
    this.calls.push(call);
    const handler = this.#routes.get(`${method} ${parsed.pathname}`) ?? this.#routes.get(`${method} *`);
    if (handler === undefined) {
      return jsonResponse({ error: "not found" }, 404);
    }
    return handler(call);
  };

  route(key: string, handler: RouteHandler | Response): void {
    this.#routes.set(key, typeof handler === "function" ? handler : () => handler);
  }

  count(method: string, pathContains?: string): number {
    return this.calls.filter(
      (call) => call.method === method && (pathContains === undefined || call.url.includes(pathContains)),
    ).length;
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (typeof headers === "object" && "entries" in headers && typeof (headers as { entries: unknown }).entries === "function") {
    return Object.fromEntries((headers as { entries(): Iterable<[string, string]> }).entries());
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers as [string, string][]);
  return { ...(headers as Record<string, string>) };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `{data: ...}` 包络（v2 多数端点的实测形状）。 */
export function dataResponse(data: unknown, status = 200): Response {
  return jsonResponse({ data }, status);
}

/** SSE 响应：按行构造流，可把一帧切成两个 chunk（验证半行缓冲）。 */
export function sseResponse(lines: readonly string[], options: { readonly splitFrames?: boolean } = {}): Response {
  const chunks: string[] = [];
  for (const line of lines) {
    if (options.splitFrames === true && line.length > 10) {
      chunks.push(`data: ${line.slice(0, 7)}`);
      chunks.push(`${line.slice(7)}\n\n`);
    } else {
      chunks.push(`data: ${line}\n\n`);
    }
  }
  chunks.push(": heartbeat\n\n");
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/* ---------------------------- fake http api ---------------------------- */

export interface CreateSessionCall {
  readonly agent: string;
  readonly model: ModelRef;
  readonly location: { readonly directory: string };
}

export type PromptBehavior =
  | "ok"
  | "emit-success"
  | "emit-auth-expired"
  | "throw-auth-expired"
  | "throw-rate-limited"
  | Error;

/** `OpenCodeHttpApi` 假实现：默认所有调用成功；可配置 prompt 行为与 SSE 帧。 */
export class FakeHttpApi implements OpenCodeHttpApi {
  readonly createSessionCalls: CreateSessionCall[] = [];
  readonly promptCalls: { readonly sessionId: string; readonly text: string }[] = [];
  readonly switchModelCalls: ModelRef[] = [];
  readonly interruptCalls: boolean[] = [];
  readonly replyCalls: { readonly sessionId: string; readonly requestId: string; readonly decision: OpenCodePermissionDecision }[] = [];
  promptBehaviors: PromptBehavior[] = [];
  frames: SseFrame[] = loadFrames("sse-success");
  sessionInfo: OpenCodeSessionInfo = { id: "ses_test_1", outcome: null, tokens: { input: 1, output: 1 } };
  getSessionError: MoclError | undefined;
  openapiOverride: OpenApiDocument | undefined;
  interruptResult: InterruptResult = { interrupted: true };
  readonly permissions: OpenCodePermissionRequest[] = [];
  #sseHandler: ((frame: SseFrame) => void) | undefined;
  #sseDone: (() => void) | undefined;
  closed = false;

  get info(): ServerInfo {
    return { version: "2.1.4", pid: 1234 };
  }

  get openapi(): OpenApiDocument {
    return this.openapiOverride ?? fakeOpenApi();
  }

  async getInfo(): Promise<ServerInfo> {
    return this.info;
  }

  async getOpenApi(): Promise<OpenApiDocument> {
    return this.openapi;
  }

  async createSession(request: CreateSessionCall): Promise<OpenCodeSessionInfo> {
    this.createSessionCalls.push(request);
    return { id: "ses_test_1", agent: request.agent, model: request.model, location: request.location, outcome: null };
  }

  async promptSession(sessionId: string, text: string): Promise<InboxUser> {
    this.promptCalls.push({ sessionId, text });
    const behavior = this.promptBehaviors.shift() ?? "ok";
    if (behavior instanceof Error) throw behavior;
    switch (behavior) {
      case "throw-auth-expired":
        throw moclError("auth.credential-expired", { message: "api_key_expired", backendCode: "api_key_expired" });
      case "throw-rate-limited":
        throw moclError("quota.rate-limited", { message: "429" });
      case "emit-auth-expired":
        queueMicrotask(() => {
          for (const frame of loadFrames("sse-auth-expired")) this.emit(this.#withSession(frame, sessionId));
        });
        break;
      case "emit-success":
        queueMicrotask(() => {
          for (const frame of this.frames) this.emit(this.#withSession(frame, sessionId));
        });
        break;
      default:
        break;
    }
    return { id: `msg_${this.promptCalls.length}`, sessionID: sessionId, type: "user", delivery: "steer" };
  }

  async getSession(sessionId: string): Promise<OpenCodeSessionInfo> {
    if (this.getSessionError !== undefined) throw this.getSessionError;
    return { ...this.sessionInfo, id: sessionId };
  }

  async listSessions(): Promise<readonly OpenCodeSessionInfo[]> {
    return [this.sessionInfo];
  }

  async listInbox(): Promise<readonly InboxItem[]> {
    return [];
  }

  async deleteInboxItem(): Promise<void> {
    return undefined;
  }

  async interrupt(_sessionId: string, resume: boolean): Promise<InterruptResult> {
    this.interruptCalls.push(resume);
    return this.interruptResult;
  }

  async fork(): Promise<OpenCodeSessionInfo> {
    return { ...this.sessionInfo, id: "ses_forked" };
  }

  async switchModel(_sessionId: string, model: ModelRef): Promise<OpenCodeSessionInfo> {
    this.switchModelCalls.push(model);
    return { id: "ses_test_1", model, outcome: null };
  }

  async switchAgent(): Promise<OpenCodeSessionInfo> {
    return { ...this.sessionInfo };
  }

  async listMessages(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return [];
  }

  async listPermissionRequests(): Promise<readonly OpenCodePermissionRequest[]> {
    return this.permissions;
  }

  async replyPermission(sessionId: string, requestId: string, decision: OpenCodePermissionDecision): Promise<void> {
    this.replyCalls.push({ sessionId, requestId, decision });
  }

  async subscribeEvents(handler: (frame: SseFrame) => void, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.#sseHandler = handler;
    // 真实服务连接后立即推 server.connected；假件同样先就绪，避免适配器 open 等待超时。
    queueMicrotask(() => handler({ id: "evt_ready", type: "server.connected", data: {} }));
    return await new Promise<void>((resolve) => {
      this.#sseDone = resolve;
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  emit(frame: SseFrame): void {
    this.#sseHandler?.(frame);
  }

  /** fixture 的 sessionID 与假会话 id 对齐（适配器会丢弃非本会话事件）。 */
  #withSession(frame: SseFrame, sessionId: string): SseFrame {
    if (frame.data === undefined || frame.data["sessionID"] === undefined) return frame;
    return { ...frame, data: { ...frame.data, sessionID: sessionId } };
  }

  endStream(): void {
    this.#sseDone?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.endStream();
  }
}

/** 124 路径 + 必需 operationId 的 OpenAPI 假文档（握手断言用）。 */
export function fakeOpenApi(): OpenApiDocument {
  const required = [
    "event.subscribe",
    "session.create",
    "session.prompt",
    "session.interrupt",
    "session.fork",
    "session.inbox.list",
    "session.permission.reply",
    "session.switchModel",
  ];
  const paths: Record<string, unknown> = {};
  required.forEach((operationId, index) => {
    paths[`/api/required${index}`] = { post: { operationId } };
  });
  for (let index = required.length; Object.keys(paths).length < 124; index += 1) {
    paths[`/api/filler${index}`] = { get: { operationId: `filler.${index}` } };
  }
  return { openapi: "3.1.0", info: { title: "opencode HttpApi", version: "0.0.1" }, paths };
}

/* ---------------------------- fake ACP ---------------------------- */

/** 假 ACP 传输：内存行管道（测试 `AcpClient` 的协议面）。 */
export class FakeTransport implements AcpTransport {
  readonly written: string[] = [];
  readonly #lineHandlers: ((line: string) => void)[] = [];
  readonly #closeHandlers: (() => void)[] = [];
  closed = false;

  writeLine(line: string): void {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.#closeHandlers) handler();
  }

  /** 服务端 → 客户端：发一行 JSON。 */
  sendFromServer(message: Readonly<Record<string, unknown> | unknown[]>): void {
    const line = JSON.stringify(message);
    for (const handler of this.#lineHandlers) handler(line);
  }

  respond(id: number, result: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.sendFromServer({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", method, params });
  }

  serverRequest(id: number, method: string, params: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", id, method, params });
  }

  lastRequest(): { readonly id: number; readonly method: string; readonly params: Readonly<Record<string, unknown>> } {
    const line = this.written.at(-1);
    if (line === undefined) throw new Error("no request written");
    const parsed = JSON.parse(line) as { id: number; method: string; params: Readonly<Record<string, unknown>> };
    return parsed;
  }
}

/** `AcpApi` 假实现（适配器 ACP 模式测试用）。 */
export class FakeAcp implements AcpApi {
  readonly configOptionCalls: { readonly sessionId: string; readonly configId: string; readonly value: string }[] = [];
  readonly ensureCalls: string[] = [];
  promptResult: AcpPromptResult = {
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 0 },
  };
  promptError: MoclError | undefined;
  loadError: MoclError | undefined;
  initResult: AcpInitResult = { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "2.1.4" } };
  #updateHandler: ((params: AcpSessionUpdateParams) => void) | undefined;
  terminated = false;

  async initialize(): Promise<AcpInitResult> {
    return this.initResult;
  }

  async newSession(request: { readonly cwd: string }): Promise<AcpNewSessionResult> {
    this.ensureCalls.push(request.cwd);
    return {
      sessionId: "ses_acp_1",
      configOptions: [{ id: "model", currentValue: "opencode-go/iceman-contributor-free" }],
    };
  }

  async loadSession(request: { readonly sessionId: string }): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }> {
    if (this.loadError !== undefined) throw this.loadError;
    return { configOptions: [{ id: "model", currentValue: "opencode/deepseek-v4.1-flash-free" }] };
  }

  async prompt(): Promise<AcpPromptResult> {
    if (this.promptError !== undefined) throw this.promptError;
    return this.promptResult;
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }> {
    this.configOptionCalls.push({ sessionId, configId, value });
    return { configOptions: [{ id: configId, currentValue: value }] };
  }

  async setMode(): Promise<void> {
    return undefined;
  }

  async fork(): Promise<AcpNewSessionResult> {
    return { sessionId: "ses_acp_forked" };
  }

  async listSessions(): Promise<readonly { readonly sessionId: string }[]> {
    return [{ sessionId: "ses_acp_1" }];
  }

  onUpdate(handler: (params: AcpSessionUpdateParams) => void): void {
    this.#updateHandler = handler;
  }

  emitUpdate(update: Readonly<Record<string, unknown>>, sessionId = "ses_acp_1"): void {
    this.#updateHandler?.({ sessionId, update });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

/* ---------------------------- event draining ---------------------------- */

/**
 * 从适配器事件流收集事件，直到 predicate 命中或超时（默认 2s）。
 *
 * 实现用「后台泵 + 轮询」：不要用 `Promise.race(iterator.next(), timeout)`，
 * 否则超时分支会丢掉那个尚未 resolve 的 `next()`，事件被静默消费掉（测试假象）。
 */
export async function drainUntil(
  iterable: AsyncIterable<AdapterEvent>,
  predicate: (events: readonly AdapterEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  let finished = false;
  const pump = (async () => {
    try {
      for await (const event of iterable) {
        events.push(event);
        if (predicate(events)) return;
      }
    } finally {
      finished = true;
    }
  })();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate(events) && !finished) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // 不再等待 pump（事件流在 close/dispose 前不会结束）。
  pump.catch(() => undefined);
  return events;
}

export function typeOf(event: AdapterEvent): string {
  return event.type;
}

/* ---------------------------- temp dir ---------------------------- */

export async function makeTempDir(): Promise<{ readonly dir: string; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c7-"));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
