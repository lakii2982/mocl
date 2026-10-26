#!/usr/bin/env node
/**
 * check-pr.mjs — PR 契约机械校验（process-guard 的核心，零依赖）。
 *
 * 被 .github/workflows/process-guard.yml 调用；也可在本地对任意 PR body 复跑。
 * 只读 PR 的标题与正文文本，不执行 PR 里的任何代码/命令。
 *
 * 用法：
 *   node .github/scripts/check-pr.mjs --body-file pr.md --title "feat(ci): ..."
 *   node .github/scripts/check-pr.mjs --json pr.json          # gh api ... --jq '{title,body}' 的产物
 *   node .github/scripts/check-pr.mjs --body-file pr.md --title "..." --number 42
 *   node .github/scripts/check-pr.mjs --self-test             # 正向 + 反向用例自检，CI 必须绿
 *
 * 退出码：0 = 通过；1 = 契约不满足；2 = 用法/输入错误。
 *
 * 契约来源（唯一真源）：docs/process/04-VERIFICATION.md（证据协议）、
 * 05-REVIEW-MERGE.md（评审与合并）、.github/PULL_REQUEST_TEMPLATE.md、
 * orchestrator/templates/pr-body.md（agent 自动生成的 PR 也是同一契约）。
 *
 * 硬校验（不满足即红）：
 *   1. 正文非空（去 HTML 注释后 ≥40 可见字符）；
 *   2. 必需小节：关联 issue / 证据表（或「验证证据」）/ 风险与回滚；
 *   3. 关联 issue：Closes/Fixes/Resolves/Refs #N（N ≥ 1）；
 *   4. 证据表：表头含「命令」「退出码」；至少 1 行退出码为 0（真跑证据）；
 *      非零数字退出码 → 红；SKIP/N/A/planned 只能作为声明性豁免，不能替代绿证据；
 *      未替换的 `{{变量}}` 或 `<命令>` 占位符 → 红；
 *   5. 标题符合 Conventional Commits；
 *   6. 检查清单（若存在）：至少 1 项已勾选（允许「CI 绿/评审通过」等流程项未勾，
 *      因为本门禁在 G3 创建 PR 时就会跑，G5/G6 前才需要全勾）。
 *
 * 建议小节（缺失只告警，不阻塞）：变更摘要/交付内容、门禁（G0–G7）、文档更新。
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** 硬必需小节（与 R3 流程文档 + R4 orchestrator PR body 契约一致）。 */
const REQUIRED_SECTIONS = [
  { id: "linked-issue", label: "关联 issue", re: /^#{2,3}[ \t]*关联[ \t]*[Ii]ssue[ \t]*$/mu },
  { id: "evidence", label: "证据表", re: /^#{2,3}[ \t]*(?:证据表|验证证据)[ \t]*$/mu },
  { id: "risk", label: "风险与回滚", re: /^#{2,3}[ \t]*风险与回滚[ \t]*$/mu },
];

/** 建议小节（缺失只 WARN；orchestrator 自动 PR 可能没有「文档更新/门禁」）。 */
const RECOMMENDED_SECTIONS = [
  { id: "summary", label: "变更摘要 / 交付内容", re: /^#{2,3}[ \t]*(?:变更摘要|交付内容)[ \t]*$/mu },
  { id: "gates", label: "门禁（G0–G7）", re: /^#{2,3}[ \t]*门禁[^\n]*$/mu },
  { id: "docs", label: "文档更新", re: /^#{2,3}[ \t]*文档更新[ \t]*$/mu },
];

const CHECKLIST_SECTION = /^#{2,3}[ \t]*(?:检查清单|Checklist)[ \t]*$/mu;

const CONVENTIONAL_TITLE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|release)(\([a-z0-9][a-z0-9._/-]*\))?!?:[ \t]+\S.{2,}$/u;

const LINKED_ISSUE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|ref)\s*:?\s*#(\d+)/iu;
const ANY_ISSUE_REF = /#(\d+)/u;
const PLACEHOLDER = /<(?:command|命令|退出码|关键输出[^>]*)>/iu;
const UNRENDERED_TEMPLATE_VAR = /\{\{[^}\n]+\}\}/u;
const DECLARED_SKIP = /^(?:SKIP|N\/A|n\/a|—|-|planned|PLANNED)$/u;

/** 按二级/三级标题切出小节正文。 */
export function extractSection(body, re) {
  const match = re.exec(body);
  if (!match) return null;
  const rest = body.slice(match.index + match[0].length);
  const next = /^#{2,3}[ \t]+\S.*$/mu.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function stripBackticks(cell) {
  return cell.replace(/`/gu, "").trim();
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => stripBackticks(cell));
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

/**
 * 校验一个 PR。
 * @param {{title?: string, body?: string, number?: number|string}} pr
 * @returns {{ok: boolean, errors: string[], warnings: string[], checks: {name: string, ok: boolean, detail: string}[]}}
 */
export function validatePr(pr) {
  const title = typeof pr.title === "string" ? pr.title.trim() : "";
  const body = typeof pr.body === "string" ? pr.body : "";
  const errors = [];
  const warnings = [];
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) errors.push(`${name}：${detail}`);
  };

  // 0. 基础：正文不能为空（去掉 HTML 注释后至少 40 个可见字符，防止只贴模板骨架）。
  const visibleBody = body.replace(/<!--[\s\S]*?-->/gu, "").replace(/\s+/gu, "");
  add("正文非空", visibleBody.length >= 40, `可见字符数=${visibleBody.length}（要求 ≥40）`);
  if (visibleBody.length < 40) {
    return { ok: false, errors, warnings, checks };
  }

  // 1. 必需小节。
  const sections = {};
  for (const def of REQUIRED_SECTIONS) sections[def.id] = extractSection(body, def.re);
  const missing = REQUIRED_SECTIONS.filter((def) => sections[def.id] === null).map((def) => def.label);
  add(
    "必需小节",
    missing.length === 0,
    missing.length === 0
      ? `${REQUIRED_SECTIONS.length}/${REQUIRED_SECTIONS.length} 齐全（关联 issue / 证据表 / 风险与回滚）`
      : `缺少 ${missing.join("、")}`,
  );

  // 建议小节（只告警）。
  for (const def of RECOMMENDED_SECTIONS) {
    if (extractSection(body, def.re) === null) warnings.push(`建议补充「${def.label}」小节（不阻塞，但 G5 评审会关注）`);
  }

  // 2. 关联 issue。
  const linkedSection = sections["linked-issue"] ?? "";
  const linkedMatch = LINKED_ISSUE.exec(body);
  const fallbackRef = ANY_ISSUE_REF.exec(linkedSection);
  const issueNumber = linkedMatch
    ? Number.parseInt(linkedMatch[1], 10)
    : fallbackRef
      ? Number.parseInt(fallbackRef[1], 10)
      : 0;
  add(
    "关联 issue",
    Number.isInteger(issueNumber) && issueNumber >= 1,
    issueNumber >= 1 ? `#${issueNumber}` : "未找到 Closes/Fixes/Refs #N（N≥1）",
  );

  // 3. 证据表。
  const evidenceSection = sections["evidence"] ?? "";
  const tableLines = evidenceSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  let headerIndex = -1;
  let header = null;
  for (let i = 0; i < tableLines.length; i += 1) {
    const cells = splitRow(tableLines[i]);
    if (cells.includes("命令") && cells.includes("退出码")) {
      headerIndex = i;
      header = cells;
      break;
    }
  }
  if (headerIndex === -1) {
    add("证据表", false, "未找到含「命令」「退出码」列的表头（格式：| 命令 | 退出码 | 关键输出 |）");
  } else {
    const rows = [];
    for (let i = headerIndex + 1; i < tableLines.length; i += 1) {
      const cells = splitRow(tableLines[i]);
      if (isSeparatorRow(cells)) continue;
      rows.push(cells);
    }
    const commandCol = header.indexOf("命令");
    const exitCol = header.indexOf("退出码");
    const parsed = rows
      .map((cells) => ({
        command: cells[commandCol] ?? "",
        exitCode: cells[exitCol] ?? "",
      }))
      .filter((row) => row.command !== "");
    const green = parsed.filter((row) => row.exitCode === "0");
    const declaredSkip = parsed.filter((row) => DECLARED_SKIP.test(row.exitCode));
    const bad = parsed.filter((row) => row.exitCode !== "0" && !DECLARED_SKIP.test(row.exitCode));
    if (parsed.length === 0) {
      add("证据表", false, "表格无数据行（至少需要 1 条命令 + 退出码 0 的真跑证据）");
    } else if (green.length === 0) {
      add("证据表", false, `没有退出码为 0 的真跑证据（当前 ${parsed.length} 行，SKIP 不得替代绿证据）`);
    } else if (bad.length > 0) {
      add(
        "证据表",
        false,
        `存在非 0/非声明豁免的退出码：${bad.map((row) => `「${row.command}」=${row.exitCode || "<空>"}`).join("；")}`,
      );
    } else {
      add(
        "证据表",
        true,
        `${green.length} 条退出码 0 的证据` + (declaredSkip.length > 0 ? `，${declaredSkip.length} 条声明性 SKIP` : ""),
      );
    }
  }

  // 4. 占位符（模板没填 / 模板变量没渲染）。
  if (PLACEHOLDER.test(body)) add("模板占位符", false, "正文仍含未替换的模板占位符（<command> 等）");
  else if (UNRENDERED_TEMPLATE_VAR.test(body)) add("模板占位符", false, "正文仍含未渲染的模板变量（{{...}}）");
  else add("模板占位符", true, "无占位符");

  // 5. Conventional Commits 标题。
  const titleOk = title.length > 0 && CONVENTIONAL_TITLE.test(title);
  add(
    "标题规范",
    titleOk,
    titleOk ? title : `标题不符合 Conventional Commits：${title || "<空>"}（例：fix(ci): 修复 process-guard 误报）`,
  );

  // 6. 检查清单（若存在）：允许流程项未勾（CI 绿 / 评审通过要到 G5/G6 才成立）。
  const checklistSection = extractSection(body, CHECKLIST_SECTION);
  if (checklistSection === null) {
    warnings.push("未包含「检查清单」小节：建议按 PR 模板补齐自查项");
  } else {
    const items = checklistSection
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^-\s*\[[ xX]\]/u.test(line));
    const checked = items.filter((line) => /^-\s*\[[xX]\]/u.test(line));
    if (items.length === 0) add("检查清单", false, "检查清单小节没有 `- [x]` 条目");
    else if (checked.length === 0) add("检查清单", false, "检查清单一项都未勾选（至少 1 项已完成）");
    else add("检查清单", true, `${checked.length}/${items.length} 项已勾选（流程项可在 G5/G6 前补勾）`);
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}

/** 正向/反向用例自检：既证明「合格的能过」，也证明「不合格的会红」。 */
export function selfTest() {
  const baseBody = [
    "## 关联 issue",
    "",
    "Closes #12 — 修复 process-guard 误报",
    "",
    "## 变更摘要",
    "",
    "- 修复 process-guard 在 PR 正文含代码块时误报的问题",
    "- 补充证据表解析的边界用例",
    "",
    "## 门禁（G0–G7）",
    "",
    "| 门禁 | 状态 | 证据 |",
    "|------|------|------|",
    "| G4 验证 | 通过 | 见下方证据表 |",
    "| G5 评审 | 待评审 | PR review |",
    "| G6 合并 | 待合并 | CI run |",
    "",
    "## 证据表",
    "",
    "| 命令 | 退出码 | 关键输出 |",
    "|------|--------|----------|",
    "| node .github/scripts/verify-github-config.mjs | 0 | ALL CHECKS PASSED：checks=19 failures=0 |",
    "| node .github/scripts/check-pr.mjs --self-test | 0 | 10 条用例全部符合预期 |",
    "",
    "## 风险与回滚",
    "",
    "- 风险：仅影响 PR 门禁脚本，不改运行时行为",
    "- 回滚：revert 本 PR 即可，无数据迁移",
    "",
    "## 文档更新",
    "",
    "- 无需更新（内部门禁脚本，行为与 docs/process/05-REVIEW-MERGE.md 一致）",
    "",
    "## 检查清单",
    "",
    "- [x] PR 标题符合 Conventional Commits",
    "- [x] 已关联 issue 且范围一致",
    "- [x] 证据表为真跑结果",
    "- [x] 已同步文档或说明无需更新",
    "- [x] 无凭据与个人绝对路径",
    "- [x] 未新增依赖",
    "- [x] 写域与任务约定一致",
  ].join("\n");

  // 与 orchestrator/templates/pr-body.md 同构的 agent 自动 PR（含未勾的流程项、SKIP 行）。
  const orchestratorBody = [
    "## 关联 issue",
    "",
    "Closes #12 — 需求标题",
    "",
    "## 交付内容",
    "",
    "- 仓库：`lakii2982/mocl`",
    "- 分支：`agent/12-demo` → `main`",
    "",
    "## 证据表",
    "",
    "| 门禁 | 命令 | 退出码 | 结果 |",
    "| --- | --- | --- | --- |",
    "| `G4-C1` | `pnpm -s typecheck` | 0 | PASS |",
    "| `G4-C2` | `node e2e/pr-scenario.mjs` | 0 | PASS |",
    "| `G4-C3` | `node tools/assert-dsh-tool.mjs` | SKIP | SKIP |",
    "",
    "## 风险与回滚",
    "",
    "- 风险：门禁失败、改动越界、评审不通过",
    "- 回滚：`git revert -m 1 <merge-commit>`",
    "",
    "## 检查清单",
    "",
    "- [x] 本地门禁已运行（见证据表）",
    "- [x] 改动仅限 issue 范围",
    "- [ ] CI 绿（GitHub Actions）",
    "- [ ] 评审通过（verifier + reviewer）",
    "- [ ] 关联 issue 打上 `status:in-review`",
  ].join("\n");

  const valid = { title: "fix(ci): 修复 process-guard 误报并补自检", body: baseBody, number: 7 };
  const cases = [
    { name: "合格 PR 通过", pr: valid, expectOk: true },
    {
      name: "orchestrator 自动生成的 PR（含 SKIP 与未勾流程项）通过",
      pr: { title: "feat(issue-12): 需求标题", body: orchestratorBody, number: 12 },
      expectOk: true,
    },
    {
      name: "缺少关联 issue 被拒",
      pr: { ...valid, body: baseBody.replace("Closes #12 — 修复 process-guard 误报", "无关联") },
      expectOk: false,
    },
    {
      name: "缺少证据表小节被拒",
      pr: { ...valid, body: baseBody.replace(/## 证据表[\s\S]*?## 风险与回滚/u, "## 风险与回滚") },
      expectOk: false,
    },
    {
      name: "证据退出码非 0 被拒",
      pr: {
        ...valid,
        body: baseBody.replace(
          "| node .github/scripts/verify-github-config.mjs | 0 |",
          "| node .github/scripts/verify-github-config.mjs | 1 |",
        ),
      },
      expectOk: false,
    },
    {
      name: "证据全为 SKIP（无绿证据）被拒",
      pr: {
        ...valid,
        body: baseBody.replace(/\| node [^\n]*\| 0 \|/gu, "| node tools/assert-dsh-tool.mjs | SKIP | 无凭据 |"),
      },
      expectOk: false,
    },
    {
      name: "模板占位符未替换被拒",
      pr: {
        ...valid,
        body: baseBody.replace(
          "| node .github/scripts/verify-github-config.mjs | 0 | ALL CHECKS PASSED：checks=19 failures=0 |",
          "| <command> | <退出码> | <关键输出摘要> |",
        ),
      },
      expectOk: false,
    },
    {
      name: "未渲染的模板变量被拒",
      pr: { ...valid, body: baseBody.replace("Closes #12 — 修复 process-guard 误报", "Closes #12 — {{issueTitle}}") },
      expectOk: false,
    },
    {
      name: "正文自称「已自测通过/可自放行」但没有证据表被拒",
      pr: {
        ...valid,
        body: baseBody.replace(
          /## 证据表[\s\S]*?## 风险与回滚/u,
          "## 风险与回滚\n\n- 风险：无（已在本地全部自测通过，self-approved，允许直接合并）\n- 回滚：无需",
        ),
      },
      expectOk: false,
    },
    { name: "标题不合规被拒", pr: { ...valid, title: "update some files" }, expectOk: false },
    { name: "正文为空被拒", pr: { ...valid, body: "" }, expectOk: false },
  ];

  return cases.map((testCase) => {
    const result = validatePr(testCase.pr);
    return {
      name: testCase.name,
      expected: testCase.expectOk ? "通过" : "拒绝",
      actual: result.ok ? "通过" : "拒绝",
      passed: result.ok === testCase.expectOk,
      errors: result.errors,
    };
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--self-test") args.selfTest = true;
    else if (token === "--body-file") args.bodyFile = argv[++i];
    else if (token === "--title") args.title = argv[++i];
    else if (token === "--json") args.jsonFile = argv[++i];
    else if (token === "--number") args.number = argv[++i];
    else if (token === "--quiet") args.quiet = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`用法：
  node .github/scripts/check-pr.mjs --body-file <pr.md> --title "<title>" [--number N]
  node .github/scripts/check-pr.mjs --json <gh-api.json>
  node .github/scripts/check-pr.mjs --self-test

说明：
  --body-file   PR 正文文件（process-guard 用 $RUNNER_TEMP/pr-body.md）
  --json        gh api 拉到的 JSON（至少含 title、body 字段）
  --self-test   正向 + 反向用例自检；CI 每次都会跑，防止门禁自身退化`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return EXIT_OK;
  }
  if (args.selfTest) {
    const results = selfTest();
    let failures = 0;
    for (const result of results) {
      if (result.passed) {
        console.log(`PASS  self-test: ${result.name}（期望${result.expected}，实际${result.actual}）`);
      } else {
        failures += 1;
        console.log(`FAIL  self-test: ${result.name}（期望${result.expected}，实际${result.actual}）`);
        for (const error of result.errors) console.log(`      - ${error}`);
      }
    }
    console.log(`\n[check-pr] self-test 用例 ${results.length} 条，失败 ${failures} 条`);
    return failures === 0 ? EXIT_OK : EXIT_FAIL;
  }

  let title = args.title ?? "";
  let body = "";
  let number = args.number;

  if (args.jsonFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(args.jsonFile, "utf8"));
    } catch (error) {
      console.error(`[check-pr] 无法读取 --json 文件：${args.jsonFile}（${error.message}）`);
      return EXIT_USAGE;
    }
    title = parsed.title ?? title;
    body = parsed.body ?? "";
    number = parsed.number ?? number;
  } else if (args.bodyFile) {
    try {
      body = readFileSync(args.bodyFile, "utf8");
    } catch (error) {
      console.error(`[check-pr] 无法读取 --body-file：${args.bodyFile}（${error.message}）`);
      return EXIT_USAGE;
    }
  } else {
    console.error("[check-pr] 必须提供 --body-file、--json 或 --self-test 之一");
    usage();
    return EXIT_USAGE;
  }

  const result = validatePr({ title, body, number });
  if (!args.quiet) {
    console.log(`[check-pr] PR${number ? ` #${number}` : ""} title=${JSON.stringify(title)}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}：${check.detail}`);
    }
    for (const warning of result.warnings) console.log(`WARN  ${warning}`);
  }
  if (result.ok) {
    console.log("\n[check-pr] PASSED：PR 契约满足（G4/G5 前置条件）");
    return EXIT_OK;
  }
  console.error(`\n[check-pr] FAILED：${result.errors.length} 项不符合契约，按 .github/PULL_REQUEST_TEMPLATE.md 补齐后重新提交`);
  return EXIT_FAIL;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
