#!/usr/bin/env node
/**
 * agents/verify-agents.mjs — MOCL 流程资产自检（零依赖，Node >= 24）
 *
 * 校验内容（全部为机械断言，失败即 exit 1）：
 *  1) 9 个角色文件存在，且每份含六段：职责 / 输入 / 输出 / 禁止事项 / 完成判据 / 回报格式；
 *     禁止事项 >=3 条、完成判据 >=3 个 checkbox、回报格式含「一句话」；
 *  2) verifier / reviewer 含「新上下文」与「不采信」（独立验证纪律）；
 *  3) docs/process/00..11 共 12 份存在，且各含规定小节关键词；
 *  4) G0–G7 全部出现在 00-OPERATING-MODEL.md；
 *  5) orchestrator CLI 契约名 intake/deliver/verify/watch/status 出现在 10 + agents/README.md；
 *  6) G4 门禁 ID（G4-C1..G4-C11）出现在 04-VERIFICATION.md；其引用的仓库内命令文件真实存在；
 *  7) package.json 含 typecheck / test 脚本（G4-C1/C2 的命令真源）；
 *  8) 角色索引 agents/README.md 覆盖全部 9 个角色名；
 *  9) agents/** 与 docs/process/** 不含内部台账/个人路径字面量（公开仓泄漏防线）。
 *
 * 用法：node agents/verify-agents.mjs [--quiet]
 * 退出码：0 全过；1 有失败项。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");

const failures = [];
const passes = [];

const rel = (p) => join(ROOT, p);

function pass(name, detail = "") {
  passes.push({ name, detail });
  if (!QUIET) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`FAIL  ${name} — ${detail}`);
}

function check(name, fn) {
  try {
    const detail = fn();
    pass(name, detail ?? "");
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function readRequired(relPath) {
  const abs = rel(relPath);
  if (!existsSync(abs)) throw new Error(`缺少文件：${relPath}`);
  const text = readFileSync(abs, "utf8");
  if (text.trim().length === 0) throw new Error(`文件为空：${relPath}`);
  return text;
}

function mustInclude(text, needles, label) {
  const missing = needles.filter((n) => !text.toLowerCase().includes(String(n).toLowerCase()));
  if (missing.length > 0) throw new Error(`${label} 缺少关键词/命令：${missing.join(", ")}`);
}

/** 解析 markdown 二级标题，返回 [{raw, title}]；title 去掉序号前缀 */
function sectionsOf(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const title = m[1].replace(/^\d+[.、]\s*/, "").trim();
    out.push({ raw: line, title });
  }
  return out;
}

function sectionBody(text, titlePrefix) {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[1].replace(/^\d+[.、]\s*/, "").trim().startsWith(titlePrefix)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/* ------------------------------------------------------------------ */
/* 1) 角色文件与六段                                                    */
/* ------------------------------------------------------------------ */

const ROLE_SECTIONS = ["职责", "输入", "输出", "禁止事项", "完成判据", "回报格式"];
const ROLES = [
  { file: "agents/roles/product-owner.md", name: "product-owner", gate: "G0" },
  { file: "agents/roles/pm.md", name: "pm", gate: "G1" },
  { file: "agents/roles/architect.md", name: "architect", gate: "G2" },
  { file: "agents/roles/workflow-designer.md", name: "workflow-designer", gate: "G1.5" },
  { file: "agents/roles/implementer.md", name: "implementer", gate: "G3" },
  { file: "agents/roles/verifier.md", name: "verifier", gate: "G4", fresh: true },
  { file: "agents/roles/reviewer.md", name: "reviewer", gate: "G5", fresh: true },
  { file: "agents/roles/release-manager.md", name: "release-manager", gate: "G6/G7" },
  { file: "agents/roles/scribe.md", name: "scribe", gate: "G7" },
];

for (const role of ROLES) {
  check(`role:${role.name}`, () => {
    const text = readRequired(role.file);
    const sections = sectionsOf(text).map((s) => s.title);
    const missing = ROLE_SECTIONS.filter((s) => !sections.some((t) => t.startsWith(s)));
    if (missing.length > 0) throw new Error(`六段缺失：${missing.join(", ")}`);

    const forbid = sectionBody(text, "禁止事项");
    const forbidItems = forbid.split("\n").filter((l) => /^\d+\.\s+/.test(l.trim())).length;
    if (forbidItems < 3) throw new Error(`禁止事项不足 3 条（实际 ${forbidItems}）`);

    const done = sectionBody(text, "完成判据");
    const checks = (done.match(/^- \[ \]/gm) ?? []).length;
    if (checks < 3) throw new Error(`完成判据 checkbox 不足 3 个（实际 ${checks}）`);

    const report = sectionBody(text, "回报格式");
    if (!report.includes("一句话")) throw new Error("回报格式缺少「一句话」状态行");

    const output = sectionBody(text, "输出");
    if (!/路径|位置|GitHub|labels|PR/.test(output)) throw new Error("输出段未给出具体产物路径/位置");

    if (!/G[0-7]/.test(text)) throw new Error("未声明所属门禁（需含 G0–G7 之一）");

    if (/TODO|TBD|（待补）|\(待补\)/.test(text)) throw new Error("含未完成占位符 TODO/TBD/待补");

    if (role.fresh) {
      mustInclude(text, ["新上下文", "不采信"], "独立验证纪律");
    }

    const lines = text.split("\n").length;
    return `${ROLE_SECTIONS.length} 段齐全，禁止 ${forbidItems} 条，判据 ${checks} 项，${lines} 行`;
  });
}

/* ------------------------------------------------------------------ */
/* 2) 流程文档与关键词                                                  */
/* ------------------------------------------------------------------ */

const DOCS = [
  {
    file: "docs/process/00-OPERATING-MODEL.md",
    keywords: ["G0", "G7", "RACI", "用户只做 3 件事", "intake", "watch", "status", "状态机", "权限边界", "单账号"],
    gate: "流程总入口",
  },
  {
    file: "docs/process/01-REQUIREMENT-INTAKE.md",
    keywords: ["DoR", "验收口径", "字段", "标签", "澄清", "issue"],
    gate: "G0/G1",
  },
  {
    file: "docs/process/02-DESIGN-RFC.md",
    keywords: ["RFC", "ADR", "触发条件", "模板", "评审"],
    gate: "G2",
  },
  {
    file: "docs/process/03-IMPLEMENTATION.md",
    keywords: ["Conventional Commits", "worktree", "写域", "commit", "失败"],
    gate: "G3",
  },
  {
    file: "docs/process/04-VERIFICATION.md",
    keywords: ["退出码", "原始输出", "PASS", "FAIL", "YELLOW", "独立", "反例"],
    gate: "G4",
  },
  {
    file: "docs/process/05-REVIEW-MERGE.md",
    keywords: ["required checks", "CODEOWNERS", "squash", "保护分支", "打回", "单账号", "VERDICT: APPROVE"],
    gate: "G5/G6",
  },
  {
    file: "docs/process/06-RELEASE.md",
    keywords: ["SemVer", "CHANGELOG", "tag", "回滚", "发布后验证"],
    gate: "G7",
  },
  {
    file: "docs/process/07-DELIVERY-REPORT.md",
    keywords: ["做了什么", "证据", "已知限制", "剩余风险", "待决策", "验收"],
    gate: "G7 交付",
  },
  {
    file: "docs/process/08-METRICS.md",
    keywords: ["lead time", "CI 通过率", "一次通过率", "返工率", "UNCOLLECTED", "gh run list"],
    gate: "度量",
  },
  {
    file: "docs/process/09-ESCALATION.md",
    keywords: ["不可逆", "法务", "凭据", "超时", "E-01", "升级矩阵", "403"],
    gate: "升级",
  },
  {
    file: "docs/process/10-DSH-LOCAL-AGENTS.md",
    keywords: [
      "dsh headless",
      "MOCL_AGENT_CMD",
      ".agentspec/runs/",
      "worktree",
      "intake",
      "deliver",
      "verify",
      "watch",
      "status",
      "runner",
    ],
    gate: "运行时",
  },
  {
    file: "docs/process/11-CONVERSATION-MODE.md",
    keywords: ["对话", "业务方", "自然语言", "不需要打开 GitHub", "交付报告", "后台", "升级", "Go / No-Go", "Direction", "workflow-designer", "UNCOLLECTED", "反例"],
    gate: "对话式交付 + 最小人类参与",
  },
];

check("docs:process-files", () => {
  const missing = DOCS.filter((d) => !existsSync(rel(d.file))).map((d) => d.file);
  if (missing.length > 0) throw new Error(`缺少流程文档：${missing.join(", ")}`);
  return `${DOCS.length} 份`;
});

for (const doc of DOCS) {
  check(`doc:${doc.file.split("/").pop()}`, () => {
    const text = readRequired(doc.file);
    mustInclude(text, doc.keywords, doc.file);
    return `${doc.gate}，关键词 ${doc.keywords.length} 个齐全`;
  });
}

check("gates:G0-G7", () => {
  const text = readRequired("docs/process/00-OPERATING-MODEL.md");
  const missing = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"].filter((g) => !text.includes(g));
  if (missing.length > 0) throw new Error(`门禁缺失：${missing.join(", ")}`);
  return "G0–G7 全部出现";
});

/* ------------------------------------------------------------------ */
/* 3) CLI 契约与门禁 ID                                                 */
/* ------------------------------------------------------------------ */

check("process:conversation-mode", () => {
  const mode = readRequired("docs/process/11-CONVERSATION-MODE.md");
  mustInclude(mode, ["G0", "G7", "验收通过", "不变量"], "11 对话式模式");
  const model = readRequired("docs/process/00-OPERATING-MODEL.md");
  mustInclude(model, ["11-CONVERSATION-MODE.md", "对话式"], "00 引用对话式入口");
  const intake = readRequired("docs/process/01-REQUIREMENT-INTAKE.md");
  mustInclude(intake, ["对话录入", "11-CONVERSATION-MODE.md"], "01 对话录入映射");
  return "11 对话式文档 + 00/01 交叉引用齐全";
});

check("process:decision-only", () => {
  const mode = readRequired("docs/process/11-CONVERSATION-MODE.md");
  mustInclude(
    mode,
    ["Go / No-Go", "Direction", "workflow-designer", "先跑红", "UNCOLLECTED", "反例", "质量保证", "人类决策点"],
    "11 最小人类参与",
  );
  const designer = readRequired("agents/roles/workflow-designer.md");
  mustInclude(designer, ["PLAN.md", "切片", "验收命令", "禁止"], "workflow-designer 角色");
  const model = readRequired("docs/process/00-OPERATING-MODEL.md");
  mustInclude(model, ["workflow-designer", "最小人类参与"], "00 最小人类参与原则");
  return "最小人类参与（决策式）+ workflow-designer 已写入 00/11 与角色文件";
});

check("cli:contract", () => {
  const cli = ["intake", "deliver", "verify", "watch", "status"];
  const docsText = readRequired("docs/process/10-DSH-LOCAL-AGENTS.md");
  const readme = readRequired("agents/README.md");
  const missingDocs = cli.filter((c) => !docsText.includes(`cli.mjs ${c}`) && !docsText.includes(c));
  if (missingDocs.length > 0) throw new Error(`10-DSH-LOCAL-AGENTS.md 缺 CLI 名：${missingDocs.join(", ")}`);
  const missingReadme = cli.filter((c) => !readme.includes(c));
  if (missingReadme.length > 0) throw new Error(`agents/README.md 缺 CLI 名：${missingReadme.join(", ")}`);
  return "intake|deliver|verify|watch|status 双处一致";
});

check("gates:G4-C1..C11", () => {
  const text = readRequired("docs/process/04-VERIFICATION.md");
  const missing = [];
  for (let i = 1; i <= 11; i += 1) if (!text.includes(`G4-C${i}`)) missing.push(`G4-C${i}`);
  if (missing.length > 0) throw new Error(`门禁 ID 缺失：${missing.join(", ")}`);
  return "G4-C1..C11 齐全";
});

check("gates:commands-exist", () => {
  const text = readRequired("docs/process/04-VERIFICATION.md");
  const mustExist = [
    "tools/validate-abi.mjs",
    "tools/sync-schema.mjs",
    "e2e/pr-scenario.mjs",
    "tools/check_docs.py",
    "tools/build-plugin-package.mjs",
    "agents/verify-agents.mjs",
  ];
  const missingMention = mustExist.filter((f) => !text.includes(f));
  if (missingMention.length > 0) throw new Error(`04 未引用命令：${missingMention.join(", ")}`);
  const missingFile = mustExist.filter((f) => !existsSync(rel(f)));
  if (missingFile.length > 0) throw new Error(`04 引用了不存在的文件：${missingFile.join(", ")}`);
  return `${mustExist.length} 条命令文件全部存在`;
});

check("gates:pending-by-owner", () => {
  const text = readRequired("docs/process/04-VERIFICATION.md");
  const pending = ["tools/leak-scan.mjs", ".github/scripts/verify-github-config.mjs", "orchestrator/test/"];
  const missing = pending.filter((p) => !text.includes(p));
  if (missing.length > 0) throw new Error(`04 缺并行切片门禁引用：${missing.join(", ")}`);
  return "R1/R2/R4 门禁均已在清单引用";
});

check("package:scripts", () => {
  const pkg = JSON.parse(readRequired("package.json"));
  const scripts = pkg.scripts ?? {};
  for (const s of ["typecheck", "test", "validate"]) {
    if (!scripts[s]) throw new Error(`package.json 缺 script：${s}`);
  }
  return `typecheck/test/validate 均存在（version=${pkg.version}）`;
});

/* ------------------------------------------------------------------ */
/* 3.5) RFC/ADR 目录、标签真源、单人评审契约                            */
/* ------------------------------------------------------------------ */

check("docs:rfc-adr-readme", () => {
  const targets = [
    { file: "docs/rfc/README.md", keywords: ["NNNN-<slug>.md", "模板", "索引"] },
    { file: "docs/adr/README.md", keywords: ["NNNN-<slug>.md", "模板", "索引"] },
  ];
  for (const t of targets) {
    const text = readRequired(t.file);
    mustInclude(text, t.keywords, t.file);
  }
  return "docs/rfc + docs/adr 目录说明与模板骨架齐全";
});

const LABEL_REQUIRED = [
  "agent:ready",
  "agent:running",
  "agent:review",
  "agent:blocked",
  "status/needs-triage",
  "status/needs-info",
  "status/in-progress",
  "status/in-review",
  "status/blocked",
  "status/done",
  "status/accepted",
];

check("labels:source-of-truth", () => {
  const labelsYml = readRequired(".github/labels.yml");
  const missingInYml = LABEL_REQUIRED.filter((l) => !labelsYml.includes(`- name: "${l}"`));
  if (missingInYml.length > 0) throw new Error(`.github/labels.yml 缺标签：${missingInYml.join(", ")}`);
  const model = readRequired("docs/process/00-OPERATING-MODEL.md");
  const missingInDoc = LABEL_REQUIRED.filter((l) => !model.includes(l));
  if (missingInDoc.length > 0) throw new Error(`00-OPERATING-MODEL.md 未声明标签：${missingInDoc.join(", ")}`);
  return `${LABEL_REQUIRED.length} 个机器标签在 labels.yml 与 00 中一致`;
});

check("labels:no-legacy-colon", () => {
  const files = [...DOCS.map((d) => d.file), ...ROLES.map((r) => r.file), "agents/README.md"];
  const legacy = /status:[a-z]|priority:p[0-9]|risk:\*|type:\*|area:\*/;
  const hits = files.filter((f) => legacy.test(readRequired(f)));
  if (hits.length > 0) throw new Error(`仍使用遗留冒号式标签命名：${hits.join(", ")}`);
  return "无遗留冒号式标签命名";
});

check("review:single-account-contract", () => {
  const doc = readRequired("docs/process/05-REVIEW-MERGE.md");
  mustInclude(doc, ["单账号", "VERDICT: APPROVE", "scripts/provision-github.sh", "M-1"], "05 单人维护模式");
  const esc = readRequired("docs/process/09-ESCALATION.md");
  mustInclude(esc, ["403", "provision-github.sh"], "09 平台约束");
  const model = readRequired("docs/process/00-OPERATING-MODEL.md");
  mustInclude(model, ["单账号", "VERDICT: APPROVE"], "00 RACI 评审出口");
  return "单账号评审（PR 评论 VERDICT）与 403 约束已写入 00/05/09";
});

/* ------------------------------------------------------------------ */
/* 4) 索引覆盖与泄漏防线                                                */
/* ------------------------------------------------------------------ */

check("index:agent-roles", () => {
  const readme = readRequired("agents/README.md");
  const missing = ROLES.filter((r) => !readme.includes(r.name)).map((r) => r.name);
  if (missing.length > 0) throw new Error(`agents/README.md 未索引角色：${missing.join(", ")}`);
  return `${ROLES.length} 个角色全部索引`;
});

// 泄漏模式在运行时拼接：避免本文件自身成为 leak-scan 的命中源
const DOT = ".";
const USER_HOME_PREFIX = ["", "Users", ""].join("/");
const FORBIDDEN = [
  USER_HOME_PREFIX,
  [DOT, "astra", "/"].join(""),
  ["HAND", "OFF"].join(""),
  ["STATUS", DOT, "md"].join(""),
  ["INSTALL", "-MOCL"].join(""),
  ["config", DOT, "local"].join(""),
];
const SCAN_FILES = [
  ...ROLES.map((r) => r.file),
  "agents/README.md",
  ...DOCS.map((d) => d.file),
  "docs/rfc/README.md",
  "docs/adr/README.md",
];

check("leak:process-assets", () => {
  const hits = [];
  for (const f of SCAN_FILES) {
    const text = readRequired(f);
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push(`${f} ← ${token}`);
    }
  }
  if (hits.length > 0) throw new Error(`命中泄漏字面量：${hits.join("; ")}`);
  return `${SCAN_FILES.length} 文件 × ${FORBIDDEN.length} 模式 无命中`;
});

check("leak:roles-no-absolute-path", () => {
  const hits = [];
  for (const r of ROLES) {
    const text = readRequired(r.file);
    if (/\/Users\/[A-Za-z]/.test(text)) hits.push(r.file);
  }
  if (hits.length > 0) throw new Error(`角色文件含个人绝对路径：${hits.join(", ")}`);
  return "8 角色无个人绝对路径字面量";
});

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

const total = passes.length + failures.length;
console.log("");
console.log(
  `[verify-agents] checks=${total} passed=${passes.length} failed=${failures.length} ` +
    `roles=${ROLES.length} docs=${DOCS.length}`,
);

if (failures.length > 0) {
  console.log("[verify-agents] FAILED");
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

console.log("[verify-agents] ALL CHECKS PASSED");
console.log("[verify-agents] 角色六段 / 流程 12 篇 / G0–G7 / CLI intake|deliver|verify|watch|status 一致");
process.exit(0);
