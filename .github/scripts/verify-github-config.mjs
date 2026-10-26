#!/usr/bin/env node
/**
 * verify-github-config.mjs — `.github/` 工程配置自检（零依赖，CI 第一步）。
 *
 * 目的：让「GitHub 工程配置」本身成为可机械验证的产物，而不是靠人眼 review 的文本。
 * 本脚本校验：
 *   1. 必需文件齐全（workflows / Issue Forms / PR 模板 / CODEOWNERS / labels / dependabot / scripts）；
 *   2. .github/ 下所有 YAML 可解析：优先 python3 + PyYAML 交叉校验（本机通常可用），
 *      不可用时回退到内置 yaml-lite 保守解析器；两路都不可解析 → 失败，不静默放行；
 *   3. 每个 workflow 有 name / on / jobs，每个 job 有 runs-on + steps，每个 step 有 uses 或 run；
 *   4. action 版本白名单（只允许仓库真实使用的 v4 系列，禁止虚构/浮动版本）；
 *   5. 权限最小化（CI/process-guard = contents: read；release = contents: write）；
 *   6. 触发条件与语义（ci: push/PR main；release: 仅 tag v*；process-guard: pull_request 非 target）；
 *   7. 门禁覆盖面（CI 真的会跑 typecheck/test/validate/sync-schema/build/leak-scan/agents/orchestrator/e2e/docs）；
 *   8. labels.yml 与 Issue 模板/Dependabot 引用的标签完全一致；
 *   9. PR 模板含 6 个必需小节 + 证据表表头 + G0–G7 门禁位；
 *  10. 无泄漏：`.github/**` 不含个人绝对路径、凭据模式、内部台账引用。
 *
 * 用法：
 *   node .github/scripts/verify-github-config.mjs            # 校验当前仓库（exit 0 = 全绿）
 *   node .github/scripts/verify-github-config.mjs --root DIR # 校验指定根目录（供自测/复跑）
 *   node .github/scripts/verify-github-config.mjs --self-test # 变异自测：证明校验器真的会红
 *
 * 退出码：0 全绿；1 有失败项；2 用法错误。
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseYaml } from "./lib/yaml-lite.mjs";
import { LABEL_CATEGORIES, validateLabels } from "./sync-labels.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

/** 本阶段唯一允许的 action 引用（版本必须真实存在，且与官方当前推荐大版本一致）。 */
const ALLOWED_ACTIONS = new Set([
  "actions/checkout@v4",
  "actions/setup-node@v4",
  "pnpm/action-setup@v4",
  "actions/upload-artifact@v4",
]);

const REQUIRED_FILES = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/process-guard.yml",
  ".github/ISSUE_TEMPLATE/requirement.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/CODEOWNERS",
  ".github/labels.yml",
  ".github/dependabot.yml",
  ".github/scripts/verify-github-config.mjs",
  ".github/scripts/check-pr.mjs",
  ".github/scripts/sync-labels.mjs",
  ".github/scripts/release-notes.mjs",
  ".github/scripts/lib/yaml-lite.mjs",
];

const ISSUE_FORM_TYPES = new Set(["markdown", "input", "textarea", "dropdown", "checkboxes"]);

/** 已冻结的 required-checks 名称（分支保护依赖，勿改；改则同步更新 VERIFY-R2）。 */
const FROZEN_JOB_NAMES = {
  "ci.yml": ["build & contracts (node 24 / pnpm 11)", "e2e pr-scenario (offline)", "docs gate"],
  "process-guard.yml": ["pr contract (process-guard)"],
};

const CI_REQUIRED_COMMANDS = [
  "pnpm install --frozen-lockfile",
  "pnpm -s typecheck",
  "pnpm -s test",
  "pnpm -s validate",
  "node tools/sync-schema.mjs --check",
  "pnpm -s build:plugin",
  "node tools/leak-scan.mjs",
  "node agents/verify-agents.mjs",
  "node --test orchestrator/test/",
  "node e2e/pr-scenario.mjs",
  "python3 tools/check_docs.py all",
  "node .github/scripts/verify-github-config.mjs",
  "node .github/scripts/verify-github-config.mjs --self-test",
];

const SECRET_PATTERNS = [
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u },
  { name: "OpenAI/Anthropic 风格 key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

function readText(root, file) {
  return readFileSync(join(root, file), "utf8");
}

function deepEqual(a, b, path = "$") {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: 类型不同（${typeof a} vs ${typeof b}）`;
  if (a === null || b === null || typeof a !== "object") {
    return `${path}: 值不同（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: 数组/对象不一致`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: 数组长度不同（${a.length} vs ${b.length}）`;
    for (let i = 0; i < a.length; i += 1) {
      const diff = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.join("\u0000") !== keysB.join("\u0000")) {
    return `${path}: 键集合不同（${keysA.join(",")} vs ${keysB.join(",")}）`;
  }
  for (const key of keysA) {
    const diff = deepEqual(a[key], b[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

/**
 * 归一化后比较：PyYAML（YAML 1.1）会把裸 `on:` 键解析成布尔 True，
 * json.dumps 后键名变成 "true"；内置解析器保持字符串 "on"。两者语义等价。
 */
function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key === "true" ? "on" : key] = normalizeForCompare(val);
    }
    return out;
  }
  return value;
}

function probePyYaml() {
  const probe = spawnSync("python3", ["-c", "import yaml,sys; print(yaml.__version__)"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

function pyYamlLoadAll(root, files) {
  const script = [
    "import json,sys,yaml",
    "out=[]",
    "for path in sys.argv[1:]:",
    "    try:",
    "        with open(path, encoding='utf-8') as f:",
    "            data=yaml.safe_load(f)",
    "        out.append({'ok':True,'data':data})",
    "    except Exception as exc:",
    "        out.append({'ok':False,'error':str(exc)})",
    "print(json.dumps(out, ensure_ascii=False, default=str))",
  ].join("\n");
  const absolute = files.map((file) => join(root, file));
  const result = spawnSync("python3", ["-c", script, ...absolute], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || "python3 执行失败").trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `PyYAML 输出无法解析为 JSON：${error.message}` };
  }
}

function hasKey(object, key) {
  return Boolean(object) && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function workflowDocs(docs) {
  return [...docs.entries()].filter(([file]) => file.startsWith(".github/workflows/") && file.endsWith(".yml"));
}

function jobList(doc) {
  return Object.entries(doc.jobs ?? {});
}

function issueFormDocs(docs) {
  return [...docs.entries()].filter(
    ([file]) => file.startsWith(".github/ISSUE_TEMPLATE/") && file.endsWith(".yml") && !file.endsWith("config.yml"),
  );
}

/**
 * 执行全部校验。
 * @param {string} root
 * @returns {{results: {name: string, ok: boolean, detail: string}[], parseMode: string}}
 */
export function validate(root = DEFAULT_ROOT) {
  const results = [];
  const docs = new Map();
  const parseErrors = [];

  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
  };

  const loadProblems = (problems) => {
    if (problems.length > 0) throw new Error(problems.join("；"));
  };

  // ── 0. YAML 解析（内置解析器 + 可选 PyYAML 交叉校验）────────────────
  const ymlFiles = (existsSync(join(root, ".github"))
    ? walk(join(root, ".github"))
    : []
  )
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => `.github/${file.split("\\").join("/")}`)
    .sort();
  const pyyamlVersion = probePyYaml();
  const parseMode = pyyamlVersion
    ? `内置 yaml-lite + PyYAML ${pyyamlVersion} 交叉校验`
    : "内置 yaml-lite（PyYAML 不可用，未做交叉校验）";

  check("YAML 可解析", () => {
    const problems = [];
    for (const file of ymlFiles) {
      try {
        docs.set(file, parseYaml(readText(root, file), file));
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
      }
    }
    if (pyyamlVersion) {
      const loaded = pyYamlLoadAll(root, ymlFiles);
      if (!loaded.ok) {
        problems.push(`PyYAML 校验失败：${loaded.error}`);
      } else {
        ymlFiles.forEach((file, index) => {
          const entry = loaded.data[index];
          if (!entry.ok) {
            problems.push(`${file}: PyYAML 解析失败：${entry.error}`);
            return;
          }
          if (!docs.has(file)) return;
          const diff = deepEqual(normalizeForCompare(docs.get(file)), normalizeForCompare(entry.data));
          if (diff) problems.push(`${file}: 内置解析器与 PyYAML 结果不一致 → ${diff}`);
        });
      }
    }
    loadProblems(problems);
    return `${ymlFiles.length} 个 YAML 文件（${parseMode}）`;
  });

  const wfDocs = workflowDocs(docs);

  // ── 1. 必需文件 ─────────────────────────────────────────────────────
  check("必需文件齐全", () => {
    const missing = REQUIRED_FILES.filter((file) => !existsSync(join(root, file)));
    if (missing.length > 0) throw new Error(`缺失：${missing.join("、")}`);
    return `${REQUIRED_FILES.length}/${REQUIRED_FILES.length}`;
  });

  check("workflow 文件集合", () => {
    const expected = [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/process-guard.yml"];
    const found = wfDocs.map(([file]) => file);
    const missing = expected.filter((file) => !found.includes(file));
    if (missing.length > 0) throw new Error(`缺少 workflow：${missing.join("、")}`);
    return `${found.length} 个：${found.map((file) => file.replace(".github/workflows/", "")).join(" / ")}`;
  });

  // ── 2. workflow 基础结构 ────────────────────────────────────────────
  check("workflow 基础结构（name/on/jobs/permissions）", () => {
    const problems = [];
    for (const [file, doc] of wfDocs) {
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        problems.push(`${file}: 顶层不是映射`);
        continue;
      }
      if (typeof doc.name !== "string" || doc.name.trim() === "") problems.push(`${file}: 缺少非空 name`);
      const triggers = doc.on;
      if (triggers === null || triggers === undefined) problems.push(`${file}: 缺少 on 触发定义`);
      else if (typeof triggers === "string" && triggers.trim() === "") problems.push(`${file}: on 为空`);
      if (!doc.jobs || typeof doc.jobs !== "object" || Array.isArray(doc.jobs) || Object.keys(doc.jobs).length === 0) {
        problems.push(`${file}: 缺少 jobs 或 jobs 为空`);
        continue;
      }
      if (!doc.permissions || typeof doc.permissions !== "object" || Array.isArray(doc.permissions)) {
        problems.push(`${file}: 缺少 workflow 级 permissions 声明（权限必须显式最小化）`);
      }
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        if (!job || typeof job !== "object") {
          problems.push(`${file}: job ${jobId} 不是映射`);
          continue;
        }
        if (typeof job["runs-on"] !== "string" || job["runs-on"].trim() === "") {
          problems.push(`${file}: job ${jobId} 缺少 runs-on`);
        }
        const steps = asArray(job.steps);
        if (steps.length === 0) {
          problems.push(`${file}: job ${jobId} 缺少 steps`);
          continue;
        }
        steps.forEach((step, index) => {
          const label = `${file}: job ${jobId} step#${index + 1}`;
          if (!step || typeof step !== "object") {
            problems.push(`${label} 不是映射`);
            return;
          }
          const hasUses = typeof step.uses === "string" && step.uses.trim() !== "";
          const hasRun = typeof step.run === "string" && step.run.trim() !== "";
          if (hasUses === hasRun) problems.push(`${label} 必须且只能有 uses 或 run 之一`);
          if (hasUses && !ALLOWED_ACTIONS.has(step.uses)) {
            problems.push(`${label} 使用了未登记的 action：${step.uses}（允许：${[...ALLOWED_ACTIONS].join("、")}）`);
          }
        });
      }
    }
    loadProblems(problems);
    return `${wfDocs.length} 个 workflow、${wfDocs.reduce((sum, [, doc]) => sum + Object.keys(doc.jobs ?? {}).length, 0)} 个 job`;
  });

  // ── 3. job 名冻结 ──────────────────────────────────────────────────
  check("required-checks job 名已冻结", () => {
    const problems = [];
    for (const [file, expectedNames] of Object.entries(FROZEN_JOB_NAMES)) {
      const entry = wfDocs.find(([path]) => path.endsWith(`/${file}`));
      if (!entry) {
        problems.push(`缺少 ${file}`);
        continue;
      }
      const actual = jobList(entry[1]).map(([, job]) => job?.name ?? null);
      for (const expected of expectedNames) {
        if (!actual.includes(expected)) problems.push(`${file}: 缺少冻结 job 名「${expected}」`);
      }
    }
    loadProblems(problems);
    return Object.entries(FROZEN_JOB_NAMES).map(([file, names]) => `${file}: ${names.join(" | ")}`).join("；");
  });

  // ── 4. 权限最小化 ──────────────────────────────────────────────────
  check("权限最小化", () => {
    const problems = [];
    const permissionOf = (file, key) => {
      const entry = wfDocs.find(([path]) => path.endsWith(`/${file}`));
      return entry?.[1]?.permissions?.[key] ?? null;
    };
    if (permissionOf("ci.yml", "contents") !== "read") problems.push("ci.yml: permissions.contents 必须是 read");
    if (permissionOf("process-guard.yml", "contents") !== "read") {
      problems.push("process-guard.yml: permissions.contents 必须是 read");
    }
    if (permissionOf("process-guard.yml", "pull-requests") !== "read") {
      problems.push("process-guard.yml: permissions.pull-requests 必须是 read");
    }
    if (permissionOf("release.yml", "contents") !== "write") {
      problems.push("release.yml: permissions.contents 必须是 write（创建 Release 所需）");
    }
    for (const [file, doc] of wfDocs) {
      for (const key of ["actions", "checks", "issues", "packages", "deployments", "security-events"]) {
        if ((doc.permissions ?? {})[key] === "write") {
          problems.push(`${file}: 不应申请 ${key}: write（最小权限）`);
        }
      }
    }
    loadProblems(problems);
    return "CI/process-guard 只读；release 仅 contents: write";
  });

  // ── 5. 触发条件与并发 ──────────────────────────────────────────────
  check("触发条件语义", () => {
    const problems = [];
    const ci = wfDocs.find(([file]) => file.endsWith("/ci.yml"))?.[1];
    const release = wfDocs.find(([file]) => file.endsWith("/release.yml"))?.[1];
    const guard = wfDocs.find(([file]) => file.endsWith("/process-guard.yml"))?.[1];
    if (!ci || !release || !guard) throw new Error("workflow 缺失（见上一条）");

    if (!hasKey(ci.on, "push")) problems.push("ci.yml: 缺少 push 触发");
    if (!hasKey(ci.on, "pull_request")) problems.push("ci.yml: 缺少 pull_request 触发");
    const ciPushBranches = asArray(ci.on?.push?.branches);
    if (!ciPushBranches.includes("main")) problems.push("ci.yml: push 未限定 main 分支");
    if (ci.concurrency?.["cancel-in-progress"] !== true) problems.push("ci.yml: concurrency.cancel-in-progress 必须为 true");

    if (!hasKey(release.on, "push")) problems.push("release.yml: 缺少 push 触发");
    if (hasKey(release.on, "pull_request")) problems.push("release.yml: 不得由 pull_request 触发");
    if (hasKey(release.on?.push ?? {}, "branches")) problems.push("release.yml: push 不得限定 branches（只允许 tag 触发）");
    if (!asArray(release.on?.push?.tags).includes("v*")) problems.push("release.yml: push.tags 必须为 v*");

    if (!hasKey(guard.on, "pull_request")) problems.push("process-guard.yml: 必须由 pull_request 触发");
    if (hasKey(guard.on, "pull_request_target")) problems.push("process-guard.yml: 禁止 pull_request_target（fork 场景安全风险）");
    const guardTypes = asArray(guard.on?.pull_request?.types);
    for (const type of ["opened", "edited", "synchronize", "reopened"]) {
      if (!guardTypes.includes(type)) problems.push(`process-guard.yml: pull_request.types 缺少 ${type}`);
    }
    for (const [file] of wfDocs) {
      if (/^[ \t]*pull_request_target[ \t]*:/mu.test(readText(root, file))) {
        problems.push(`${file}: 触发器使用了 pull_request_target（安全基线禁止）`);
      }
    }
    loadProblems(problems);
    return "ci=push/PR main；release=仅 tag v*；process-guard=pull_request（非 target）";
  });

  // ── 6. CI 门禁覆盖面 ──────────────────────────────────────────────
  check("CI 门禁覆盖面", () => {
    const ciEntry = wfDocs.find(([file]) => file.endsWith("/ci.yml"));
    if (!ciEntry) throw new Error("ci.yml 缺失");
    const raw = readText(root, ciEntry[0]);
    const problems = [];
    for (const command of CI_REQUIRED_COMMANDS) {
      if (!raw.includes(command)) problems.push(`ci.yml 未包含命令：${command}`);
    }
    for (const token of ['node-version: "24"', "version: 11.22.0"]) {
      if (!raw.includes(token)) problems.push(`ci.yml 缺少运行环境固定：${token}`);
    }
    if (!raw.includes("pnpm/action-setup@v4")) problems.push("ci.yml 缺少 pnpm/action-setup@v4");
    if (raw.includes("continue-on-error")) problems.push("ci.yml 不得使用 continue-on-error（文档门禁等必须硬失败）");
    if (/pnpm -s test -- --run/u.test(raw)) problems.push("ci.yml 使用多余参数：pnpm -s test 即可");
    // e2e 通过 src/abi/validate.ts 的 createRequire 使用 ajv，必须安装依赖后再跑。
    const e2eJob = Object.entries(ciEntry[1].jobs ?? {}).find(
      ([, job]) => job?.name === "e2e pr-scenario (offline)",
    );
    if (!e2eJob) {
      problems.push("ci.yml 缺少 e2e pr-scenario (offline) job");
    } else {
      const e2eRuns = asArray(e2eJob[1].steps)
        .map((step) => step?.run ?? "")
        .join("\n");
      if (!e2eRuns.includes("pnpm install --frozen-lockfile")) {
        problems.push("ci.yml e2e job 缺少 pnpm install --frozen-lockfile（e2e 依赖 ajv，干净环境必须安装）");
      }
      if (!e2eRuns.includes("node e2e/pr-scenario.mjs")) {
        problems.push("ci.yml e2e job 未运行 node e2e/pr-scenario.mjs");
      }
    }
    if (/\bgh[ \t]+(?:pr|issue|release|label)[ \t]+(?:create|edit|merge|close|comment|delete)/u.test(raw)) {
      problems.push("ci.yml 出现 gh 写操作（CI 必须只读）");
    }
    loadProblems(problems);
    return `${CI_REQUIRED_COMMANDS.length} 条门禁命令已接线`;
  });

  // ── 7. release 语义 ───────────────────────────────────────────────
  check("release 语义", () => {
    const entry = wfDocs.find(([file]) => file.endsWith("/release.yml"));
    if (!entry) throw new Error("release.yml 缺失");
    const raw = readText(root, entry[0]);
    const problems = [];
    for (const token of ["release-notes.mjs", "CHANGELOG.md", "gh release create", "--notes-file", "--verify-tag"]) {
      if (!raw.includes(token)) problems.push(`release.yml 未包含：${token}`);
    }
    const triggers = entry[1].on ?? {};
    if (asArray(triggers?.push?.tags).join(",") !== "v*") problems.push("release.yml 触发必须恰好是 tags: v*");
    // 发布门禁不允许静默：版本一致性/构建失败必须让 job 红。
    if (/continue-on-error|\|\|\s*true/u.test(raw)) {
      problems.push("release.yml 出现 continue-on-error / `|| true`：版本一致性或构建失败会被吞掉，发布门禁不允许静默");
    }
    loadProblems(problems);
    return "tag→构建→CHANGELOG 提取 notes→gh release create";
  });

  // ── 8. process-guard 语义 ──────────────────────────────────────────
  check("process-guard 语义", () => {
    const entry = wfDocs.find(([file]) => file.endsWith("/process-guard.yml"));
    if (!entry) throw new Error("process-guard.yml 缺失");
    const raw = readText(root, entry[0]);
    const problems = [];
    for (const token of [
      "check-pr.mjs",
      "--body-file",
      "--self-test",
      "github.event.pull_request.body",
      "github.event.pull_request.base.sha",
      "persist-credentials: false",
    ]) {
      if (!raw.includes(token)) problems.push(`process-guard.yml 未包含：${token}`);
    }
    if (/\bgh[ \t]+(?:pr|issue|release|label)[ \t]+(?:create|edit|merge|close|comment|delete)/u.test(raw)) {
      problems.push("process-guard.yml 出现 gh 写操作（必须只读）");
    }
    loadProblems(problems);
    return "PR body/title → check-pr.mjs（含自检）";
  });

  // ── 9. Issue Forms 结构 ───────────────────────────────────────────
  const labelNames = new Set();
  check("Issue Forms 结构", () => {
    const problems = [];
    const forms = issueFormDocs(docs);
    if (forms.length < 2) problems.push(`Issue 表单数量不足：${forms.length}（至少 requirement + bug）`);
    for (const [file, doc] of forms) {
      if (typeof doc?.name !== "string" || doc.name.trim() === "") problems.push(`${file}: 缺少 name`);
      if (typeof doc?.description !== "string" || doc.description.trim() === "") problems.push(`${file}: 缺少 description`);
      if (!Array.isArray(doc?.body) || doc.body.length === 0) {
        problems.push(`${file}: 缺少 body`);
        continue;
      }
      const ids = new Set();
      for (const [index, element] of doc.body.entries()) {
        const where = `${file}: body[${index}]`;
        if (!element || typeof element !== "object") {
          problems.push(`${where} 不是映射`);
          continue;
        }
        if (!ISSUE_FORM_TYPES.has(element.type)) {
          problems.push(`${where} 非法 type=${String(element.type)}（允许：${[...ISSUE_FORM_TYPES].join("/")}）`);
          continue;
        }
        if (element.type === "markdown") {
          if (typeof element.attributes?.value !== "string" || element.attributes.value.trim() === "") {
            problems.push(`${where} markdown 缺少 attributes.value`);
          }
          continue;
        }
        if (typeof element.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(element.id)) {
          problems.push(`${where} 缺少合法 id（小写字母/数字/_/-）`);
        } else if (ids.has(element.id)) {
          problems.push(`${where} id 重复：${element.id}`);
        } else {
          ids.add(element.id);
        }
        if (typeof element.attributes?.label !== "string" || element.attributes.label.trim() === "") {
          problems.push(`${where} 缺少 attributes.label`);
        }
        if (element.type === "dropdown") {
          const options = asArray(element.attributes?.options);
          if (options.length === 0) problems.push(`${where} dropdown 缺少 options`);
        }
        if (element.type === "checkboxes") {
          const options = asArray(element.attributes?.options);
          if (options.length === 0) problems.push(`${where} checkboxes 缺少 options`);
          for (const option of options) {
            if (!option || typeof option.label !== "string" || option.label.trim() === "") {
              problems.push(`${where} checkboxes 选项缺少 label`);
            }
          }
        }
        if (element.validations !== undefined && typeof element.validations?.required !== "boolean") {
          problems.push(`${where} validations.required 必须是布尔值`);
        }
      }
      const labels = typeof doc.labels === "string" ? doc.labels.split(",") : asArray(doc.labels);
      for (const label of labels) {
        labelNames.add(String(label).trim());
      }
    }
    loadProblems(problems);
    return `${forms.length} 个表单：${forms.map(([file]) => file.split("/").pop()).join(" / ")}`;
  });

  // ── 10. labels 体系 + 引用一致性 ──────────────────────────────────
  let labelsDoc = null;
  check("labels 体系", () => {
    const labels = docs.get(".github/labels.yml");
    if (!labels) throw new Error(".github/labels.yml 缺失或不可解析");
    labelsDoc = labels;
    const { errors, warnings, counts } = validateLabels(labels);
    const problems = [...errors.map((error) => `labels: ${error}`)];
    for (const [category, meta] of Object.entries(LABEL_CATEGORIES)) {
      if ((counts[category] ?? 0) === 0) problems.push(`labels: 缺少 ${meta.prefix}* 类别`);
    }
    if (labels.length < 20) problems.push(`labels: 数量过少（${labels.length}），专业标签体系应覆盖六类`);
    loadProblems(problems);
    const summary = Object.entries(counts)
      .map(([category, count]) => `${category}=${count}`)
      .join("/");
    return `${labels.length} 个（${summary}）${warnings.length > 0 ? `，${warnings.length} 条警告` : ""}`;
  });

  check("标签引用一致性（Issues/Dependabot）", () => {
    if (!labelsDoc) throw new Error("labels.yml 不可用");
    const defined = new Set(labelsDoc.map((label) => label?.name).filter(Boolean));
    const problems = [];
    for (const label of labelNames) {
      if (!defined.has(label)) problems.push(`Issue 模板引用了未定义标签：${label}`);
    }
    const dependabot = docs.get(".github/dependabot.yml");
    if (dependabot) {
      for (const update of asArray(dependabot.updates)) {
        for (const label of asArray(update?.labels)) {
          if (!defined.has(label)) problems.push(`dependabot 引用了未定义标签：${label}`);
        }
      }
    }
    for (const required of ["agent:ready", "status/blocked", "status/in-review"]) {
      if (!defined.has(required)) problems.push(`缺少流程必需标签：${required}`);
    }
    loadProblems(problems);
    return `${labelNames.size} 个模板/依赖引用标签全部已定义`;
  });

  // ── 11. config.yml ────────────────────────────────────────────────
  check("Issue 选择页 config.yml", () => {
    const doc = docs.get(".github/ISSUE_TEMPLATE/config.yml");
    if (!doc) throw new Error("config.yml 缺失或不可解析");
    const problems = [];
    if (doc.blank_issues_enabled !== false) problems.push("blank_issues_enabled 必须为 false（强制走表单，保证 G0 字段齐全）");
    const links = asArray(doc.contact_links);
    if (links.length === 0) problems.push("contact_links 为空");
    for (const link of links) {
      if (typeof link?.name !== "string" || link.name.trim() === "") problems.push("contact_links 条目缺少 name");
      if (typeof link?.url !== "string" || !/^https:\/\//u.test(link.url)) problems.push(`contact_links 条目 url 非法：${String(link?.url)}`);
      if (typeof link?.about !== "string" || link.about.trim() === "") problems.push("contact_links 条目缺少 about");
    }
    loadProblems(problems);
    return `${links.length} 个联系入口，空白 issue 已禁用`;
  });

  // ── 12. PR 模板 ───────────────────────────────────────────────────
  check("PR 模板结构", () => {
    const raw = readText(root, ".github/PULL_REQUEST_TEMPLATE.md");
    const problems = [];
    const sections = [
      { name: "关联 issue", re: /^#{2,3}[ \t]*关联[ \t]*[Ii]ssue[ \t]*$/mu },
      { name: "变更摘要", re: /^#{2,3}[ \t]*变更摘要[ \t]*$/mu },
      { name: "证据表", re: /^#{2,3}[ \t]*(?:证据表|验证证据)[ \t]*$/mu },
      { name: "风险与回滚", re: /^#{2,3}[ \t]*风险与回滚[ \t]*$/mu },
      { name: "文档更新", re: /^#{2,3}[ \t]*文档更新[ \t]*$/mu },
      { name: "检查清单", re: /^#{2,3}[ \t]*(?:检查清单|Checklist)[ \t]*$/mu },
    ];
    for (const section of sections) {
      if (!section.re.test(raw)) problems.push(`缺少小节：## ${section.name}`);
    }
    if (!/门禁[（(]G0[–\-—]G7[）)]/u.test(raw)) problems.push("缺少「门禁（G0–G7）」小节（流程门禁位）");
    for (const gate of ["G4", "G5", "G6"]) {
      if (!raw.includes(gate)) problems.push(`门禁小节缺少 ${gate}`);
    }
    const headerMatch = /^\|[^\n]*\|[ \t]*$/mu.exec(raw);
    if (!headerMatch) {
      problems.push("缺少证据表");
    } else if (!/命令/u.test(raw) || !/退出码/u.test(raw) || !/关键输出/u.test(raw)) {
      problems.push("证据表表头必须含「命令」「退出码」「关键输出」");
    }
    const checkboxes = raw.match(/^-\s*\[[ xX]\]/gmu) ?? [];
    if (checkboxes.length < 4) problems.push(`Checklist 条目过少：${checkboxes.length}（至少 4）`);
    loadProblems(problems);
    return "7 个必需小节 + G0–G7 门禁位 + 证据表（命令/退出码/关键输出）";
  });

  // ── 13. CODEOWNERS ────────────────────────────────────────────────
  check("CODEOWNERS 结构", () => {
    const raw = readText(root, ".github/CODEOWNERS");
    const lines = raw.split("\n").map((line) => line.trim());
    const rules = lines.filter((line) => line !== "" && !line.startsWith("#"));
    const problems = [];
    if (rules.length === 0) problems.push("没有生效规则");
    for (const rule of rules) {
      const [pattern, ...owners] = rule.split(/\s+/u);
      if (!pattern) {
        problems.push(`规则缺少 pattern：${rule}`);
        continue;
      }
      if (owners.length === 0) problems.push(`规则缺少 owner：${rule}`);
      for (const owner of owners) {
        if (!owner.startsWith("@")) problems.push(`owner 必须以 @ 开头：${owner}`);
      }
    }
    if (!rules.some((rule) => /^\*\s+@/u.test(rule))) problems.push("缺少 `* @维护者` 兜底规则");
    if (!rules.some((rule) => rule.includes("@lakii2982"))) problems.push("缺少当前维护者 @lakii2982");
    if (!raw.includes("未来扩展")) problems.push("缺少未来多 owner 扩展的注释说明（本阶段单维护者模式需显式记录）");
    loadProblems(problems);
    return `${rules.length} 条规则（单维护者 + 未来扩展注释）`;
  });

  // ── 14. dependabot ────────────────────────────────────────────────
  check("dependabot 配置", () => {
    const doc = docs.get(".github/dependabot.yml");
    if (!doc) throw new Error("dependabot.yml 缺失或不可解析");
    const problems = [];
    if (doc.version !== 2) problems.push(`version 必须为 2（当前 ${String(doc.version)}）`);
    const updates = asArray(doc.updates);
    if (updates.length === 0) problems.push("updates 为空");
    const ecosystems = new Set();
    for (const update of updates) {
      const where = `updates[${updates.indexOf(update)}]`;
      const ecosystem = update?.["package-ecosystem"];
      if (typeof ecosystem !== "string") problems.push(`${where}: 缺少 package-ecosystem`);
      else ecosystems.add(ecosystem);
      if (typeof update?.directory !== "string") problems.push(`${where}: 缺少 directory`);
      if (!["daily", "weekly", "monthly"].includes(update?.schedule?.interval)) {
        problems.push(`${where}: schedule.interval 非法（daily/weekly/monthly）`);
      }
    }
    for (const required of ["npm", "github-actions"]) {
      if (!ecosystems.has(required)) problems.push(`缺少 ecosystem：${required}`);
    }
    loadProblems(problems);
    return `${updates.length} 个更新源：${[...ecosystems].join(" / ")}`;
  });

  // ── 15. 泄漏扫描 ──────────────────────────────────────────────────
  check("无泄漏（路径/凭据/内部台账）", () => {
    const problems = [];
    const files = walk(join(root, ".github")).map((file) => `.github/${file.split("\\").join("/")}`);
    // 校验器自身必须包含这些检测模式（字面量），因此对自身豁免，其余文件一律扫描。
    const SELF = ".github/scripts/verify-github-config.mjs";
    for (const file of files) {
      if (file === SELF) continue;
      const text = readText(root, file);
      if (/\/Users\/[A-Za-z]/u.test(text)) problems.push(`${file}: 含个人绝对路径 /Users/...`);
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) problems.push(`${file}: 疑似 ${pattern.name}`);
      }
      if (/\.astra\/|HANDOFF\.md|STATUS\.md|INSTALL-MOCL/u.test(text)) {
        problems.push(`${file}: 引用内部台账（公开仓不得出现）`);
      }
    }
    loadProblems(problems);
    return `${files.length} 个文件干净`;
  });

  // ── 16. 测试入口不重叠（vitest 只收 tests/，orchestrator 走 node:test）────
  check("测试入口不重叠（vitest 配置）", () => {
    const configPath = join(root, "vitest.config.mjs");
    if (!existsSync(configPath)) {
      throw new Error(
        "缺少 vitest.config.mjs：vitest 默认会收集 orchestrator/test/*.test.mjs（node:test 风格），" +
          "`pnpm -s test` 会以 No test suite found 复红；CI 另用 node --test orchestrator/test/ 跑 R4 套件",
      );
    }
    const raw = readFileSync(configPath, "utf8");
    const problems = [];
    if (!raw.includes("orchestrator/**")) problems.push("vitest.config.mjs 的 exclude 未包含 orchestrator/**");
    if (!/include:\s*\[\s*"tests\/\*\*\/\*\.test\.ts"/u.test(raw)) {
      problems.push('vitest.config.mjs 的 include 应为 ["tests/**/*.test.ts"]');
    }
    if (raw.includes("passWithNoTests: true")) problems.push("vitest.config.mjs 不得 passWithNoTests: true（会掩盖空跑）");
    const ciEntry = wfDocs.find(([file]) => file.endsWith("/ci.yml"));
    const runs = ciEntry
      ? asArray(Object.values(ciEntry[1].jobs ?? {}).flatMap((job) => asArray(job?.steps).map((step) => step?.run ?? ""))).join("\n")
      : "";
    if (!runs.includes("pnpm -s test")) problems.push("ci.yml 未运行 pnpm -s test");
    if (!runs.includes("node --test orchestrator/test/")) {
      problems.push("ci.yml 未单独运行 node --test orchestrator/test/（orchestrator 套件会失去覆盖）");
    }
    loadProblems(problems);
    return "vitest 只收 tests/**/*.test.ts；orchestrator 由 node --test 独立执行（两入口不重叠）";
  });

  // ── 17. 脚本自洽 ──────────────────────────────────────────────────
  check("校验脚本自洽", () => {
    const problems = [];
    const checkPr = readText(root, ".github/scripts/check-pr.mjs");
    if (!checkPr.includes("--self-test")) problems.push("check-pr.mjs 缺少 --self-test（门禁自身必须有自检）");
    if (!checkPr.includes("pathToFileURL")) problems.push("check-pr.mjs 缺少 pathToFileURL 入口判断（中文/空格路径下会不执行）");
    const sync = readText(root, ".github/scripts/sync-labels.mjs");
    if (!sync.includes("--dry-run") || !sync.includes("--apply")) problems.push("sync-labels.mjs 缺少 --dry-run/--apply");
    const notes = readText(root, ".github/scripts/release-notes.mjs");
    if (!notes.includes("--tag") || !notes.includes("--changelog")) problems.push("release-notes.mjs 缺少 --tag/--changelog");
    loadProblems(problems);
    return "check-pr/sync-labels/release-notes 入口与自检齐备";
  });

  return { results, parseMode };
}

function printResults({ results, parseMode }) {
  console.log(`[verify-github] 解析模式：${parseMode}`);
  let failures = 0;
  for (const result of results) {
    if (result.ok) console.log(`PASS  ${result.name}：${result.detail}`);
    else {
      failures += 1;
      console.log(`FAIL  ${result.name}：${result.detail}`);
    }
  }
  console.log(`\n[verify-github] checks=${results.length} failures=${failures}`);
  if (failures === 0) {
    console.log("[verify-github] ALL CHECKS PASSED");
    return 0;
  }
  console.log("[verify-github] FAILED：修好上面每一项后重跑");
  return 1;
}

function runSelfTest() {
  const source = DEFAULT_ROOT;
  const sandbox = mkdtempSync(join(tmpdir(), "mocl-verify-github-"));
  const baseline = join(sandbox, "baseline");
  cpSync(join(source, ".github"), join(baseline, ".github"), { recursive: true });
  // 根目录的 vitest 配置也参与校验，自测副本需一并带上。
  if (existsSync(join(source, "vitest.config.mjs"))) {
    cpSync(join(source, "vitest.config.mjs"), join(baseline, "vitest.config.mjs"));
  }

  const cases = [];
  const mutate = (name, mutateFn, expectedDetail) => cases.push({ name, mutateFn, expectedDetail });

  mutate("未修改副本应通过", () => {}, null);
  mutate("删除必需文件应失败", (root) => rmSync(join(root, ".github/CODEOWNERS")), "必需文件齐全");
  mutate(
    "破坏 YAML 应失败",
    (root) => writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI\non: [push\n", "utf8"),
    "YAML 可解析",
  );
  mutate(
    "重复键（PyYAML 会静默覆盖）应被内置解析器识别并失败",
    (root) => {
      const file = join(root, ".github/workflows/release.yml");
      writeFileSync(file, `name: Duplicated\n${readFileSync(file, "utf8")}`, "utf8");
    },
    "YAML 可解析",
  );
  mutate(
    "未登记 action 应失败",
    (root) => {
      const file = join(root, ".github/workflows/ci.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace("actions/checkout@v4", "actions/checkout@v3"), "utf8");
    },
    "workflow 基础结构",
  );
  mutate(
    "恢复 continue-on-error 应失败",
    (root) => {
      const file = join(root, ".github/workflows/ci.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace("      - name: 文档结构闸门（硬门禁）", "      - name: 文档结构闸门（硬门禁）\n        continue-on-error: true"), "utf8");
    },
    "CI 门禁覆盖面",
  );
  mutate(
    "改掉冻结 job 名应失败",
    (root) => {
      const file = join(root, ".github/workflows/ci.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace("name: docs gate", "name: docs gate (tolerated)"), "utf8");
    },
    "required-checks job 名已冻结",
  );
  mutate(
    "Issue 模板引用未定义标签应失败",
    (root) => {
      const file = join(root, ".github/ISSUE_TEMPLATE/bug.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace('"type/bug"', '"type/not-defined"'), "utf8");
    },
    "标签引用一致性",
  );
  mutate(
    "删除 vitest 配置（会导致 pnpm -s test 复红）应失败",
    (root) => rmSync(join(root, "vitest.config.mjs")),
    "测试入口不重叠",
  );
  mutate(
    "process-guard 改回检出 PR head（允许改门禁脚本自放行）应失败",
    (root) => {
      const file = join(root, ".github/workflows/process-guard.yml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "github.event.pull_request.base.sha",
          "github.event.pull_request.head.sha",
        ),
        "utf8",
      );
    },
    "process-guard 语义",
  );
  mutate(
    "个人绝对路径应失败",
    (root) => {
      const file = join(root, ".github/PULL_REQUEST_TEMPLATE.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n见 /Users/example/git/mocl\n`, "utf8");
    },
    "无泄漏",
  );

  let failures = 0;
  for (const testCase of cases) {
    const root = join(sandbox, `case-${cases.indexOf(testCase)}`);
    cpSync(baseline, root, { recursive: true });
    testCase.mutateFn(root);
    const { results } = validate(root);
    const failedNames = results.filter((result) => !result.ok).map((result) => result.name);
    const ok = testCase.expectedDetail === null ? failedNames.length === 0 : failedNames.some((name) => name.includes(testCase.expectedDetail));
    if (ok) {
      console.log(`PASS  self-test: ${testCase.name}（失败项：${failedNames.length === 0 ? "无" : failedNames.join("、")}）`);
    } else {
      failures += 1;
      console.log(
        `FAIL  self-test: ${testCase.name}（期望：${testCase.expectedDetail === null ? "全部通过" : `触发「${testCase.expectedDetail}」`}，实际失败项：${failedNames.join("、") || "无"}）`,
      );
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n[verify-github] self-test 用例 ${cases.length} 条，失败 ${failures} 条`);
  return failures === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--root") args.root = argv[++i];
    else if (token === "--self-test") args.selfTest = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`用法：
  node .github/scripts/verify-github-config.mjs
  node .github/scripts/verify-github-config.mjs --root <仓库根目录>
  node .github/scripts/verify-github-config.mjs --self-test

说明：
  校验 .github/ 下 workflow / Issue Forms / PR 模板 / CODEOWNERS / labels / dependabot / scripts 的
  可解析性与自洽性；exit 0 = 全绿，1 = 有失败项。--self-test 用变异副本证明校验器真的会红。`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.selfTest) return runSelfTest();
  const root = args.root ? resolve(args.root) : DEFAULT_ROOT;
  if (!existsSync(root)) {
    console.error(`[verify-github] 根目录不存在：${root}`);
    return 2;
  }
  return printResults(validate(root));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
