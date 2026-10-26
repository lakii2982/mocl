#!/usr/bin/env node
/**
 * leak-scan.mjs — 公开仓泄漏门禁（发布前必须 exit 0）。
 *
 * 扫描范围：`git ls-files` 返回的**全部已跟踪文件**（docs/、repro/ 不跳过）。
 * 检查四类泄漏：
 *   A. personal-path   个人绝对路径（/Users/<name>、/home/<name>；占位符 /Users/... 与 /Users/<you> 放行）
 *   B. credential      GitHub token / sk- 风格密钥 / AWS key / Bearer token / 私钥块
 *   C. internal-ref    内部台账引用（.astra、HANDOFF、STATUS.md、INSTALL-MOCL、config.local、VERIFY.md）
 *   D. internal-file   内部台账文件本身被 git 跟踪（路径级检查）
 *
 * 白名单：ALLOWLIST 中逐条 `{file, rule, reason}`；只按「文件 + 规则」放行，绝不整目录跳过。
 * 命中凭据时只打印前缀（不打印完整值）。
 *
 * 用法：node tools/leak-scan.mjs [--verbose]
 * 退出码：0 = 干净；1 = 有命中；2 = 无法取得 git 跟踪文件列表（环境错误）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");

const RULES = [
  {
    id: "personal-path",
    why: "个人绝对路径",
    re: /\/(?:Users|home)\/[A-Za-z][^\s`"'()<>[\]{}]*/g,
  },
  {
    id: "credential",
    why: "疑似凭据",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
  },
  {
    id: "internal-ref",
    why: "内部台账引用",
    re: /\.astra\b|\bHANDOFF\b|\bSTATUS\.md\b|\bINSTALL-MOCL\b|\bconfig\.local\b|\bVERIFY\.md\b/g,
  },
];

// 内部台账文件名（若被 git 跟踪，说明内部文件混入公开仓）
const INTERNAL_PATH = /(^|\/)\.astra(\/|$)|(^|\/)HANDOFF\.md$|(^|\/)STATUS\.md$|(^|\/)INSTALL-MOCL(\.md)?$|(^|\/)config\.local(\.[A-Za-z0-9]+)?$|(^|\/)VERIFY\.md$/;

// 逐条白名单：仅「文件 + 规则」，每条给出理由（禁止整目录跳过）
const ALLOWLIST = [
  {
    file: ".gitignore",
    rule: "internal-ref",
    reason: "忽略规则必须写出它要排除的内部文件名，本身不是台账内容",
  },
  {
    file: "tools/build-plugin-package.mjs",
    rule: "internal-ref",
    reason: "构建脚本按本地配置文件名解析 configPath（config.local.json 已被 .gitignore 排除）",
  },
  {
    file: "tests/adapters/claude-code/permissions.test.ts",
    rule: "personal-path",
    reason: "测试桩 HOME=/home/u 是假值（跨平台测试占位），不是真实用户目录",
  },
  {
    file: "tests/adapters/claude-code/resume.test.ts",
    rule: "personal-path",
    reason: "测试桩 HOME=/home/u 是假值（跨平台测试占位），不是真实用户目录",
  },
  {
    file: "tools/leak-scan.mjs",
    rule: "internal-ref",
    reason: "扫描器自身的规则定义必须包含被禁止的字面量",
  },
  {
    file: "tools/leak-scan.mjs",
    rule: "credential",
    reason: "扫描器自身的凭据正则必须包含 token 前缀字面量",
  },
];

function listTrackedFiles() {
  const r = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`[leak-scan] ERROR: git ls-files 失败（需要在 git 工作树内运行）`);
    if (r.stderr) console.error(String(r.stderr).trim());
    process.exit(2);
  }
  return r.stdout.split("\0").filter(Boolean).sort();
}

function isAllowed(ruleId, fileRel) {
  return ALLOWLIST.some((a) => a.file === fileRel && a.rule === ruleId);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function mask(ruleId, value) {
  if (ruleId !== "credential") return value;
  const visible = value.slice(0, Math.min(6, value.length));
  return `${visible}…<redacted len=${value.length}>`;
}

function selfTest() {
  // 用运行时拼接构造样例，避免样例字面量本身被扫描器命中
  const ghp = "gh" + "p_" + "a".repeat(36);
  const sk = "sk" + "-" + "b".repeat(32);
  const akia = "AK" + "IA" + "C".repeat(16);
  const cases = [
    {
      rule: "personal-path",
      match: ["/" + "Users/alice/project", "/" + "home/bob/src"],
      noMatch: ["/" + "Users/...", "/" + "Users/<you>", "~/project", "docs/research/..."],
    },
    {
      rule: "credential",
      match: [ghp, sk, akia, "Bearer " + "c".repeat(32)],
      noMatch: ["risk-register.md", "capability.matrix", "sk-short", ghp.slice(0, 8)],
    },
    {
      rule: "internal-ref",
      match: [".astra/PLAN.md", "HANDOFF.md", "STATUS.md", "INSTALL-MOCL.md", "config.local.json", "VERIFY.md"],
      noMatch: ["docs/process/00-OPERATING-MODEL.md", "status.md", "VERIFY-GATE.md", "config.example.json"],
    },
  ];
  const failures = [];
  for (const c of cases) {
    const rule = RULES.find((r) => r.id === c.rule);
    if (!rule) {
      failures.push(`unknown rule: ${c.rule}`);
      continue;
    }
    for (const sample of c.match) {
      rule.re.lastIndex = 0;
      if (!rule.re.test(sample)) failures.push(`[${c.rule}] 未命中应命中的样例`);
    }
    for (const sample of c.noMatch) {
      rule.re.lastIndex = 0;
      if (rule.re.test(sample)) failures.push(`[${c.rule}] 误命中不应命中的样例`);
    }
  }
  for (const sample of ["docs/.astra/x", ".astra/BRIEF.md", "HANDOFF.md", "STATUS.md", "config.local.json"]) {
    if (!INTERNAL_PATH.test(sample)) failures.push(`[internal-file] 未命中: ${sample}`);
  }
  for (const sample of ["docs/index.md", "config.example.json", "tools/leak-scan.mjs"]) {
    if (INTERNAL_PATH.test(sample)) failures.push(`[internal-file] 误命中: ${sample}`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.log(`FAIL [self-test] ${f}`);
    return false;
  }
  if (VERBOSE) console.log("[leak-scan] self-test: PASS (rules are live, placeholders are ignored)");
  return true;
}

function scan() {
  const files = listTrackedFiles();
  const hits = [];
  const allowed = [];
  const perRule = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  let scanned = 0;
  let binary = 0;
  const deleted = [];
  const byDir = {};

  for (const fileRel of files) {
    // D. 内部台账文件路径检查（不适用白名单：这类文件不应存在）
    if (INTERNAL_PATH.test(fileRel)) {
      hits.push({ rule: "internal-file", file: fileRel, line: 0, why: "内部台账文件被跟踪" });
      perRule["internal-file"] = (perRule["internal-file"] || 0) + 1;
    }

    let text;
    try {
      const buf = readFileSync(resolve(ROOT, fileRel));
      if (buf.includes(0)) {
        binary += 1;
        continue;
      }
      text = buf.toString("utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // 已跟踪但工作树中已删除（待 git rm/commit）：记录但不判泄漏
        deleted.push(fileRel);
        continue;
      }
      hits.push({
        rule: "read-error",
        file: fileRel,
        line: 0,
        why: `无法读取: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    scanned += 1;
    const top = fileRel.includes("/") ? fileRel.slice(0, fileRel.indexOf("/")) + "/" : "(root)";
    byDir[top] = (byDir[top] || 0) + 1;

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const line = lineOf(text, m.index);
        if (isAllowed(rule.id, fileRel)) {
          allowed.push({ rule: rule.id, file: fileRel, line, why: m[0] });
          continue;
        }
        perRule[rule.id] += 1;
        hits.push({ rule: rule.id, file: fileRel, line, why: mask(rule.id, m[0]) });
      }
    }
  }

  // 输出
  for (const h of hits) {
    const loc = h.line > 0 ? `${h.file}:${h.line}` : h.file;
    console.log(`FAIL [${h.rule}] ${loc}: ${h.why}`);
  }
  if (VERBOSE) {
    for (const a of allowed) {
      const why = a.rule === "credential" ? mask("credential", a.why) : a.why;
      console.log(`ALLOW [${a.rule}] ${a.file}${a.line > 0 ? `:${a.line}` : ""}: ${why}`);
    }
    console.log(
      `[leak-scan] rules=${RULES.length + 1} allowed=${allowed.length} per-rule=${JSON.stringify(perRule)}`,
    );
    console.log(`[leak-scan] scanned-by-dir=${JSON.stringify(byDir)}`);
  }
  console.log(
    `[leak-scan] tracked=${files.length} scanned=${scanned} skipped-binary=${binary} ` +
      `allowed=${allowed.length} hits=${hits.length}` +
      (deleted.length > 0 ? ` pending-deletion=${JSON.stringify(deleted)}` : ""),
  );
  if (hits.length === 0) {
    console.log("[leak-scan] OK: no personal paths, credentials or internal-ledger references.");
    return 0;
  }
  console.log("[leak-scan] FAILED: fix or add an explicit allowlist entry with a reason.");
  return 1;
}

// 环境检查：必须在 git 工作树内（git ls-files 统一以 ROOT 为基准）
const guard = spawnSync("git", ["-C", ROOT, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
if (guard.status !== 0) {
  console.error("[leak-scan] ERROR: 仓库根不在 git 工作树内");
  process.exit(2);
}

if (!selfTest()) process.exit(1);
process.exit(scan());
