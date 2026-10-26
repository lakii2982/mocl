/**
 * Scenario 6 — runner command injection & escaping.
 *
 * The prompt must always arrive as ONE argv element (shell: false), never be
 * word-split, and `MOCL_AGENT_CMD` templates must be parsed with quote support.
 * Also covers role-prompt file loading vs the built-in fallback.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { OrchestratorError } from "../lib/errors.mjs";
import { buildRunnerInvocation, tokenizeCommandTemplate } from "../lib/runner.mjs";
import { loadRolePrompt, buildImplementerPrompt } from "../lib/prompts.mjs";
import { deliverCommand } from "../lib/deliver.mjs";
import { constantClock, makeWorkspace, throwingExec } from "./helpers.mjs";

const TRICKY_PROMPT = [
  "# 角色：implementer",
  "",
  '要求：实现 "dry-run"，不要执行 $(rm -rf /) 或 `git push --force`。',
  "换行与分号 ; && | > 都应保持字面量。",
].join("\n");

test("tokenizeCommandTemplate: quotes, escapes and whitespace", () => {
  assert.deepEqual(tokenizeCommandTemplate("dsh headless"), ["dsh", "headless"]);
  assert.deepEqual(tokenizeCommandTemplate("  dsh   headless  "), ["dsh", "headless"]);
  assert.deepEqual(tokenizeCommandTemplate('dsh headless --profile "desk top"'), [
    "dsh",
    "headless",
    "--profile",
    "desk top",
  ]);
  assert.deepEqual(tokenizeCommandTemplate("agent --msg 'a b' --flag"), ["agent", "--msg", "a b", "--flag"]);
  assert.deepEqual(tokenizeCommandTemplate('agent "quote \\" inside"'), ["agent", 'quote " inside']);
  assert.deepEqual(tokenizeCommandTemplate("agent a\\ b"), ["agent", "a b"]);
});

test("tokenizeCommandTemplate: malformed templates throw typed errors", () => {
  assert.throws(
    () => tokenizeCommandTemplate('dsh "unterminated'),
    (error) => error instanceof OrchestratorError && error.code === "invalid-agent-cmd",
  );
  assert.throws(
    () => tokenizeCommandTemplate("   "),
    (error) => error instanceof OrchestratorError && error.code === "invalid-agent-cmd",
  );
  assert.throws(
    () => buildRunnerInvocation({ runner: "dsh", commandTemplate: "{prompt}", prompt: "x", env: {} }),
    (error) => error instanceof OrchestratorError && error.code === "invalid-agent-cmd",
  );
});

test("default runner appends the prompt as a single argv element", () => {
  const invocation = buildRunnerInvocation({ runner: "dsh", prompt: TRICKY_PROMPT, env: {} });
  assert.equal(invocation.command, "dsh");
  assert.deepEqual(invocation.args.slice(0, -1), ["headless"]);
  assert.equal(invocation.args.length, 2);
  assert.equal(invocation.args.at(-1), TRICKY_PROMPT, "prompt must not be split or escaped");
  assert.equal(invocation.promptInjected, "appended");
  assert.equal(invocation.template, "dsh headless");
});

test("MOCL_AGENT_CMD templates support quoted args and a {prompt} placeholder", () => {
  const withQuotedArgs = buildRunnerInvocation({
    runner: "dsh",
    commandTemplate: 'dsh headless --profile "desk top" --model x',
    prompt: "P",
    env: {},
  });
  assert.deepEqual(withQuotedArgs.args, ["headless", "--profile", "desk top", "--model", "x", "P"]);

  const withPlaceholder = buildRunnerInvocation({
    runner: "dsh",
    commandTemplate: "claude -p {prompt} --dangerously-skip",
    prompt: TRICKY_PROMPT,
    env: {},
  });
  assert.equal(withPlaceholder.promptInjected, "placeholder");
  assert.deepEqual(withPlaceholder.args.slice(0, 1), ["-p"]);
  assert.equal(withPlaceholder.args[1], TRICKY_PROMPT);
  assert.deepEqual(withPlaceholder.args.slice(2), ["--dangerously-skip"]);

  // The environment template is used when no explicit template is passed.
  const fromEnv = buildRunnerInvocation({ runner: "dsh", prompt: "P", env: { MOCL_AGENT_CMD: "my-agent run --x 'y z'" } });
  assert.equal(fromEnv.command, "my-agent");
  assert.deepEqual(fromEnv.args, ["run", "--x", "y z", "P"]);
});

test("deliver --dry-run plans the MOCL_AGENT_CMD invocation with the prompt last", async () => {
  const workspace = await makeWorkspace();
  try {
    const exec = throwingExec();
    const summary = await deliverCommand(
      { issue: 3, dryRun: true, repo: "lakii2982/mocl", cwd: workspace.root, print: false },
      {
        exec,
        now: constantClock(),
        env: { MOCL_AGENT_CMD: 'my-agent run --profile "desk top"' },
      },
    );
    assert.equal(exec.calls.length, 0);
    const agentCalls = summary.planned.filter(
      (entry) => entry.command === "my-agent" && entry.args[0] !== "--version",
    );
    assert.equal(agentCalls.length, 1, "expected exactly one planned agent invocation");
    const agentCall = agentCalls[0];
    assert.deepEqual(agentCall.args.slice(0, 3), ["run", "--profile", "desk top"]);
    assert.equal(agentCall.args.length, 4, "prompt must be exactly one trailing element");
    // --json/plan output truncates long argv elements; the prompt itself is assembled intact.
    assert.match(agentCall.args[3], /^# 角色：/);
    assert.ok(agentCall.args[3].length <= 240, "planned prompt is display-truncated");
    const assembled = await buildImplementerPrompt({
      cwd: workspace.root,
      issue: {
        number: 3,
        title: "Runner template",
        body: "body",
        labels: ["agent:ready"],
        url: "https://github.com/lakii2982/mocl/issues/3",
      },
      repo: "lakii2982/mocl",
      base: "main",
      branch: "agent/3-runner-template",
      worktree: ".worktrees/issue-3",
      gates: [{ id: "typecheck", command: "node_modules/.bin/tsc", args: ["-p", "tsconfig.json"] }],
    });
    assert.match(assembled.prompt, /## Issue 上下文/);
    assert.match(assembled.prompt, /## 工程约束/);
    assert.match(assembled.prompt, /agent\/3-runner-template/);
    // The availability probe is planned separately and never executes in dry-run.
    assert.ok(
      summary.planned.some((entry) => entry.command === "my-agent" && entry.args[0] === "--version"),
      "runner probe must be planned",
    );
  } finally {
    await workspace.cleanup();
  }
});

test("role prompts come from agents/roles when present, fallback otherwise", async () => {
  const workspace = await makeWorkspace();
  try {
    const missing = await loadRolePrompt({ cwd: workspace.root, role: "implementer" });
    assert.equal(missing.source, "fallback");
    assert.equal(missing.path, null);
    for (const heading of ["## 输入", "## 输出", "## 禁止", "## 完成判据"]) {
      assert.ok(missing.text.includes(heading), `fallback prompt missing ${heading}`);
    }

    await mkdir(join(workspace.root, "agents", "roles"), { recursive: true });
    await writeFile(join(workspace.root, "agents", "roles", "implementer.md"), "# custom implementer\n", "utf8");
    const loaded = await loadRolePrompt({ cwd: workspace.root, role: "implementer" });
    assert.equal(loaded.source, "file");
    assert.match(loaded.text, /custom implementer/);

    await assert.rejects(
      () => loadRolePrompt({ cwd: workspace.root, role: "nobody" }),
      (error) => error instanceof OrchestratorError && error.code === "invalid-role",
    );
  } finally {
    await workspace.cleanup();
  }
});
