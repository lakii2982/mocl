#!/usr/bin/env node
/**
 * sync-labels.mjs — 把 .github/labels.yml（标签唯一真源）同步到 GitHub 仓库。
 *
 * 设计原则：
 *   1. 零依赖：YAML 用本仓 lib/yaml-lite.mjs 解析，不引入第三方包；
 *   2. 默认无副作用：不给模式时直接用法错误，必须显式选 --dry-run 或 --apply；
 *   3. --dry-run 完全离线：只校验 labels.yml 并打印计划，不调用 gh、不读远端；
 *   4. --apply 才写 GitHub：先读远端 → 计算 diff → 逐个 create/edit，最后打印汇总；
 *      不做删除（prune）——删标签会静默丢掉 issue/PR 上的历史标记，必须人工确认；
 *   5. --check 只做静态校验（类别齐全 / 名称唯一 / 颜色合法 / agent:ready 存在），CI 与本地都能跑。
 *
 * 用法：
 *   node .github/scripts/sync-labels.mjs --dry-run
 *   node .github/scripts/sync-labels.mjs --check
 *   node .github/scripts/sync-labels.mjs --apply [--repo owner/name]
 *   node .github/scripts/sync-labels.mjs --dry-run --json
 *
 * 退出码：0 成功；1 校验/同步失败；2 用法错误。
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseYaml } from "./lib/yaml-lite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const LABELS_FILE = join(ROOT, ".github", "labels.yml");

/** 标签类别 → 前缀（agent 用冒号，R3/R4 契约消费 agent:ready；其余用斜杠）。 */
export const LABEL_CATEGORIES = {
  "type": { prefix: "type/", color: "0e8a16" },
  "area": { prefix: "area/", color: "1d76db" },
  "priority": { prefix: "priority/", color: "fbca04" },
  "status": { prefix: "status/", color: "5319e7" },
  "agent": { prefix: "agent:", color: "0366d6" },
  "size": { prefix: "size/", color: "ededed" },
};

/**
 * 治理类标签：不属于业务六类（type/area/priority/status/agent/size），
 * 但流程门禁强制要求存在（规则自修改保护 R-10）。
 * 目前只有 needs-human-review；新增治理标签必须同时更新 docs/process/00 §6 与 05。
 */
export const GOVERNANCE_LABELS = new Set(["needs-human-review"]);

/** 读取并解析 labels.yml。 */
export function loadLabels(file = LABELS_FILE) {
  const text = readFileSync(file, "utf8");
  const parsed = parseYaml(text, file);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是数组（- name/color/description）`);
  }
  return parsed;
}

/**
 * 静态校验标签定义。被 verify-github-config.mjs 复用，保证「校验口径只有一处」。
 * @param {unknown} labels
 * @returns {{errors: string[], warnings: string[], counts: Record<string, number>}}
 */
export function validateLabels(labels) {
  const errors = [];
  const warnings = [];
  const counts = {};
  if (!Array.isArray(labels)) {
    return { errors: ["labels.yml 顶层必须是数组"], warnings, counts };
  }
  if (labels.length === 0) errors.push("labels.yml 为空，标签体系缺失");

  const seen = new Set();
  for (const [index, label] of labels.entries()) {
    const where = `labels.yml[${index}]`;
    if (label === null || typeof label !== "object" || Array.isArray(label)) {
      errors.push(`${where} 必须是映射（name/color/description）`);
      continue;
    }
    const name = label.name;
    const color = label.color;
    const description = label.description;
    if (typeof name !== "string" || name.trim() === "") {
      errors.push(`${where} 缺少 name`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9:._/-]*$/u.test(name)) {
      errors.push(`${where} 名称不合规（小写字母/数字/:/./_/-）：${name}`);
    }
    if (seen.has(name)) errors.push(`标签名重复：${name}`);
    seen.add(name);
    if (typeof color !== "string" || !/^[0-9a-fA-F]{6}$/u.test(color)) {
      errors.push(`${name} 的 color 必须是 6 位十六进制（不带 #）：${String(color)}`);
    }
    if (typeof description !== "string" || description.trim().length < 4) {
      warnings.push(`${name} 缺少有意义的 description（GitHub 上会显示为空）`);
    }
    const category = Object.keys(LABEL_CATEGORIES).find((key) =>
      name.startsWith(LABEL_CATEGORIES[key].prefix),
    );
    if (!category) {
      if (!GOVERNANCE_LABELS.has(name)) {
        errors.push(
          `${name} 不属于任何约定类别（${Object.values(LABEL_CATEGORIES).map((item) => item.prefix).join(" / ")}）或治理类标签（${[...GOVERNANCE_LABELS].join(" / ")}）`,
        );
      }
    } else {
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }

  for (const [category, meta] of Object.entries(LABEL_CATEGORIES)) {
    if ((counts[category] ?? 0) === 0) errors.push(`标签体系缺少 ${meta.prefix}* 类别`);
  }
  if (!seen.has("agent:ready")) {
    errors.push("缺少 agent:ready：orchestrator 只认该标签派发任务（R3/R4 契约），缺失会导致流程无法启动");
  }
  return { errors, warnings, counts };
}

function runGh(args) {
  return spawnSync("gh", args, { encoding: "utf8", timeout: 120_000 });
}

function ensureGh() {
  const probe = runGh(["--version"]);
  if (probe.error || probe.status !== 0) {
    return `未找到可用的 gh CLI（${probe.error?.message ?? probe.stderr?.trim() ?? "unknown"}）；--apply 需要 gh 登录且对仓库有 admin 权限`;
  }
  return null;
}

function fetchRemoteLabels(repoArgs) {
  const result = runGh(["label", "list", "--limit", "200", "--json", "name,color,description", ...repoArgs]);
  if (result.status !== 0) {
    throw new Error(`gh label list 失败：${(result.stderr || result.stdout || "").trim()}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("gh label list 返回的不是数组");
  return parsed;
}

function normalizeColor(color) {
  return String(color ?? "").replace(/^#/u, "").toLowerCase();
}

/** 计算同步计划（纯函数，可测）。 */
export function buildPlan(local, remote) {
  const remoteByName = new Map(remote.map((label) => [label.name, label]));
  const plan = { create: [], update: [], unchanged: [] };
  for (const label of local) {
    const current = remoteByName.get(label.name);
    if (!current) {
      plan.create.push(label);
      continue;
    }
    const sameColor = normalizeColor(current.color) === normalizeColor(label.color);
    const sameDescription = String(current.description ?? "") === String(label.description ?? "");
    if (sameColor && sameDescription) plan.unchanged.push(label);
    else plan.update.push(label);
  }
  return plan;
}

function printPlan(plan, { dryRun, json }) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          create: plan.create.map((label) => label.name),
          update: plan.update.map((label) => label.name),
          unchanged: plan.unchanged.map((label) => label.name),
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const label of plan.create) {
    console.log(`  + create  ${label.name}  (#${label.color})  ${label.description}`);
  }
  for (const label of plan.update) {
    console.log(`  ~ update  ${label.name}  (#${label.color})  ${label.description}`);
  }
  console.log(
    `[labels] 计划：create ${plan.create.length}，update ${plan.update.length}，unchanged ${plan.unchanged.length}` +
      (dryRun ? "（dry-run：未读取远端，apply 时会按远端实际状态重新计算）" : ""),
  );
}

function applyPlan(plan, repoArgs) {
  let failures = 0;
  for (const label of plan.create) {
    const result = runGh([
      "label",
      "create",
      label.name,
      "--color",
      normalizeColor(label.color),
      "--description",
      label.description,
      ...repoArgs,
    ]);
    if (result.status === 0) {
      console.log(`  created  ${label.name}`);
    } else {
      failures += 1;
      console.error(`  FAILED   create ${label.name}：${(result.stderr || result.stdout || "").trim()}`);
    }
  }
  for (const label of plan.update) {
    const result = runGh([
      "label",
      "edit",
      label.name,
      "--color",
      normalizeColor(label.color),
      "--description",
      label.description,
      ...repoArgs,
    ]);
    if (result.status === 0) {
      console.log(`  updated  ${label.name}`);
    } else {
      failures += 1;
      console.error(`  FAILED   update ${label.name}：${(result.stderr || result.stdout || "").trim()}`);
    }
  }
  return failures;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--apply") args.apply = true;
    else if (token === "--check") args.check = true;
    else if (token === "--json") args.json = true;
    else if (token === "--repo") args.repo = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`用法：
  node .github/scripts/sync-labels.mjs --check              只做静态校验（离线）
  node .github/scripts/sync-labels.mjs --dry-run [--json]  离线打印计划，不写 GitHub
  node .github/scripts/sync-labels.mjs --apply [--repo owner/name]
                                                           读远端 → diff → create/edit（需要 gh 登录）
说明：不做删除（prune）；标签真源是 .github/labels.yml。`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.check + Boolean(args.dryRun) + Boolean(args.apply) > 1) {
    console.error("[labels] --check / --dry-run / --apply 只能三选一");
    return 2;
  }
  if (!args.check && !args.dryRun && !args.apply) {
    console.error("[labels] 必须显式选择 --check / --dry-run / --apply（默认不做任何事，防止误写 GitHub）");
    usage();
    return 2;
  }

  let labels;
  try {
    labels = loadLabels();
  } catch (error) {
    console.error(`[labels] 无法解析 labels.yml：${error.message}`);
    return 1;
  }
  const { errors, warnings, counts } = validateLabels(labels);
  const summary = Object.entries(counts)
    .map(([category, count]) => `${category}=${count}`)
    .join(" / ");
  console.log(`[labels] 本地标签 ${labels.length} 个（${summary}）`);
  for (const warning of warnings) console.warn(`[labels] WARN ${warning}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[labels] FAIL ${error}`);
    console.error(`[labels] 校验失败：${errors.length} 项`);
    return 1;
  }
  console.log("[labels] 静态校验通过（名称唯一 / 颜色合法 / 类别齐全 / agent:ready 存在）");
  if (args.check) return 0;

  if (args.dryRun) {
    console.log("[labels] DRY-RUN：不调用 gh、不读取远端、不写入 GitHub");
    printPlan(
      { create: labels, update: [], unchanged: [] },
      { dryRun: true, json: args.json },
    );
    console.log("[labels] dry-run OK（零副作用）");
    return 0;
  }

  // --apply
  const ghProblem = ensureGh();
  if (ghProblem) {
    console.error(`[labels] ${ghProblem}`);
    return 1;
  }
  const repoArgs = args.repo ? ["--repo", args.repo] : [];
  console.log(`[labels] 读取远端标签${args.repo ? `（${args.repo}）` : ""}…`);
  let remote;
  try {
    remote = fetchRemoteLabels(repoArgs);
  } catch (error) {
    console.error(`[labels] ${error.message}`);
    return 1;
  }
  const plan = buildPlan(labels, remote);
  printPlan(plan, { dryRun: false, json: args.json });
  const failures = applyPlan(plan, repoArgs);
  if (failures > 0) {
    console.error(`[labels] 同步失败：${failures} 个标签未成功`);
    return 1;
  }
  console.log("[labels] 同步完成（未删除任何远端标签）");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
