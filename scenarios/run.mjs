#!/usr/bin/env node
/**
 * MOCL 发布前场景回归（人类使用路径 + 发布门禁）。
 *
 * 用法：
 *   node scenarios/run.mjs                       # 全部（离线，默认）
 *   node scenarios/run.mjs --scope=usage         # 只跑人类使用场景
 *   node scenarios/run.mjs --scope=repo          # 只跑发布门禁 + 一致性场景
 *   node scenarios/run.mjs --only=S02,S03        # 指定场景/门禁
 *   node scenarios/run.mjs --strict-known        # 已知缺口也阻塞（发布签收推荐）
 *   node scenarios/run.mjs --live                # 额外跑真实后端 live smoke（耗额度，opt-in）
 *   node scenarios/run.mjs --list                # 列出场景与门禁
 *
 * 退出码：0 = 通过；1 = 有场景/门禁失败（或 --strict-known 下有已知缺口）；2 = 用法/环境错误。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { CaseContext } from "./lib/harness.mjs";
import { gateDefinitions, runGates } from "./lib/repo-gates.mjs";
import {
  aggregateKnownIssues,
  buildReport,
  exitCodeOf,
  printSummary,
  writeReports,
} from "./lib/report.mjs";
import { runCommand, tailLines, walkTree } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CASES_DIR = join(HERE, "cases");
const OUT_DIR = join(HERE, "out");
const TMP_ROOT = join(HERE, "tmp");
const KNOWN_ISSUES_PATH = join(HERE, "known-issues.json");
const LIVE_TESTS = [
  "tests/adapters/codex/live-smoke.test.ts",
  "tests/adapters/claude-code/live-smoke.test.ts",
  "tests/adapters/kimi/live.test.ts",
  "tests/adapters/opencode/live.test.ts",
];

const USAGE = `MOCL 发布前场景回归

用法：
  node scenarios/run.mjs [options]

常用：
  --scope=all|usage|repo   运行范围（默认 all）
  --only=S02,G03           只跑指定场景/门禁（逗号分隔）
  --strict-known           已知缺口也视为失败（发布签收推荐）
  --live                   额外跑真实后端 live smoke（需要本机凭据/服务）
  --list                   列出场景与门禁
  --json                   只输出 JSON 报告
  --keep                   保留 scenarios/tmp 下的临时工作区
  --fail-fast              首个场景失败即停止（仍会写报告）

退出码：0 通过；1 失败；2 用法/环境错误。`;

function parseArgs(argv) {
  const options = {
    scope: "all",
    only: null,
    strictKnown: false,
    live: process.env.MOCL_LIVE === "1",
    list: false,
    json: false,
    keep: false,
    failFast: false,
  };
  const takeValue = (index, token) => {
    if (token.includes("=")) return token.slice(token.indexOf("=") + 1);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (token.startsWith("--scope")) {
      const value = takeValue(index, token);
      if (!token.includes("=")) index += 1;
      if (!["all", "usage", "repo"].includes(value)) throw new Error(`--scope 只能是 all|usage|repo（收到 ${String(value)}）`);
      options.scope = value;
    } else if (token.startsWith("--only")) {
      const value = takeValue(index, token);
      if (!token.includes("=")) index += 1;
      options.only = String(value)
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
    } else if (token === "--strict-known") options.strictKnown = true;
    else if (token === "--live") options.live = true;
    else if (token === "--list") options.list = true;
    else if (token === "--json") options.json = true;
    else if (token === "--keep") options.keep = true;
    else if (token === "--fail-fast") options.failFast = true;
    else throw new Error(`未知参数：${token}`);
  }
  return options;
}

async function loadCases() {
  const files = (await readdir(CASES_DIR)).filter((name) => name.endsWith(".mjs")).sort();
  const cases = [];
  for (const file of files) {
    const module = await import(new URL(`./cases/${file}`, import.meta.url).href);
    const definition = module.default;
    if (definition === undefined || typeof definition.run !== "function" || typeof definition.id !== "string") {
      throw new Error(`场景文件格式非法：cases/${file}`);
    }
    cases.push(definition);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadKnownIssues() {
  const parsed = JSON.parse(await readFile(KNOWN_ISSUES_PATH, "utf8"));
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const ids = new Set();
  for (const issue of issues) {
    if (typeof issue.id !== "string" || ids.has(issue.id)) throw new Error(`known-issues.json 条目非法/重复：${String(issue.id)}`);
    ids.add(issue.id);
  }
  return { raw: parsed, map: new Map(issues.map((issue) => [issue.id, issue])) };
}

async function repositoryMeta() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const commitResult = await runCommand({ command: "git", args: ["rev-parse", "--short", "HEAD"], cwd: REPO_ROOT, timeoutMs: 10_000 });
  const statusResult = await runCommand({ command: "git", args: ["status", "--porcelain"], cwd: REPO_ROOT, timeoutMs: 10_000 });
  return {
    repository: {
      name: pkg.name,
      version: pkg.version,
      commit: commitResult.stdout.trim() || "unknown",
      dirty: statusResult.stdout.trim().length > 0,
      dirtyFiles: statusResult.stdout.trim().split("\n").filter(Boolean).length,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      ci: process.env.CI === "true",
      live: process.env.MOCL_LIVE === "1",
    },
  };
}

async function scanCaseSecrets(ctx, logText) {
  const hits = [];
  if (ctx.secrets.length === 0) return hits;
  const files = await walkTree(ctx.dir);
  const contents = [{ name: "log", text: logText }];
  for (const file of files) {
    try {
      const text = await readFile(join(ctx.dir, file.path), "utf8");
      contents.push({ name: file.path, text });
    } catch {
      // 二进制或不可读：跳过
    }
  }
  for (const secret of ctx.secrets) {
    for (const item of contents) {
      if (item.text.includes(secret)) hits.push(`${item.name} 含登记密钥`);
    }
  }
  return hits;
}

async function runCase(definition, { knownIssues, logDir, timeoutMs }) {
  const dir = join(TMP_ROOT, definition.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const ctx = new CaseContext({
    def: definition,
    dir,
    outDir: OUT_DIR,
    repoRoot: REPO_ROOT,
    knownIssues,
  });

  console.log("");
  console.log(`${definition.id} ▶ ${definition.title}  (${definition.persona})`);
  console.log(`     目标：${definition.goal}`);

  const captured = [];
  const original = { log: console.log, error: console.error };
  const capture = (...args) => {
    const line = format(...args);
    captured.push(line);
    original.log(line);
  };
  console.log = capture;
  console.error = capture;

  let timedOut = false;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`场景超时（>${timeoutMs}ms）`));
      }, timeoutMs);
    });
    await Promise.race([definition.run(ctx), timeout]);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    ctx.assert("scenario:no-throw", false, tailLines(error instanceof Error ? error.stack ?? message : message, 12));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    console.log = original.log;
    console.error = original.error;
  }

  const logPath = join(logDir, `${definition.id}.log`);
  const logTextBeforeScan = captured.join("\n");
  const secretHits = await scanCaseSecrets(ctx, logTextBeforeScan);
  for (const hit of secretHits) ctx.assert("secret:no-leak-in-artifacts", false, hit);

  const result = ctx.result();
  result.timedOut = timedOut;
  result.log = relative(REPO_ROOT, logPath);
  await mkdir(logDir, { recursive: true });
  await writeFile(
    logPath,
    `${definition.id} ${definition.title}\nstatus=${result.status} exitAssertions=${result.summary.failed}\n\n${captured.join("\n")}\n`,
    "utf8",
  );
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  const cases = await loadCases();
  const { raw: baseline, map: knownIssues } = await loadKnownIssues();
  const meta = await repositoryMeta();
  const version = meta.repository.version;

  const scopeMatches = (definition) =>
    options.scope === "all" ? true : options.scope === "repo" ? definition.scope === "repo" : definition.scope !== "repo";
  const onlyMatches = (id) => options.only === null || options.only.includes(id);

  const selectedCases = cases.filter((definition) => scopeMatches(definition) && onlyMatches(definition.id));

  const liveGate = options.live
    ? [
        {
          id: "GL1",
          title: "真实后端 live smoke（opt-in，可能消耗额度）",
          command: "pnpm",
          args: ["exec", "vitest", "run", ...LIVE_TESTS],
          env: { MOCL_LIVE: "1" },
          timeoutMs: 900_000,
          note: "测试自身会把无凭据/额度不足标为 skipped；请人工核对输出中的 skipped 行。",
        },
      ]
    : [];
  const allGateDefinitions = [...gateDefinitions({ version }), ...liveGate];
  const selectedGates = allGateDefinitions.filter((gate) => onlyMatches(gate.id));
  const runGatesEnabled = options.scope !== "usage" && selectedGates.length > 0;

  if (options.list) {
    console.log(`MOCL v${version} 场景（scope: usage=人类路径, repo=发布门禁）`);
    for (const definition of cases) console.log(`  ${definition.id} [${definition.scope}] ${definition.title}`);
    console.log("");
    console.log("发布门禁");
    for (const gate of allGateDefinitions) console.log(`  ${gate.id} ${gate.title} — ${gate.command} ${gate.args.join(" ")}`);
    return;
  }

  console.log("");
  console.log("MOCL 发布前场景回归");
  console.log(
    `${meta.repository.name} v${version} @ ${meta.repository.commit} · mode=${options.live ? "live" : "offline"} · scope=${options.scope}`,
  );
  console.log(`Node ${process.version} · ${process.platform} ${process.arch}${meta.repository.dirty ? ` · 工作树有 ${meta.repository.dirtyFiles} 个未提交变更` : ""}`);
  console.log("─".repeat(72));

  await mkdir(OUT_DIR, { recursive: true });
  await rm(join(OUT_DIR, "logs"), { recursive: true, force: true });
  await rm(join(OUT_DIR, "artifacts"), { recursive: true, force: true });
  await mkdir(join(OUT_DIR, "logs"), { recursive: true });
  await mkdir(join(OUT_DIR, "artifacts"), { recursive: true });
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });

  const caseResults = [];
  const caseTimeoutMs = 90_000;
  for (const definition of selectedCases) {
    const result = await runCase(definition, {
      knownIssues,
      logDir: join(OUT_DIR, "logs"),
      timeoutMs: caseTimeoutMs,
    });
    caseResults.push(result);
    if (result.status === "failed" && options.failFast) {
      console.log("");
      console.log("fail-fast：已停止后续场景（报告仍会落盘）");
      break;
    }
  }

  let gateResults = [];
  if (runGatesEnabled) {
    console.log("");
    console.log("发布门禁");
    gateResults = await runGates({
      cwd: REPO_ROOT,
      version,
      logDir: join(OUT_DIR, "logs"),
      only: options.only,
      extraGates: liveGate,
      onStart(gate) {
        console.log(`${gate.id} ▶ ${gate.title}`);
      },
      onDone(gate) {
        console.log(`${gate.id} ${gate.status === "passed" ? "PASS" : "FAIL"} (${gate.durationMs}ms)`);
      },
    });
  }

  const aggregated = aggregateKnownIssues(baseline, caseResults);
  const report = buildReport({
    meta,
    caseResults,
    gateResults,
    knownIssues: aggregated,
    mode: options.live ? "live" : "offline",
    scope: options.scope,
    strictKnown: options.strictKnown,
  });

  const secrets = caseResults.flatMap((result) => result.secrets ?? []);
  const paths = await writeReports({ outDir: OUT_DIR, report, secrets });

  printSummary(report, { json: options.json, secrets });
  if (!options.json) {
    console.log("");
    if (report.repository.dirty) console.log(`提示：工作树不干净（${report.repository.dirtyFiles} 项未提交），正式发布应从 tag/干净工作树跑。`);
    if (options.only === null && options.scope === "all" && aggregated.some((issue) => !issue.observed)) {
      const untouched = aggregated.filter((issue) => !issue.observed).map((issue) => issue.id);
      console.log(`提示：以下基线条目本次未复现（可能是未跑到的场景，或缺口已修）：${untouched.join(", ")}`);
    }
    console.log(`报告：${paths.json}`);
    console.log(`签收单：${paths.markdown}`);
    if (options.strictKnown && report.summary.knownIssues.observed > 0) {
      console.log(`严格模式：仍有 ${report.summary.knownIssues.observed} 个已知缺口，发布判定为不通过。`);
    }
  }

  if (!options.keep) await rm(TMP_ROOT, { recursive: true, force: true });
  process.exit(exitCodeOf(report));
}

main().catch((error) => {
  console.error("场景套件运行失败：", error);
  process.exit(2);
});
