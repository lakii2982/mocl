/**
 * 报告生成：JSON（机器读）+ Markdown（发布签收）+ 终端摘要。
 * 所有报告落盘前都会把登记过的密钥替换成 `<redacted>`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const STATUS_LABEL = {
  passed: "PASS",
  failed: "FAIL",
  known: "KNOWN",
  skipped: "SKIP",
};

export function maskSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

export function aggregateKnownIssues(baseline, caseResults) {
  return baseline.issues.map((issue) => {
    const hits = [];
    for (const result of caseResults) {
      for (const entry of result.knownIssues) {
        if (entry.id === issue.id && entry.observed) hits.push({ scenario: result.id, detail: entry.detail });
      }
    }
    return {
      ...issue,
      observed: hits.length > 0,
      observedIn: [...new Set(hits.map((hit) => hit.scenario))],
      evidences: hits.map((hit) => `${hit.scenario}: ${hit.detail}`),
    };
  });
}

export function buildReport({ meta, caseResults, gateResults, knownIssues, mode, scope, strictKnown }) {
  const failedCases = caseResults.filter((result) => result.status === "failed");
  const failedGates = gateResults.filter((gate) => gate.status === "failed");
  const blockerGaps = knownIssues.filter((issue) => issue.observed && issue.severity === "blocker");
  const strictFailed = strictKnown && knownIssues.some((issue) => issue.observed);
  const status =
    failedCases.length > 0 || failedGates.length > 0 || strictFailed ? "failed" : mode === "live" ? "passed-live" : "passed";
  return {
    schemaVersion: 1,
    suite: "mocl-release-scenarios",
    generatedAt: new Date().toISOString(),
    mode,
    scope,
    strictKnown,
    repository: meta.repository,
    environment: meta.environment,
    summary: {
      status,
      cases: {
        total: caseResults.length,
        passed: caseResults.filter((result) => result.status === "passed").length,
        failed: failedCases.length,
        known: caseResults.filter((result) => result.status === "known").length,
        skipped: caseResults.filter((result) => result.status === "skipped").length,
        durationMs: caseResults.reduce((sum, result) => sum + result.durationMs, 0),
      },
      gates: {
        total: gateResults.length,
        passed: gateResults.filter((gate) => gate.status === "passed").length,
        failed: failedGates.length,
        durationMs: gateResults.reduce((sum, gate) => sum + gate.durationMs, 0),
      },
      knownIssues: {
        total: knownIssues.length,
        observed: knownIssues.filter((issue) => issue.observed).length,
        blockers: blockerGaps.length,
      },
    },
    cases: caseResults,
    gates: gateResults,
    knownIssues,
  };
}

export function exitCodeOf(report) {
  if (report.summary.cases.failed > 0 || report.summary.gates.failed > 0) return 1;
  if (report.strictKnown && report.summary.knownIssues.observed > 0) return 1;
  return 0;
}

function statusCell(status) {
  return STATUS_LABEL[status] ?? status;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# MOCL 发布前场景回归报告");
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 模式：**${report.mode}**（scope=${report.scope}）`);
  lines.push(`- 仓库：${report.repository.name} v${report.repository.version} @ ${report.repository.commit}`);
  lines.push(`- 环境：${report.environment.platform} / Node ${report.environment.node}`);
  lines.push(
    `- 结果：**${statusCell(report.summary.status)}** — 场景 ${report.summary.cases.passed}/${report.summary.cases.total} 通过，` +
      `门禁 ${report.summary.gates.passed}/${report.summary.gates.total} 通过，` +
      `已知缺口 ${report.summary.knownIssues.observed}/${report.summary.knownIssues.total} 仍存在` +
      `（blocker ${report.summary.knownIssues.blockers}）`,
  );
  lines.push("");
  if (report.cases.length > 0) {
    lines.push("## 一、人类使用场景");
    lines.push("");
    lines.push("| ID | 人物 / 场景 | 结果 | 断言 | 用时 | 备注 |");
    lines.push("|---|---|---|---|---|---|");
    for (const result of report.cases) {
      const note = result.status === "failed"
        ? result.assertions.filter((entry) => !entry.ok).map((entry) => entry.name).join(", ")
        : result.knownIssues.filter((entry) => entry.observed).map((entry) => entry.id).join(", ") || "";
      lines.push(
        `| ${result.id} | ${result.title}<br><sub>${result.persona}</sub> | ${statusCell(result.status)} | ` +
          `${result.summary.passed}/${result.summary.total} | ${result.durationMs} ms | ${note} |`,
      );
    }
    lines.push("");
  }
  if (report.gates.length > 0) {
    lines.push("## 二、发布门禁");
    lines.push("");
    lines.push("| ID | 检查 | 命令 | 结果 | 用时 |");
    lines.push("|---|---|---|---|---|");
    for (const gate of report.gates) {
      lines.push(
        `| ${gate.id} | ${gate.title} | \`${gate.command}\` | ${statusCell(gate.status)} | ${gate.durationMs} ms |`,
      );
    }
    lines.push("");
  }
  if (report.knownIssues.length > 0) {
    lines.push("## 三、已知缺口（基线）");
    lines.push("");
    lines.push("| ID | 严重级 | 缺口 | 本次复现 | 负责人 |");
    lines.push("|---|---|---|---|---|");
    for (const issue of report.knownIssues) {
      lines.push(
        `| ${issue.id} | ${issue.severity} | ${issue.title} | ${issue.observed ? `是（${issue.observedIn.join(", ")}）` : "否"} | ${issue.owner} |`,
      );
    }
    lines.push("");
    lines.push("> 基线条目在「未复现」时会判失败：修好缺口必须同步删除条目，避免基线腐化。");
    lines.push("> 发布签收若要求零缺口，使用 `node scenarios/run.mjs --strict-known`。");
    lines.push("");
  }
  lines.push("## 四、原始证据");
  lines.push("");
  lines.push("- 机器可读报告：`scenarios/out/release-report.json`");
  lines.push("- 门禁完整日志：`scenarios/out/logs/<gate-id>.log`");
  lines.push("- 场景产物：`scenarios/out/artifacts/<scenario-id>/`");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeReports({ outDir, report, secrets }) {
  await mkdir(outDir, { recursive: true });
  const jsonText = maskSecrets(`${JSON.stringify(report, null, 2)}\n`, secrets);
  const markdown = maskSecrets(renderMarkdown(report), secrets);
  await writeFile(join(outDir, "release-report.json"), jsonText, "utf8");
  await writeFile(join(outDir, "release-report.md"), markdown, "utf8");
  return {
    json: relative(process.cwd(), join(outDir, "release-report.json")),
    markdown: relative(process.cwd(), join(outDir, "release-report.md")),
  };
}

export function printSummary(report, { json = false, secrets = [] } = {}) {
  if (json) {
    console.log(maskSecrets(JSON.stringify(report, null, 2), secrets));
    return;
  }
  console.log("");
  console.log("结果");
  console.log("─".repeat(72));
  for (const result of report.cases) {
    const failed = result.assertions.filter((entry) => !entry.ok);
    const known = result.knownIssues.filter((entry) => entry.observed).map((entry) => entry.id);
    const suffix = result.status === "failed"
      ? ` ← ${failed.map((entry) => entry.name).join(", ")}`
      : known.length > 0
        ? ` ← ${known.join(", ")}`
        : "";
    console.log(
      `${result.id} ${statusCell(result.status).padEnd(6)} ${result.title} ` +
        `(${result.summary.passed}/${result.summary.total} 断言, ${result.durationMs}ms)${suffix}`,
    );
  }
  if (report.gates.length > 0) {
    console.log("");
    for (const gate of report.gates) {
      const suffix = gate.status === "failed" ? ` ← exit=${String(gate.exitCode)}${gate.timedOut ? " (timeout)" : ""}` : "";
      console.log(`${gate.id} ${statusCell(gate.status).padEnd(6)} ${gate.title} (${gate.durationMs}ms)${suffix}`);
    }
  }
  if (report.knownIssues.length > 0) {
    console.log("");
    console.log("已知缺口");
    for (const issue of report.knownIssues) {
      const mark = issue.observed ? "!" : "✓";
      console.log(`  ${mark} ${issue.id} [${issue.severity}] ${issue.title}`);
    }
  }
  console.log("");
  console.log(
    `场景 ${report.summary.cases.passed}/${report.summary.cases.total} 通过 · ` +
      `门禁 ${report.summary.gates.passed}/${report.summary.gates.total} 通过 · ` +
      `已知缺口 ${report.summary.knownIssues.observed}/${report.summary.knownIssues.total} 仍存在`,
  );
}
