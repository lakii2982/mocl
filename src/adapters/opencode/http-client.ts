/**
 * opencode v2 HttpApi 客户端（主通道；docs/adapters/opencode.md §2.2/§3.1/§4/§5.2）。
 *
 * 约定：
 * - Basic auth：`user=opencode`，密码来自 `MOCL_OPENCODE_PASSWORD` 或 service.json 的 `password` 字段；
 *   **只读不打印**，错误消息经 sanitize 处理（SEC-1）。
 * - 响应包络：多数端点 `{ "data": ... }`（列表另带 cursor）；这里统一 unwrap 为业务对象。
 * - 重试：幂等 GET 默认重试 2 次（网络错误 / 429 / 5xx）；POST/PATCH/DELETE 一律不重试（ABI §9 / 本文 §4.3）。
 * - SSE：行协议 `data: {json}` + `: heartbeat`；解析逻辑独立导出（SseParser）便于单测。
 */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateSessionRequest,
  FetchLike,
  InboxItem,
  InboxUser,
  InterruptResult,
  ModelRef,
  OpenApiDocument,
  OpenCodeHttpConfig,
  OpenCodePermissionDecision,
  OpenCodePermissionRequest,
  OpenCodeSessionInfo,
  ServerInfo,
  SseFrame,
} from "./types.ts";
import { mapHttpError, sanitize, toMoclError } from "./errors.ts";
import { moclError } from "../../broker/errors.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GET_RETRIES = 2;
const USERNAME = "opencode";
/** service.json 候选路径（实测 `~/.config/opencode/service.json`；保留旧路径作兼容）。 */
const SERVICE_FILES: readonly (readonly string[])[] = [
  [".config", "opencode", "service.json"],
  [".local", "share", "opencode", "service.json"],
];

/** v2 API 的最小接口面（便于适配器测试注入假实现；真实实现是 `OpenCodeHttpClient`）。 */
export interface OpenCodeHttpApi {
  getInfo(): Promise<ServerInfo>;
  getOpenApi(): Promise<OpenApiDocument>;
  createSession(request: CreateSessionRequest): Promise<OpenCodeSessionInfo>;
  promptSession(sessionId: string, text: string, delivery?: "steer" | "queue"): Promise<InboxUser>;
  getSession(sessionId: string): Promise<OpenCodeSessionInfo>;
  listSessions(params?: {
    readonly limit?: number;
    readonly search?: string;
    readonly order?: "asc" | "desc";
  }): Promise<readonly OpenCodeSessionInfo[]>;
  listInbox(sessionId: string): Promise<readonly InboxItem[]>;
  deleteInboxItem(sessionId: string, inboxId: string): Promise<void>;
  interrupt(sessionId: string, resume: boolean): Promise<InterruptResult>;
  fork(sessionId: string, boundary?: { readonly type: "through"; readonly messageID: string }): Promise<OpenCodeSessionInfo>;
  switchModel(sessionId: string, model: ModelRef): Promise<OpenCodeSessionInfo | undefined>;
  switchAgent(sessionId: string, agent: string): Promise<OpenCodeSessionInfo | undefined>;
  listMessages(sessionId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listPermissionRequests(location: string): Promise<readonly OpenCodePermissionRequest[]>;
  replyPermission(sessionId: string, requestId: string, decision: OpenCodePermissionDecision): Promise<void>;
  subscribeEvents(handler: (frame: SseFrame) => void, options?: { readonly signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 凭据 / 服务发现（只读、不打印）                                      */
/* ------------------------------------------------------------------ */

/**
 * 读取 `~/.local/share/opencode/service.json` 的 `password` 字段。
 * - 仅返回字符串，不记录/不打印；
 * - 文件不存在/不可解析 → `undefined`（调用方决定 fail-closed）。
 */
export function readServicePassword(home: string = homedir()): string | undefined {
  for (const parts of SERVICE_FILES) {
    try {
      const raw = readFileSync(join(home, ...parts), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        const password = (parsed as Record<string, unknown>)["password"];
        if (typeof password === "string" && password.length > 0) return password;
      }
    } catch {
      // 该候选不存在/不可解析：继续下一个；绝不打印内容。
    }
  }
  return undefined;
}

/**
 * 从环境 + service.json 解析 HTTP 通道配置。
 * `baseUrl` 必须显式提供（`MOCL_OPENCODE_URL`；后台 service 端口是随机的，不能猜）。
 */
export function resolveHttpConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): OpenCodeHttpConfig | undefined {
  const baseUrl = env["MOCL_OPENCODE_URL"]?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const password = env["MOCL_OPENCODE_PASSWORD"] ?? readServicePassword(home);
  if (password === undefined) return undefined;
  return { baseUrl, password };
}

/* ------------------------------------------------------------------ */
/* SSE 行解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * SSE 解析器：处理跨 chunk 的半行、`data:` 多行拼接、`:` 注释（heartbeat）。
 * 非 JSON 的 data 行丢弃（由调用方计数，不视为协议错误）。
 */
export class SseParser {
  #buffer = "";
  #dataLines: string[] = [];
  readonly #onFrame: (frame: SseFrame) => void;

  constructor(onFrame: (frame: SseFrame) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const rawLine = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#line(rawLine.replace(/\r$/, ""));
      index = this.#buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.#buffer.length > 0) {
      this.#line(this.#buffer.replace(/\r$/, ""));
      this.#buffer = "";
    }
    this.#flush();
  }

  #line(line: string): void {
    if (line.length === 0) {
      this.#flush();
      return;
    }
    if (line.startsWith(":")) return; // heartbeat / 注释
    if (line.startsWith("data:")) {
      this.#dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      return;
    }
    // event:/id:/retry: 字段：opencode 实测只用 data，其余忽略。
  }

  #flush(): void {
    if (this.#dataLines.length === 0) return;
    const payload = this.#dataLines.join("\n");
    this.#dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // 坏帧丢弃；调用方如需计数可在外层包一层
    }
    const frame = toSseFrame(parsed);
    if (frame !== undefined) this.#onFrame(frame);
  }
}

function toSseFrame(value: unknown): SseFrame | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return undefined;
  return value as SseFrame;
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

export class OpenCodeHttpClient implements OpenCodeHttpApi {
  readonly #baseUrl: string;
  readonly #password: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #maxGetRetries: number;
  #closed = false;

  constructor(config: OpenCodeHttpConfig) {
    if (config.baseUrl.length === 0) throw moclError("protocol.invalid-params", { message: "opencode baseUrl is empty" });
    if (config.password.length === 0) {
      throw moclError("auth.missing-credential", { message: "opencode server password is not configured" });
    }
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#password = config.password;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxGetRetries = config.maxGetRetries ?? DEFAULT_GET_RETRIES;
  }

  /** 便于日志/测试的脱敏描述（绝不含密码）。 */
  get description(): string {
    return `opencode http ${this.#baseUrl}`;
  }

  #authHeader(): string {
    return `Basic ${Buffer.from(`${USERNAME}:${this.#password}`, "utf8").toString("base64")}`;
  }

  async #request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: {
      readonly body?: unknown;
      readonly retry?: number;
      readonly timeoutMs?: number;
      readonly sessionScoped?: boolean;
      readonly accept?: string;
      readonly rawResponse?: boolean;
    } = {},
  ): Promise<T> {
    if (this.#closed) throw moclError("transport.disconnected", { message: "opencode http client is closed" });
    const retry = options.retry ?? (method === "GET" ? this.#maxGetRetries : 0);
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: this.#authHeader(),
          Accept: options.accept ?? "application/json",
        };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        const init: RequestInit = {
          method,
          headers,
          signal: controller.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        };
        const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const body = tryParseJson(text);
          const error = mapHttpError(response.status, body, {
            sessionScoped: options.sessionScoped === true,
            operation: `${method} ${path.split("?")[0] ?? path}`,
          });
          // 仅幂等 GET 对 429/5xx 重试；POST 一律不重试（ABI §9）。
          const retryable =
            method === "GET" &&
            (response.status === 429 || response.status === 503 || response.status === 502 || response.status === 504);
          if (retryable && attempt < retry) {
            lastError = error;
            await delay(backoffMs(attempt));
            continue;
          }
          throw error;
        }
        const payload = options.rawResponse === true ? undefined : await response.json().catch(() => null);
        return unwrap<T>(payload);
      } catch (error) {
        const normalized = toMoclError(error);
        // 网络类失败才重试；协议/鉴权错误直接抛。
        const retryable =
          method === "GET" &&
          (normalized.code === "transport.timeout" || normalized.code === "transport.connect-failed");
        if (retryable && attempt < retry) {
          lastError = normalized;
          await delay(backoffMs(attempt));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }
    throw toMoclError(lastError);
  }

  async getInfo(): Promise<ServerInfo> {
    return this.#request<ServerInfo>("GET", "/api/info", { sessionScoped: false });
  }

  async getOpenApi(): Promise<OpenApiDocument> {
    return this.#request<OpenApiDocument>("GET", "/openapi.json", { sessionScoped: false });
  }

  async createSession(request: CreateSessionRequest): Promise<OpenCodeSessionInfo> {
    return this.#request<OpenCodeSessionInfo>("POST", "/api/session", { body: request });
  }

  async promptSession(sessionId: string, text: string, delivery: "steer" | "queue" = "steer"): Promise<InboxUser> {
    return this.#request<InboxUser>("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      body: { text, delivery },
      sessionScoped: true,
    });
  }

  async getSession(sessionId: string): Promise<OpenCodeSessionInfo> {
    return this.#request<OpenCodeSessionInfo>("GET", `/api/session/${encodeURIComponent(sessionId)}`, {
      sessionScoped: true,
    });
  }

  async listSessions(params: {
    readonly limit?: number;
    readonly search?: string;
    readonly order?: "asc" | "desc";
  } = {}): Promise<readonly OpenCodeSessionInfo[]> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.search !== undefined) query.set("search", params.search);
    if (params.order !== undefined) query.set("order", params.order);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#request<readonly OpenCodeSessionInfo[]>("GET", `/api/session${suffix}`, { sessionScoped: false });
  }

  async listInbox(sessionId: string): Promise<readonly InboxItem[]> {
    return this.#request<readonly InboxItem[]>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/inbox`,
      { sessionScoped: true },
    );
  }

  async deleteInboxItem(sessionId: string, inboxId: string): Promise<void> {
    await this.#request<unknown>(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
      { sessionScoped: true },
    );
  }

  async interrupt(sessionId: string, resume: boolean): Promise<InterruptResult> {
    return this.#request<InterruptResult>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=${resume ? "true" : "false"}`,
      { sessionScoped: true, body: {} },
    );
  }

  async fork(
    sessionId: string,
    boundary?: { readonly type: "through"; readonly messageID: string },
  ): Promise<OpenCodeSessionInfo> {
    return this.#request<OpenCodeSessionInfo>("POST", `/api/session/${encodeURIComponent(sessionId)}/fork`, {
      body: boundary === undefined ? {} : { boundary },
      sessionScoped: true,
    });
  }

  async switchModel(sessionId: string, model: ModelRef): Promise<OpenCodeSessionInfo | undefined> {
    return this.#request<OpenCodeSessionInfo | undefined>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/model`,
      { body: { model }, sessionScoped: true },
    );
  }

  async switchAgent(sessionId: string, agent: string): Promise<OpenCodeSessionInfo | undefined> {
    return this.#request<OpenCodeSessionInfo | undefined>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/agent`,
      { body: { agent }, sessionScoped: true },
    );
  }

  async listMessages(sessionId: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return this.#request<readonly Readonly<Record<string, unknown>>[]>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message`,
      { sessionScoped: true },
    );
  }

  async listPermissionRequests(location: string): Promise<readonly OpenCodePermissionRequest[]> {
    const query = new URLSearchParams({ "location[directory]": location });
    return this.#request<readonly OpenCodePermissionRequest[]>("GET", `/api/permission/request?${query.toString()}`, {
      sessionScoped: false,
    });
  }

  async replyPermission(sessionId: string, requestId: string, decision: OpenCodePermissionDecision): Promise<void> {
    await this.#request<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: { decision }, sessionScoped: true },
    );
  }

  /** SSE 订阅；返回的 Promise 在 abort 或流结束时 resolve（不抛正常结束）。 */
  async subscribeEvents(handler: (frame: SseFrame) => void, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.#closed) return;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/event`, {
        method: "GET",
        headers: { Authorization: this.#authHeader(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw mapHttpError(response.status, undefined, { operation: "GET /api/event" });
      }
      const parser = new SseParser(handler);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parser.push(decoder.decode(chunk.value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (options.signal?.aborted === true) return;
      throw toMoclError(error);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** 便于错误消息：只暴露 baseUrl（不含密码）。 */
  toString(): string {
    return sanitize(this.description);
  }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unwrap<T>(payload: unknown): T {
  if (payload !== null && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** attempt);
}
