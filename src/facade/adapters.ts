/**
 * 四后端适配器装配（C8）：按配置实例化 L1 句柄。
 *
 * 纪律：
 * - 只装配**启用**的后端（默认全关，fail-closed）；
 * - 并发容量一律注入同一 `RuntimeConfigProvider`（D-016），不在本文件读取固定值；
 * - 真实适配器的构造不发起网络/进程（懒连接），测试可用 `adapters` 注入假件。
 */
import type { BackendAdapter } from "../abi/adapter.ts";
import type { RuntimeConfigProvider } from "../broker/concurrency.ts";
import { createClaudeCodeAdapter } from "../adapters/claude-code/index.ts";
import { createCodexAdapter } from "../adapters/codex/index.ts";
import { KimiAdapter } from "../adapters/kimi/index.ts";
import { OpenCodeAdapter } from "../adapters/opencode/index.ts";
import type { BackendConfig, ConfigBackendId } from "./config.ts";

function envOf(config: BackendConfig): NodeJS.ProcessEnv | undefined {
  const entries = Object.entries(config.env);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as NodeJS.ProcessEnv);
}

/** 按 backend 配置创建真实适配器（仅启用后调用）。 */
export function createBackendAdapter(
  backendId: ConfigBackendId,
  config: BackendConfig,
  runtime: RuntimeConfigProvider,
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
    case "opencode":
      return new OpenCodeAdapter({
        transport: config.channel === "acp" ? "acp" : "http",
        runtime,
        initialModel: config.model,
        modelPolicy: undefined,
      });
    default: {
      const exhaustive: never = backendId;
      throw new Error(`unknown backend: ${String(exhaustive)}`);
    }
  }
}
