/**
 * 四后端适配器装配（C8）：按配置实例化 L1 句柄。
 *
 * 纪律：
 * - 只装配**启用**的后端（默认全关，fail-closed）；
 * - 并发容量一律注入同一 `RuntimeConfigProvider`（D-016），不在本文件读取固定值；
 * - 真实适配器的构造不发起网络/进程（懒连接），测试可用 `adapters` 注入假件。
 */
import type { BackendAdapter } from "../abi/adapter.ts";
import { moclError } from "../broker/errors.ts";
import type { RuntimeConfigProvider } from "../broker/concurrency.ts";
import { createClaudeCodeAdapter } from "../adapters/claude-code/index.ts";
import { createCodexAdapter } from "../adapters/codex/index.ts";
import { KimiAdapter } from "../adapters/kimi/index.ts";
import { AcpClient, spawnAcpTransport, type AcpApi } from "../adapters/opencode/acp-client.ts";
import type { AcpSessionUpdateParams } from "../adapters/opencode/types.ts";
import {
  OpenCodeHttpClient,
  resolveHttpConfig,
  type OpenCodeHttpApi,
} from "../adapters/opencode/http-client.ts";
import { OpenCodeAdapter } from "../adapters/opencode/index.ts";
import type { BackendConfig, ConfigBackendId } from "./config.ts";

/**
 * Test-only seams for the opencode adapter. Production callers pass nothing:
 * clients are derived from the merged environment (and, for HTTP, from the
 * opencode `service.json` password file) with a fail-closed error when missing.
 */
export interface BackendAdapterDeps {
  readonly opencodeHttp?: OpenCodeHttpApi;
  readonly opencodeAcp?: AcpApi;
  /** Overrides `{...process.env, ...config.env}` for credential resolution. */
  readonly opencodeEnv?: Readonly<Record<string, string | undefined>>;
  /** Overrides the home directory used to look up opencode's `service.json`. */
  readonly opencodeHome?: string;
}

function envOf(config: BackendConfig): NodeJS.ProcessEnv | undefined {
  const entries = Object.entries(config.env);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as NodeJS.ProcessEnv);
}

/** 合并进程环境与 per-backend env（后者优先）。 */
function mergedEnv(config: BackendConfig): Record<string, string | undefined> {
  return { ...process.env, ...config.env };
}

/**
 * opencode HTTP 客户端：显式注入优先；否则从环境 + `service.json` 解析。
 * 配置缺失 → ABI `auth.missing-credential`（fail-closed，不是 TypeError）。
 */
function resolveOpenCodeHttp(config: BackendConfig, deps: BackendAdapterDeps): OpenCodeHttpApi {
  if (deps.opencodeHttp !== undefined) return deps.opencodeHttp;
  const resolved = resolveHttpConfig(
    deps.opencodeEnv ?? mergedEnv(config),
    deps.opencodeHome,
  );
  if (resolved === undefined) {
    throw moclError("auth.missing-credential", {
      message:
        "opencode http channel requires MOCL_OPENCODE_URL and MOCL_OPENCODE_PASSWORD (or an opencode service.json password)",
    });
  }
  return new OpenCodeHttpClient(resolved);
}

/**
 * opencode ACP 客户端：显式注入优先；否则返回**懒创建**客户端。
 *
 * 关键约束（issue #8 AC-4 / G5 打回 B1）：装配阶段**不得 spawn 子进程**。
 * `OpenCodeAdapter` 构造器会同步调用 `onUpdate()` 注册事件处理器，因此这里
 * 先把 handler 缓存；只有真正发起会话操作（open/resume/…）时才创建客户端并
 * 一次性注册缓存 handler。`terminate()` 在从未创建客户端时是纯 no-op。
 */
class LazyAcpClient implements AcpApi {
  readonly #config: BackendConfig;
  #client: AcpClient | undefined;
  #pendingUpdateHandlers: ((params: AcpSessionUpdateParams) => void)[] = [];

  constructor(config: BackendConfig) {
    this.#config = config;
  }

  #ensure(): AcpClient {
    if (this.#client !== undefined) return this.#client;
    const config = this.#config;
    const client = new AcpClient({
      transport: spawnAcpTransport({
        ...(config.binaryPath === null ? {} : { binaryPath: config.binaryPath }),
        cwd: process.cwd(),
        env: config.env,
      }),
      allowWrite: config.permissionMode !== "read-only",
    });
    for (const handler of this.#pendingUpdateHandlers) client.onUpdate(handler);
    this.#pendingUpdateHandlers = [];
    this.#client = client;
    return client;
  }

  initialize(clientInfo: Parameters<AcpApi["initialize"]>[0]): ReturnType<AcpApi["initialize"]> {
    return this.#ensure().initialize(clientInfo);
  }

  newSession(request: Parameters<AcpApi["newSession"]>[0]): ReturnType<AcpApi["newSession"]> {
    return this.#ensure().newSession(request);
  }

  loadSession(request: Parameters<AcpApi["loadSession"]>[0]): ReturnType<AcpApi["loadSession"]> {
    return this.#ensure().loadSession(request);
  }

  prompt(sessionId: string, text: string): ReturnType<AcpApi["prompt"]> {
    return this.#ensure().prompt(sessionId, text);
  }

  setConfigOption(sessionId: string, configId: string, value: string): ReturnType<AcpApi["setConfigOption"]> {
    return this.#ensure().setConfigOption(sessionId, configId, value);
  }

  setMode(sessionId: string, modeId: string): ReturnType<AcpApi["setMode"]> {
    return this.#ensure().setMode(sessionId, modeId);
  }

  fork(sessionId: string, cwd: string): ReturnType<AcpApi["fork"]> {
    return this.#ensure().fork(sessionId, cwd);
  }

  listSessions(cwd: string): ReturnType<AcpApi["listSessions"]> {
    return this.#ensure().listSessions(cwd);
  }

  onUpdate(handler: (params: AcpSessionUpdateParams) => void): void {
    if (this.#client !== undefined) this.#client.onUpdate(handler);
    else this.#pendingUpdateHandlers.push(handler);
  }

  async terminate(): Promise<void> {
    // Never spawned → nothing to terminate (assembly-only lifecycle).
    if (this.#client === undefined) return;
    await this.#client.terminate();
  }
}

function resolveOpenCodeAcp(config: BackendConfig, deps: BackendAdapterDeps): AcpApi {
  if (deps.opencodeAcp !== undefined) return deps.opencodeAcp;
  return new LazyAcpClient(config);
}

/** 按 backend 配置创建真实适配器（仅启用后调用）。 */
export function createBackendAdapter(
  backendId: ConfigBackendId,
  config: BackendConfig,
  runtime: RuntimeConfigProvider,
  deps: BackendAdapterDeps = {},
): BackendAdapter {
  switch (backendId) {
    case "codex":
      return createCodexAdapter({
        runtime,
        defaultModel: config.model,
        ...(config.binaryPath === null ? {} : { binaryPath: config.binaryPath }),
        ...(envOf(config) === undefined ? {} : { env: envOf(config) }),
      });
    case "claude-code":
      return createClaudeCodeAdapter({
        runtime,
        model: config.model,
        ...(config.binaryPath === null ? {} : { claudeCodeExecutable: config.binaryPath }),
        ...(envOf(config) === undefined ? {} : { env: envOf(config) }),
      });
    case "kimi":
      return new KimiAdapter({
        transport: config.channel === "cli" ? "cli" : "acp",
        runtime,
        initialModel: config.model,
        allowWrite: config.permissionMode !== "read-only",
      });
    case "opencode": {
      const transport = config.channel === "acp" ? "acp" : "http";
      return new OpenCodeAdapter({
        transport,
        runtime,
        initialModel: config.model,
        modelPolicy: undefined,
        ...(transport === "http"
          ? { http: resolveOpenCodeHttp(config, deps) }
          : { acp: resolveOpenCodeAcp(config, deps) }),
      });
    }
    default: {
      const exhaustive: never = backendId;
      throw new Error(`unknown backend: ${String(exhaustive)}`);
    }
  }
}
