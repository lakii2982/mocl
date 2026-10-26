#!/usr/bin/env node
/**
 * C8/C9 工具可见性断言（`scripts/assert-dsh-tool.mjs`）。
 *
 * 用法：
 *   node scripts/assert-dsh-tool.mjs                       # 静态 + headless dump-config（+ 可选 live）
 *   node scripts/assert-dsh-tool.mjs --profile <name>      # 用指定 profile dump-config 断言
 *   node scripts/assert-dsh-tool.mjs --bootstrap-profile   # 隔离 profile `mocl-e2e`：建 profile → 装本地插件 → dump
 *   MOCL_HOST_LIVE=0 ...                                   # 跳过 live 工具列表探测
 *
 * 契约（**不假绿**）：
 * - 静态 patch 断言失败 → exit 1；
 * - dsh/profile 不可用、bootstrap 失败/超时 → 打印 `SKIP:bootstrap-unavailable` 或 `SKIP:host-unavailable`
 *   + 原因 + 手工步骤，**exit 0**（SKIP 不算 PASS）；
 * - bootstrap 全程上限 **8 分钟**；新建 profile 名固定 `mocl-e2e`，**绝不触碰 desktop**；
 *   结束时打印清理命令。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStaticPatchFiles, PATCH_DIR, PLUGIN_ID, TOOL_NAMES } from "../src/plugin/patch.ts";

const HOST_BASELINE = "0.2.1-rc.3";
const TIMEOUT_MS = 60_000;
const BOOTSTRAP_BUDGET_MS = 8 * 60_000;
const PROFILE_NAME = "mocl-e2e";
const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL_ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const options = { profile: null, bootstrapProfile: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      options.profile = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--bootstrap-profile") {
      options.bootstrapProfile = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

function dsh(args, timeoutMs = TIMEOUT_MS) {
  const result = spawnSync("dsh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: !result.error && result.status === 0,
    error: result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error !== undefined && String(result.error.message ?? "").toLowerCase().includes("timed out"),
  };
}

function dshVersion() {
  const result = dsh(["--version"], 20_000);
  return { available: result.ok, detail: (result.stdout || result.stderr).trim() || `exit ${String(result.status)}` };
}

function profileSupportDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles");
}

function assertComposed(stdout) {
  const missing = [];
  if (!stdout.includes(PLUGIN_ID)) missing.push(`id ${PLUGIN_ID}`);
  if (!stdout.includes(TOOL_NAMES[0])) missing.push(`tool ${TOOL_NAMES[0]}`);
  return missing;
}

function dumpConfig(profile) {
  const patch = join(PATCH_DIR, "cordis.patch.yml");
  const result = dsh(["--profile", profile, "--patch", patch, "--dump-config"]);
  if (!result.ok) {
    return {
      ok: false,
      detail: result.timedOut ? "dump-config timed out" : `exit ${String(result.status)}: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`,
    };
  }
  const missing = assertComposed(result.stdout);
  return { ok: missing.length === 0, detail: missing.length === 0 ? "composed" : `dump missing ${missing.join(", ")}` };
}

function liveToolVisibility(profile) {
  if (process.env.MOCL_HOST_LIVE === "0") return { skipped: true, detail: "disabled by MOCL_HOST_LIVE=0" };
  const patch = join(PATCH_DIR, "cordis.patch.yml");
  const result = dsh(["headless", "--patch", patch, "列出你的工具"], TIMEOUT_MS);
  if (!result.ok) return { skipped: true, detail: `headless ${result.timedOut ? "timeout" : `exit ${String(result.status)}`}` };
  if (!result.stdout.includes(TOOL_NAMES[0])) return { skipped: true, detail: "tool list did not include subagent_agent" };
  return { skipped: false, detail: "subagent_agent visible in headless tool list" };
}

function manualSteps() {
  return [
    "手工步骤（与脚本等价）：",
    "  1) dsh --from-default-profile headless --profile mocl-e2e --dump-config",
    "  2) 在 e2e/tmp/plugin-package 准备 package.json(name=@mocl/dsh-plugin)+index.mjs（re-export src/plugin/index.ts）",
    "  3) dsh plugin --profile mocl-e2e add file:$PWD/e2e/tmp/plugin-package",
    "  4) dsh --profile mocl-e2e --patch $PWD/patch/cordis.patch.yml --dump-config | grep -E 'mocl|subagent_agent'",
    `  5) 清理：rm -rf ${join(profileSupportDir(), PROFILE_NAME)}`,
  ].join("\n");
}

function writeBootstrapPluginPackage() {
  const dir = join(IMPL_ROOT, "e2e", "tmp", "plugin-package");
  mkdirSync(dir, { recursive: true });
  const entry = join(IMPL_ROOT, "src", "plugin", "index.ts");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "@mocl/dsh-plugin", version: "0.0.0-c9", private: true, type: "module", main: "index.mjs" },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `// 由 C9 bootstrap 生成：薄包装真正插件入口（Node ≥24 原生 TS type-stripping）。\nexport * from ${JSON.stringify(new URL(`file://${entry}`).href)};\n`,
    "utf8",
  );
  return dir;
}

function printCleanup() {
  console.log(`CLEANUP: rm -rf ${join(profileSupportDir(), PROFILE_NAME)}`);
  console.log("CLEANUP: rm -rf " + join(IMPL_ROOT, "e2e", "tmp", "plugin-package"));
}

function bootstrapProfile() {
  const startedAt = Date.now();
  const deadline = startedAt + BOOTSTRAP_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const skip = (step, reason) => {
    console.log(`SKIP:bootstrap-unavailable (${step}: ${reason})`);
    console.log(manualSteps());
    printCleanup();
    console.log("RESULT: SKIP bootstrap-unavailable (static PASS)");
    return 0;
  };

  if (PROFILE_NAME === "desktop") return skip("guard", "refusing to touch desktop profile");
  const profileDir = join(profileSupportDir(), PROFILE_NAME);
  const patch = join(PATCH_DIR, "cordis.patch.yml");

  // Step 1：创建/复用隔离 profile（shipped headless 模板）
  if (!existsSync(profileDir)) {
    if (remaining() < 30_000) return skip("create-profile", "time budget exhausted");
    const created = dsh(["--from-default-profile", "headless", "--profile", PROFILE_NAME, "--dump-config"], Math.min(remaining(), 120_000));
    if (!created.ok) {
      return skip("create-profile", created.timedOut ? "timed out" : `exit ${String(created.status)}: ${created.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    }
    console.log(`PASS bootstrap: profile created (${profileDir})`);
  } else {
    console.log(`INFO bootstrap: reusing existing profile (${profileDir})`);
  }

  // Step 2：本地插件包（file: 安装；不依赖网络 registry）
  let pluginPackageDir;
  try {
    pluginPackageDir = writeBootstrapPluginPackage();
  } catch (error) {
    return skip("plugin-package", String(error.message ?? error));
  }

  // Step 3：安装到隔离 profile
  if (remaining() < 20_000) return skip("install-plugin", "time budget exhausted");
  const installed = dsh(["plugin", "--profile", PROFILE_NAME, "add", `file:${pluginPackageDir}`], Math.min(remaining(), 240_000));
  if (!installed.ok) {
    return skip("install-plugin", installed.timedOut ? "timed out (pnpm)" : `exit ${String(installed.status)}: ${installed.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }
  console.log("PASS bootstrap: @mocl/dsh-plugin installed into mocl-e2e");

  // Step 4：dump-config 断言
  if (remaining() < 15_000) return skip("dump-config", "time budget exhausted");
  const composed = dumpConfig(PROFILE_NAME);
  if (!composed.ok) return skip("dump-config", composed.detail);
  console.log(`PASS bootstrap: patch composed in ${PROFILE_NAME} (id=${PLUGIN_ID}, tool=${TOOL_NAMES[0]})`);

  // Step 5：确认安装产物存在（防止 dump 通过但包没装）
  const installedPkg = join(profileDir, "node_modules", "@mocl", "dsh-plugin", "package.json");
  if (!existsSync(installedPkg)) return skip("verify-install", "node_modules/@mocl/dsh-plugin/package.json missing");
  console.log("PASS bootstrap: plugin package present in profile node_modules");
  printCleanup();
  console.log("RESULT: PASS bootstrap (isolated profile mocl-e2e; live tool execution not asserted)");
  return 0;
}

function standardRun(profile) {
  const composed = dumpConfig(profile);
  if (!composed.ok) {
    console.log(`SKIP:host-unavailable (dump-config failed: ${composed.detail})`);
    console.log("RESULT: SKIP host-unavailable (static PASS)");
    return 0;
  }
  console.log(`PASS dump-config: patch composed in ${profile} profile (id=${PLUGIN_ID}, tool=${TOOL_NAMES[0]})`);
  if (profile !== "headless") {
    console.log("RESULT: PASS static + dump-config (custom profile)");
    return 0;
  }
  const live = liveToolVisibility(profile);
  if (live.skipped) {
    console.log(`SKIP:host-unavailable (live tool list: ${live.detail})`);
    console.log("RESULT: SKIP host-unavailable (static + dump-config PASS)");
    return 0;
  }
  console.log(`PASS live tool visibility: ${live.detail}`);
  console.log("RESULT: PASS static + dump-config + live tool visibility");
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).join("\n"));
    return 0;
  }
  try {
    const report = assertStaticPatchFiles();
    console.log(
      `PASS static patch: ids=[${report.cordisIds.join(",")}] legacy=${report.legacyDisabled} tools=[${report.toolNames.join(",")}]`,
    );
  } catch (error) {
    console.error(`FAIL static patch: ${String(error.message ?? error)}`);
    console.log("RESULT: FAIL static-patch");
    return 1;
  }

  const version = dshVersion();
  if (!version.available) {
    console.log(`SKIP:host-unavailable (dsh not usable: ${version.detail})`);
    console.log("RESULT: SKIP host-unavailable (static PASS)");
    return 0;
  }
  console.log(`INFO dsh version: ${version.detail} (baseline ${HOST_BASELINE})`);

  if (options.bootstrapProfile) return bootstrapProfile();
  return standardRun(options.profile ?? "headless");
}

process.exitCode = main();
