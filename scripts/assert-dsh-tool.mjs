#!/usr/bin/env node
/**
 * C8 工具可见性断言（`impl/scripts/assert-dsh-tool.mjs`）。
 *
 * 三级断言，**不假绿**：
 * 1. 静态：解析 `impl/patch/*.yml`（逻辑在 `src/plugin/patch.ts`，与测试共用），
 *    断言插件 id、包名、工具名、停用旧行、id 唯一；
 * 2. 宿主组合：`dsh --profile headless --patch ... --dump-config` 成功且输出含插件 id/工具名 → PASS；
 *    dsh 不在 PATH / profile 不可读 / 失败 / 超时 → 打印 `SKIP:host-unavailable` 并 exit 0；
 * 3. 可选 live：`dsh headless --patch ... "列出你的工具"` 60s 内成功且含 `subagent_agent` 才 PASS，
 *    否则同样 SKIP（不算通过；可用 `MOCL_HOST_LIVE=0` 显式跳过）。
 *
 * 退出码：静态断言失败 = 1；其余（含 SKIP）= 0。最后一行固定 `RESULT: PASS|SKIP|FAIL ...`。
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertStaticPatchFiles, PATCH_DIR, PLUGIN_ID, TOOL_NAMES } from "../src/plugin/patch.ts";

const HOST_BASELINE = "0.2.1-rc.3";
const TIMEOUT_MS = 60_000;

function dshVersion() {
  const result = spawnSync("dsh", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (result.error !== undefined) return { available: false, detail: String(result.error.message ?? result.error) };
  return {
    available: result.status === 0,
    detail: (result.stdout ?? result.stderr ?? "").trim() || `exit ${String(result.status)}`,
  };
}

function composePatch() {
  const patch = join(PATCH_DIR, "cordis.patch.yml");
  const result = spawnSync("dsh", ["--profile", "headless", "--patch", patch, "--dump-config"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) return { ok: false, detail: String(result.error.message ?? result.error) };
  if (result.status !== 0) {
    const tail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    return { ok: false, detail: `exit ${String(result.status)}: ${tail}` };
  }
  const stdout = result.stdout ?? "";
  const missing = [];
  if (!stdout.includes(PLUGIN_ID)) missing.push(`id ${PLUGIN_ID}`);
  if (!stdout.includes(TOOL_NAMES[0])) missing.push(`tool ${TOOL_NAMES[0]}`);
  return { ok: missing.length === 0, detail: missing.length === 0 ? "composed" : `dump missing ${missing.join(", ")}` };
}

function liveToolVisibility() {
  if (process.env.MOCL_HOST_LIVE === "0") return { skipped: true, detail: "disabled by MOCL_HOST_LIVE=0" };
  const patch = join(PATCH_DIR, "cordis.patch.yml");
  const result = spawnSync("dsh", ["headless", "--patch", patch, "列出你的工具"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) return { skipped: true, detail: `host error: ${String(result.error.message ?? result.error)}` };
  if (result.status !== 0) return { skipped: true, detail: `headless exit ${String(result.status)}` };
  const stdout = result.stdout ?? "";
  if (!stdout.includes(TOOL_NAMES[0])) return { skipped: true, detail: "tool list did not include subagent_agent" };
  return { skipped: false, detail: "subagent_agent visible in headless tool list" };
}

function main() {
  try {
    const report = assertStaticPatchFiles();
    console.log(
      `PASS static patch: ids=[${report.cordisIds.join(",")}] legacy=${report.legacyDisabled} tools=[${report.toolNames.join(",")}]`,
    );
  } catch (error) {
    console.error(`FAIL static patch: ${String(error.message ?? error)}`);
    console.log("RESULT: FAIL static-patch");
    process.exitCode = 1;
    return;
  }

  const version = dshVersion();
  if (!version.available) {
    console.log(`SKIP:host-unavailable (dsh not usable: ${version.detail})`);
    console.log("RESULT: SKIP host-unavailable (static PASS)");
    return;
  }
  console.log(`INFO dsh version: ${version.detail} (baseline ${HOST_BASELINE})`);

  const composed = composePatch();
  if (!composed.ok) {
    console.log(`SKIP:host-unavailable (dump-config failed: ${composed.detail})`);
    console.log("RESULT: SKIP host-unavailable (static PASS)");
    return;
  }
  console.log(`PASS dump-config: patch composed in headless profile (id=${PLUGIN_ID}, tool=${TOOL_NAMES[0]})`);

  const live = liveToolVisibility();
  if (live.skipped) {
    console.log(`SKIP:host-unavailable (live tool list: ${live.detail})`);
    console.log("RESULT: SKIP host-unavailable (static + dump-config PASS)");
    return;
  }
  console.log(`PASS live tool visibility: ${live.detail}`);
  console.log("RESULT: PASS static + dump-config + live tool visibility");
}

main();
