/**
 * 单个场景的上下文：断言、证据、快照、已知缺口。
 *
 * 约定：
 * - `assert(name, ok, detail)` 是唯一判定入口；任何一条 false → 场景失败；
 * - `knownIssue(id, observed, detail)` 对应 `scenarios/known-issues.json`：
 *   observed=true → 记为「已知缺口」（默认不阻塞，`--strict-known` 时阻塞）；
 *   observed=false → 说明缺口已修复但基线没删，判失败（防止基线腐化）；
 * - `secret(value)` 登记的值会在报告落盘前被替换，并在运行结束后全量扫描。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  describeDiff,
  diffTrees,
  formatValue,
  makeRepoFixture,
  truncate,
  walkTree,
} from "./util.mjs";

export class CaseContext {
  constructor({ def, dir, outDir, repoRoot, knownIssues }) {
    this.def = def;
    this.id = def.id;
    this.dir = dir;
    this.outDir = outDir;
    this.repoRoot = repoRoot;
    this.knownIssueBaseline = knownIssues;
    this.startedAt = Date.now();

    this.assertions = [];
    this.notes = [];
    this.knownIssues = [];
    this.artifacts = [];
    this.secrets = [];
    this.skipped = false;
    this.skipReason = null;

    this._repoDir = null;
  }

  log(message) {
    console.log(`      ${message}`);
  }

  note(message) {
    this.notes.push(String(message));
  }

  skip(reason) {
    this.skipped = true;
    this.skipReason = String(reason);
    this.log(`skip: ${this.skipReason}`);
  }

  assert(name, ok, detail = "") {
    const entry = { name, ok: Boolean(ok), detail: truncate(formatValue(detail), 500) };
    this.assertions.push(entry);
    if (!entry.ok) this.log(`✗ ${name}${entry.detail === "" ? "" : ` — ${entry.detail}`}`);
    return entry.ok;
  }

  equal(name, actual, expected) {
    return this.assert(name, actual === expected, `actual=${formatValue(actual)} expected=${formatValue(expected)}`);
  }

  match(name, value, pattern) {
    return this.assert(name, typeof value === "string" && pattern.test(value), `value=${formatValue(value)} pattern=${pattern}`);
  }

  fail(name, detail) {
    return this.assert(name, false, detail);
  }

  secret(value) {
    const text = String(value);
    if (text.length > 0) this.secrets.push(text);
    return text;
  }

  /** 登记已知缺口；返回是否命中（命中即「当前仍是缺口」）。 */
  knownIssue(id, observed, detail = "") {
    const entry = this.knownIssueBaseline.get(id);
    if (entry === undefined) {
      this.fail(`known-issue:${id}`, "known-issues.json 中没有该条目（不允许场景私造缺口编号）");
      return false;
    }
    const record = {
      id,
      title: entry.title,
      severity: entry.severity,
      observed: Boolean(observed),
      detail: truncate(formatValue(detail), 500),
    };
    this.knownIssues.push(record);
    if (record.observed) {
      this.log(`! ${id} 已知缺口（${entry.severity}）：${entry.title}`);
      return true;
    }
    this.fail(
      `known-issue:${id}:fixed`,
      `基线条目 ${id} 本次未复现（缺口可能已修复）。请从 scenarios/known-issues.json 删除该条，并把场景断言改成硬检查。`,
    );
    return false;
  }

  async artifact(name, value) {
    const dir = join(this.outDir, "artifacts", this.id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path, text, "utf8");
    const recorded = { name, path: relative(this.repoRoot, path) };
    this.artifacts.push(recorded);
    return recorded;
  }

  /** 懒创建临时 git 仓库（同一场景复用同一个）。 */
  async repo(name = "repo") {
    if (this._repoDir === null) {
      this._repoDir = await makeRepoFixture(join(this.dir, name));
    }
    return this._repoDir;
  }

  async snapshot(root) {
    return walkTree(root);
  }

  /** 断言文件树零变化；`allow` 用相对路径或正则表达「兼容层自身状态文件」。 */
  async assertUnchanged(name, root, before, { allow = [] } = {}) {
    const after = await walkTree(root);
    const diff = diffTrees(before, after);
    const isAllowed = (path) =>
      allow.some((rule) => (typeof rule === "string" ? path === rule : rule instanceof RegExp && rule.test(path)));
    const offending = {
      added: diff.added.filter((path) => !isAllowed(path)),
      modified: diff.modified.filter((path) => !isAllowed(path)),
      removed: diff.removed.filter((path) => !isAllowed(path)),
    };
    const clean = offending.added.length === 0 && offending.modified.length === 0 && offending.removed.length === 0;
    return this.assert(name, clean, describeDiff(offending));
  }

  result() {
    const failedAssertions = this.assertions.filter((entry) => entry.ok === false);
    const observedGaps = this.knownIssues.filter((entry) => entry.observed);
    let status = "passed";
    if (this.skipped) status = "skipped";
    else if (failedAssertions.length > 0) status = "failed";
    else if (observedGaps.length > 0) status = "known";
    return {
      id: this.id,
      title: this.def.title,
      persona: this.def.persona,
      goal: this.def.goal,
      scope: this.def.scope ?? "usage",
      status,
      durationMs: Date.now() - this.startedAt,
      skipReason: this.skipReason,
      assertions: this.assertions,
      summary: {
        total: this.assertions.length,
        passed: this.assertions.length - failedAssertions.length,
        failed: failedAssertions.length,
      },
      notes: this.notes,
      knownIssues: this.knownIssues,
      artifacts: this.artifacts,
      secrets: this.secrets,
    };
  }
}
