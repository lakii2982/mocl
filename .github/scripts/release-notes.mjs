#!/usr/bin/env node
/**
 * release-notes.mjs — 从 CHANGELOG.md 提取指定版本的段落，生成 GitHub Release notes。
 *
 * 为什么不用第三方工具：发布 notes 必须与仓库文档同源（CHANGELOG 是唯一真源），
 * 用 30 行零依赖脚本即可，避免 CI 引入 additional dependency。
 *
 * 用法：
 *   node .github/scripts/release-notes.mjs --tag v0.1.0 --changelog CHANGELOG.md \
 *     --package package.json --out /tmp/release-notes.md
 *   node .github/scripts/release-notes.mjs --tag v0.1.0 --check     # 只校验版本段落存在
 *
 * 硬校验（发布门禁，防止发错版本）：
 *   1. tag 形如 v<semver>；2. package.json 的 version 与 tag 一致；
 *   3. CHANGELOG 存在该版本段落且非空。
 *
 * 退出码：0 成功；1 校验失败；2 用法错误。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--tag") args.tag = argv[++i];
    else if (token === "--changelog") args.changelog = argv[++i];
    else if (token === "--package") args.package = argv[++i];
    else if (token === "--out") args.out = argv[++i];
    else if (token === "--check") args.check = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`用法：
  node .github/scripts/release-notes.mjs --tag v0.1.0 [--changelog CHANGELOG.md] \\
    [--package package.json] [--out notes.md]
  node .github/scripts/release-notes.mjs --tag v0.1.0 --check

说明：
  --tag        git tag（v 前缀可选；版本必须能被 SemVer 解析）
  --changelog  CHANGELOG 路径，默认 CHANGELOG.md
  --package    提供时断言 package.json version 与 tag 一致（发布一致性门禁）
  --out        输出文件；缺省或 "-" 打印到 stdout
  --check      只校验，不输出 notes`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 从 CHANGELOG 文本中提取某个版本的段落（不含标题行）。
 * 支持标题形式：`## [0.1.0] - 2026-10-26`、`## 0.1.0`、`### v0.1.0`、`# [v0.1.0]`。
 * @param {string} changelog
 * @param {string} version
 * @returns {string|null} 段落正文；找不到返回 null
 */
export function extractVersionSection(changelog, version) {
  const escaped = escapeRegExp(version);
  const headingRe = new RegExp(`^(#{1,3})[ \\t]*(?:\\[)?v?${escaped}(?:\\])?[^\\n]*$`, "mu");
  const match = headingRe.exec(changelog);
  if (!match) return null;
  const level = match[1].length;
  const rest = changelog.slice(match.index + match[0].length);
  // 下一个同级或更高级标题即段落结束。
  const nextHeadingRe = new RegExp(`^#{1,${level}}[ \\t]+\\S`, "mu");
  const next = nextHeadingRe.exec(rest);
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  return section === "" ? "" : section;
}

/**
 * 解析 tag → 版本字符串。
 * @param {string} tag
 * @returns {string|null}
 */
export function tagToVersion(tag) {
  if (typeof tag !== "string") return null;
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(tag.trim());
  return match ? match[1] : null;
}

export function buildNotes({ tag, changelog, version }) {
  const section = extractVersionSection(changelog, version);
  if (section === null) {
    throw new Error(`CHANGELOG 中找不到版本 ${version} 的段落（标题需形如 "## [${version}] - YYYY-MM-DD"）`);
  }
  if (section === "") {
    throw new Error(`CHANGELOG 中版本 ${version} 的段落为空，拒绝发布空 notes`);
  }
  return [
    `# MOCL ${tag}`,
    "",
    section,
    "",
    "---",
    "",
    `完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。本 notes 由 \`.github/scripts/release-notes.mjs\` 从 CHANGELOG 自动提取，与仓库文档同源。`,
    "",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (!args.tag) {
    console.error("[release-notes] 缺少 --tag（例：--tag v0.1.0）");
    usage();
    return 2;
  }
  const version = tagToVersion(args.tag);
  if (!version) {
    console.error(`[release-notes] tag 不是合法版本：${args.tag}（期望 v<semver>，如 v0.1.0）`);
    return 1;
  }
  const changelogPath = args.changelog ?? "CHANGELOG.md";
  if (!existsSync(changelogPath)) {
    console.error(`[release-notes] CHANGELOG 不存在：${changelogPath}（发布前必须更新 CHANGELOG）`);
    return 1;
  }
  const changelog = readFileSync(changelogPath, "utf8");

  if (args.package) {
    if (!existsSync(args.package)) {
      console.error(`[release-notes] package 文件不存在：${args.package}`);
      return 1;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(args.package, "utf8"));
    } catch (error) {
      console.error(`[release-notes] 无法解析 ${args.package}：${error.message}`);
      return 1;
    }
    if (pkg.version !== version) {
      console.error(
        `[release-notes] 版本不一致：tag 对应 ${version}，但 ${args.package} 的 version=${String(pkg.version)}；` +
          "请先同步版本再打 tag",
      );
      return 1;
    }
  }

  let notes;
  try {
    notes = buildNotes({ tag: args.tag, changelog, version });
  } catch (error) {
    console.error(`[release-notes] ${error.message}`);
    return 1;
  }

  if (args.check) {
    console.log(`[release-notes] check OK：version=${version}，CHANGELOG 段落存在且非空（${notes.length} 字符）`);
    return 0;
  }
  if (!args.out || args.out === "-") {
    process.stdout.write(notes);
  } else {
    writeFileSync(args.out, notes, "utf8");
    console.log(`[release-notes] 已生成 ${args.out}（version=${version}，${notes.length} 字符）`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
