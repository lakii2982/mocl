/**
 * kimi CLI 兜底通道：`kimi -p <text> --output-format stream-json`（docs/adapters/kimi.md §0.2/§2.4/§7.5）。
 *
 * 仅在 ACP 不可用（spawn 失败 / 反向 handler 无法注册 / 握手断言失败）时启用，能力降级为
 * `streaming=emulated`（**消息级**，无 token 增量，kimi.md:332）。
 *
 * 三条与 ACP 通道不同的硬约束：
 * 1. **`-p` 与 `--auto`/`-y`/`--plan` 互斥**（rc=1，kimi.md:106-115）→ 本文件**从不**拼模式旗标，
 *    并在 `buildPromptArgs()` 里用 `assertNoPromptModeFlags()` 把这条约束编码成断言；
 * 2. 权限档位只能由 `config.toml: default_permission_mode` 决定 → 由 `permissions.cliFallbackAllowed()` 判定；
 * 3. 续接靠 `-S <sessionId>`（`-r` 亦可，`session.resume_hint` 里给出的就是 `kimi -r`，kimi.md:314）；
 *    每次 turn 都是**新进程**（进程即生命周期）。
 */
import { spawn } from "node:child_process";
import { moclError } from "../../broker/errors.ts";
import { assertNoPromptModeFlags } from "./permissions.ts";
import type { KimiCliEvent } from "./types.ts";

/** 一次 CLI turn 的原始结果。 */
export interface PromptProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutLines: readonly string[];
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** 可注入的进程执行器（测试用假 runner，零额度）。 */
export interface PromptRunner {
  run(
    argv: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: Readonly<Record<string, string | undefined>> },
  ): Promise<PromptProcessResult>;
}

/** 构造 `-p` 参数（纯函数，可单测；**唯一**允许拼参数的地方）。 */
export function buildPromptArgs(input: {
  readonly text: string;
  readonly sessionId?: string | null;
  readonly model?: string | null;
}): string[] {
  if (input.text.trim().length === 0) {
    throw moclError("protocol.invalid-params", { message: "kimi prompt text must not be empty" });
  }
  const argv = ["-p", input.text, "--output-format", "stream-json"];
  if (input.sessionId !== null && input.sessionId !== undefined && input.sessionId.length > 0) {
    argv.push("-S", input.sessionId);
  }
  if (input.model !== null && input.model !== undefined && input.model.length > 0) {
    argv.push("-m", input.model);
  }
  // 编译期/运行期双重防线：任何模式旗标都会让 kimi 直接 rc=1 拒绝。
  assertNoPromptModeFlags(argv);
  return argv;
}

/** 解析 stream-json 单行（坏行 → null，由调用方计数丢弃）。 */
export function parseCliLine(line: string): KimiCliEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as KimiCliEvent;
  } catch {
    return null;
  }
}

/** 从事件流里提取后端会话 id（`session.resume_hint.session_id`，kimi.md:314）。 */
export function extractSessionId(events: readonly KimiCliEvent[]): string | null {
  for (const event of events) {
    if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
      return event.session_id;
    }
  }
  return null;
}

export interface KimiPromptClientOptions {
  readonly runner?: PromptRunner;
  readonly binaryPath?: string;
  /** 单轮超时（CLI 通道无内置超时；默认 1_800_000，与 ABI M2 一致）。 */
  readonly timeoutMs?: number;
}

/** CLI 兜底通道客户端（每次 turn 一个新进程）。 */
export class KimiPromptClient {
  readonly #runner: PromptRunner;
  readonly #timeoutMs: number;

  constructor(options: KimiPromptClientOptions = {}) {
    this.#runner = options.runner ?? new SpawnPromptRunner(options.binaryPath);
    this.#timeoutMs = options.timeoutMs ?? 1_800_000;
  }

  /** 执行一轮；返回解析后的事件（未过滤）与后端会话 id。 */
  async turn(input: {
    readonly text: string;
    readonly cwd: string;
    readonly sessionId?: string | null;
    readonly model?: string | null;
    readonly timeoutMs?: number;
  }): Promise<{
    readonly argv: readonly string[];
    readonly result: PromptProcessResult;
    readonly parsed: readonly KimiCliEvent[];
    readonly sessionId: string | null;
  }> {
    const argv = buildPromptArgs({
      text: input.text,
      sessionId: input.sessionId ?? null,
      model: input.model ?? null,
    });
    const result = await this.#runner.run(argv, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? this.#timeoutMs,
    });
    const parsed: KimiCliEvent[] = [];
    for (const line of result.stdoutLines) {
      const event = parseCliLine(line);
      if (event !== null) parsed.push(event);
    }
    return { argv, result, parsed, sessionId: extractSessionId(parsed) };
  }
}

/** 真实执行器：spawn `kimi` + 逐行收集 stdout。 */
export class SpawnPromptRunner implements PromptRunner {
  readonly #binaryPath: string | undefined;

  constructor(binaryPath?: string) {
    this.#binaryPath = binaryPath;
  }

  async run(
    argv: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: Readonly<Record<string, string | undefined>> },
  ): Promise<PromptProcessResult> {
    const binary = this.#binaryPath ?? process.env["KIMI_BIN"] ?? `${process.env["HOME"] ?? ""}/.kimi-code/bin/kimi`;
    return await new Promise<PromptProcessResult>((resolvePromise) => {
      const child = spawn(binary, [...argv], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, ...options.env, NO_COLOR: "1" },
      });
      const stdoutLines: string[] = [];
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }, options.timeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding("utf8");
      let buffer = "";
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          stdoutLines.push(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < 8_192) stderr += chunk;
      });
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        if (buffer.trim().length > 0) stdoutLines.push(buffer);
        resolvePromise({ exitCode: code, signal, stdoutLines, stderr, timedOut });
      };
      child.on("error", () => finish(null, null));
      child.on("exit", (code, signal) => finish(code, signal));
    });
  }
}
