/**
 * 发布门禁（仓库级，和「人类使用场景」分开跑）：
 * 每条都是仓库里已有的、可复跑的命令；这里只负责按顺序执行、保留原始输出、统一判定。
 *
 * 纪律：
 * - 不新增「人工看一眼」的检查；
 * - 命令缺失/超时/非 0 一律红灯，不静默跳过；
 * - 输出只保留尾部，完整日志落 `scenarios/out/logs/`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, tailLines } from "./util.mjs";

export function gateDefinitions({ version }) {
  return [
    {
      id: "G01",
      title: "ABI 契约闸门（46/34/35/18）",
      command: "node",
      args: ["tools/validate-abi.mjs"],
      timeoutMs: 120_000,
    },
    {
      id: "G02",
      title: "schema 与设计真源逐字节一致",
      command: "node",
      args: ["tools/sync-schema.mjs", "--check"],
      timeoutMs: 120_000,
    },
    {
      id: "G03",
      title: "文档结构 / 计数 / 链接闸门",
      command: "python3",
      args: ["tools/check_docs.py", "all"],
      timeoutMs: 180_000,
    },
    {
      id: "G04",
      title: "公开仓泄漏扫描",
      command: "node",
      args: ["tools/leak-scan.mjs"],
      timeoutMs: 120_000,
    },
    {
      id: "G05",
      title: "GitHub 工程配置校验",
      command: "node",
      args: [".github/scripts/verify-github-config.mjs"],
      timeoutMs: 120_000,
    },
    {
      id: "G06",
      title: "GitHub 配置校验器自检（变异副本必须变红）",
      command: "node",
      args: [".github/scripts/verify-github-config.mjs", "--self-test"],
      timeoutMs: 120_000,
    },
    {
      id: "G07",
      title: "严格 TypeScript 类型检查",
      command: "pnpm",
      args: ["-s", "typecheck"],
      timeoutMs: 300_000,
    },
    {
      id: "G08",
      title: "单元 / 契约 / 回放测试（vitest）",
      command: "pnpm",
      args: ["-s", "test"],
      timeoutMs: 600_000,
      note: "vitest.config.mjs 只收集 tests/**/*.test.ts；orchestrator/ 由 node:test 单独运行。",
    },
    {
      id: "G09",
      title: "离线 PR 演练（worktree + 零写入）",
      command: "node",
      args: ["e2e/pr-scenario.mjs"],
      timeoutMs: 180_000,
    },
    {
      id: "G10",
      title: "构建可安装插件包",
      command: "pnpm",
      args: ["-s", "build:plugin"],
      timeoutMs: 300_000,
    },
    {
      id: "G11",
      title: "版本一致性（tag / package.json / CHANGELOG）",
      command: "node",
      args: [".github/scripts/release-notes.mjs", "--tag", `v${version}`, "--package", "package.json", "--check"],
      timeoutMs: 60_000,
    },
  ];
}

export async function runGates({
  cwd,
  version,
  logDir,
  only = null,
  extraGates = [],
  onStart = () => {},
  onDone = () => {},
}) {
  await mkdir(logDir, { recursive: true });
  const results = [];
  for (const gate of [...gateDefinitions({ version }), ...extraGates]) {
    if (only !== null && !only.includes(gate.id)) continue;
    onStart(gate);
    const result = await runCommand({
      command: gate.command,
      args: gate.args,
      cwd,
      env: gate.env,
      timeoutMs: gate.timeoutMs,
    });
    const passed = result.code === 0 && !result.timedOut && result.error === undefined;
    const record = {
      id: gate.id,
      title: gate.title,
      command: result.command,
      status: passed ? "passed" : "failed",
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      note: gate.note ?? "",
      outputTail: tailLines(`${result.stdout}\n${result.stderr}`, 30),
      error: result.error === undefined ? null : String(result.error?.message ?? result.error),
    };
    const logPath = join(logDir, `${gate.id}.log`);
    await writeFile(
      logPath,
      `$ ${result.command}\nexit=${String(result.code)} timedOut=${String(result.timedOut)}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
      "utf8",
    );
    record.log = logPath;
    results.push(record);
    onDone(record);
  }
  return results;
}
