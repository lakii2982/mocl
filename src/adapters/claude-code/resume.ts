/**
 * claude-code 续接（施工 C5）：`resume` / `forkSession` 选项构造 + 冷恢复前的**只读探测**。
 *
 * 设计依据：docs/adapters/claude-code.md §4（`persistSession:true` 是前提；`--resume` 到 SDK 的
 * 映射只有 `Options.resume`，不允许手拼 CLI 参数）。
 *
 * 探测纪律：只读 `~/.claude/projects/**\/<sessionId>.jsonl` 的**存在性**，不读内容、不打印、
 * 不做路径穿越（sessionId 必须匹配安全字符集）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { adapterError, type AdapterError } from "./errors.ts";

/** 会话 id 安全集（UUID 形态 + 允许字母数字连字符；阻断 `../` 穿越）。 */
const SAFE_SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,127}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId) && !sessionId.includes("..") && !sessionId.includes("/");
}

/** 会话文件根目录（`CLAUDE_CONFIG_DIR` 可覆盖；默认 `~/.claude/projects`）。 */
export function projectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["CLAUDE_CONFIG_DIR"];
  const base = configDir !== undefined && configDir.length > 0 ? configDir : join(homedir(), ".claude");
  return join(base, "projects");
}

/** 只读探测接口（测试注入；默认实现见 `createFileSessionProber`）。 */
export interface SessionProber {
  exists(sessionId: string): Promise<boolean>;
}

export interface SessionProberOptions {
  readonly projectsDir?: string;
  /** 注入 readdir（Node 默认 fs.promises.readdir，测试可替换）。 */
  readonly readdir?: (path: string, options: { recursive: true }) => Promise<readonly string[]>;
}

/**
 * 文件系统探测器：`projects/<slug>/<sessionId>.jsonl` 存在即视为可续接。
 * 只列目录/文件名，不打开文件（零隐私读入）。
 */
export function createFileSessionProber(options: SessionProberOptions = {}): SessionProber {
  const root = options.projectsDir ?? projectsDir();
  const readdir = options.readdir;
  return {
    async exists(sessionId: string): Promise<boolean> {
      if (!isSafeSessionId(sessionId)) return false;
      const target = `${sessionId}.jsonl`;
      try {
        if (readdir !== undefined) {
          const entries = await readdir(root, { recursive: true });
          return entries.some((entry) => entry === target || entry.endsWith(`/${target}`));
        }
        const { readdir: nodeReaddir } = await import("node:fs/promises");
        const entries = await nodeReaddir(root, { recursive: true });
        return entries.some((entry) => entry === target || entry.endsWith(`/${target}`));
      } catch {
        // 目录不存在 = 会话不存在（不视为故障）。
        return false;
      }
    },
  };
}

/** 续接选项：`resume` 必须走 SDK `Options`（SDK 内部拼 `--resume=<id>`）。 */
export interface ResumeOptionsInput {
  readonly sessionId: string;
  readonly forkSession?: boolean;
  readonly resumeSessionAt?: string;
}

export function buildResumeOptions(input: ResumeOptionsInput): Record<string, unknown> {
  if (!isSafeSessionId(input.sessionId)) {
    throw adapterError("protocol.invalid-params", { message: `unsafe session id: ${input.sessionId.slice(0, 64)}` });
  }
  return {
    resume: input.sessionId,
    ...(input.forkSession === true ? { forkSession: true } : {}),
    ...(input.resumeSessionAt === undefined ? {} : { resumeSessionAt: input.resumeSessionAt }),
  };
}

/**
 * 区分"会话不存在"与"续接失败"：
 * - 探测不到会话文件 → `session.not-found`（上层按 R-1 reseed，而不是重试）；
 * - 探测到但 SDK/CLI 报错 → `session.resume-failed`（可降级 fork/reseed）。
 */
export function classifyResumeFailure(probed: boolean, cause: unknown): AdapterError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!probed) {
    return adapterError("session.not-found", {
      message: `claude session not found: ${message}`,
      details: { kind: "session.not-found", phase: "probe" },
    });
  }
  return adapterError("session.resume-failed", {
    message,
    details: { kind: "session.resume-failed", phase: "resume" },
  });
}
