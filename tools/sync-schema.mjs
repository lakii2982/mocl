#!/usr/bin/env node
/**
 * sync-schema.mjs — 把设计包（只读真源）的 ABI JSON Schema 同步到施工仓。
 *
 * 真源：`../docs/abi/schema/*.json`（设计包，施工阶段只读）
 * 产物：`./schema/*.json`（随仓库提交，供运行时校验与 validate 使用）
 *
 * 行为：
 *   - 源目录缺失 → 打印原因并以非零退出（不是「没有变化」）。
 *   - 逐字节比对；不一致则复制，并打印差异摘要（文件、行数、前几处差异行）。
 *   - 已一致则打印 up-to-date；重复执行幂等。
 *   - 源目录内非 *.json 或额外的旧文件：只告警，不删除（避免误删施工产物）。
 *
 * 用法：node tools/sync-schema.mjs [--check]
 *   --check 只检查不写入；有差异时退出码 1（CI 用）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sourceDir = resolve(repoRoot, "..", "docs", "abi", "schema");
const targetDir = resolve(repoRoot, "schema");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

function fail(msg) {
  console.error(`[sync-schema] ERROR: ${msg}`);
  process.exit(1);
}

if (!existsSync(sourceDir)) {
  fail(
    `设计包 schema 目录不存在: ${sourceDir}\n` +
      "  sync 必须从设计包工作区运行（impl/ 的上级目录需含 docs/abi/schema/）。",
  );
}

mkdirSync(targetDir, { recursive: true });

const sourceFiles = readdirSync(sourceDir)
  .filter((f) => f.endsWith(".json"))
  .sort();
if (sourceFiles.length === 0) fail(`设计包 schema 目录为空: ${sourceDir}`);

const expected = new Set(sourceFiles);
const stale = readdirSync(targetDir)
  .filter((f) => f.endsWith(".json") && !expected.has(f))
  .sort();

let changed = 0;
let same = 0;
const diffs = [];

for (const name of sourceFiles) {
  const srcPath = join(sourceDir, name);
  const dstPath = join(targetDir, name);
  const src = readFileSync(srcPath);
  const dst = existsSync(dstPath) ? readFileSync(dstPath) : null;

  if (dst !== null && Buffer.compare(src, dst) === 0) {
    same += 1;
    continue;
  }
  changed += 1;
  diffs.push({
    name,
    srcBytes: src.length,
    dstBytes: dst === null ? 0 : dst.length,
    missing: dst === null,
    lines: diffSummary(dst, src),
  });
  if (!checkOnly) writeFileSync(dstPath, src);
}

function diffSummary(oldBuf, newBuf) {
  const newLines = newBuf.toString("utf8").split("\n");
  if (oldBuf === null) {
    return { oldLineCount: 0, newLineCount: newLines.length, samples: [] };
  }
  const oldLines = oldBuf.toString("utf8").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const out = [];
  for (let i = 0; i < max && out.length < 5; i += 1) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    out.push({ line: i + 1, before: trim(a), after: trim(b) });
  }
  return {
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    samples: out,
  };
}

function trim(s) {
  if (s === undefined) return "<missing>";
  return s.length <= 120 ? s : `${s.slice(0, 117)}...`;
}

console.log("[sync-schema] source:", sourceDir);
console.log("[sync-schema] target:", targetDir);
console.log(`[sync-schema] files: ${sourceFiles.length} (unchanged=${same}, changed=${changed})`);

for (const d of diffs) {
  const action = checkOnly ? "DIFF" : d.missing ? "CREATE" : "UPDATE";
  console.log(
    `  ${action} ${d.name}  (${d.dstBytes}B -> ${d.srcBytes}B, lines ${d.lines.oldLineCount} -> ${d.lines.newLineCount})`,
  );
  for (const s of d.lines.samples) {
    console.log(`    L${s.line}: - ${s.before}`);
    console.log(`    L${s.line}: + ${s.after}`);
  }
}
if (stale.length > 0) {
  console.log(`  WARN stale target files (not in design source, left untouched): ${stale.join(", ")}`);
}

if (changed === 0) {
  console.log("[sync-schema] schema up-to-date (byte-identical to design source).");
} else if (checkOnly) {
  console.log(`[sync-schema] check failed: ${changed} file(s) differ from design source.`);
  process.exit(1);
} else {
  console.log(`[sync-schema] synced ${changed} file(s). 真源仍是 docs/abi/schema/*.json。`);
}
