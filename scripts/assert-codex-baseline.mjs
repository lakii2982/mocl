#!/usr/bin/env node
/**
 * assert-codex-baseline.mjs — codex 单基线（D-015: 0.164.0）CI 门禁。
 *
 * 背景：本机同时存在两个 codex —— PATH 上的基线（0.164.0）与 DSH profile 内
 * 尚未升级的旧载荷（@openai/codex-darwin-arm64 0.153.4）。两版 app-server 协议
 * 计数不同（106/85/10 vs 99/81/10），混用会让适配器的类型/断言静默错位。
 * 本脚本把「基线是否正确」变成一条可脚本化、零额度的断言。
 *
 * 零额度保证：只执行 `--version` 与 `app-server generate-json-schema`，**从不**
 * 创建 thread / 运行 turn / 读写 ~/.codex 会话或凭据。可安全放进 CI 与 pre-commit。
 *
 * 断言（任一 FAIL → 退出码 1）：
 *   [1] 版本：`<binary> --version` 解析出的语义版本以 `--expect` 前缀开头（默认 `0.164.`）
 *   [2] 协议计数：`app-server generate-json-schema` 后
 *       ClientRequest=106 / ServerNotification=85 / ServerRequest=10
 *       计数口径 = 唯一 `properties.method` 的 enum/const 取值数
 *       （与 ../repro/probe-codex.sh §4、../docs/adapters/codex.md §12.4 一致；
 *        不是「含斜杠的字符串数」，那样会漏掉 initialize/fuzzyFileSearch/error 等无斜杠方法）
 *   [3] 关键能力：ClientRequest 含 thread/resume、turn/steer、thread/loaded/list，
 *       且 ThreadItem 变体含 collabAgentToolCall
 *   [4] 旧载荷（警告级）：扫描 ~/.dsh/profiles/<profile>/node_modules/@openai/codex-darwin-arm64/
 *       vendor/<target>/bin/codex，打印版本并标 SAME|DIFF；DIFF 时打印升级指引。
 *       默认只警告（因为升级动作可能滞后于代码）；`--strict-bundle` 时 DIFF 也算 FAIL。
 *
 * 用法：
 *   node scripts/assert-codex-baseline.mjs
 *   node scripts/assert-codex-baseline.mjs --binary /abs/path/to/codex --expect 0.164.
 *   node scripts/assert-codex-baseline.mjs --strict-bundle      # 要求 profile 载荷已升齐
 *   node scripts/assert-codex-baseline.mjs --json               # 机器可读结果（CI/测试）
 *   node scripts/assert-codex-baseline.mjs --keep               # 保留导出的 schema 目录
 *
 * 退出码：0=全部通过（可能有警告）；1=有断言失败；2=参数/环境用法错误。
 * 版本升级后同步修改默认期望值，并同步 ../repro/probe-codex.sh 的 EXPECT_*。
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** 默认期望值（与 ../repro/probe-codex.sh 的 EXPECT_* 保持一致） */
const DEFAULTS = {
  expectVersionPrefix: "0.164.",
  clientRequest: 106,
  serverNotification: 85,
  serverRequest: 10,
};
const REQUIRED_CLIENT_METHODS = ["thread/resume", "turn/steer", "thread/loaded/list"];
const REQUIRED_ITEM_VARIANTS = ["collabAgentToolCall"];
const SCHEMA_FILES_HINT = 39; // 37 个顶层 JSON + v1/ + v2/ 两个子目录；仅提示，不参与判定
const PROFILE_ROOT = join(homedir(), ".dsh", "profiles");
const BUNDLE_PKG = "@openai/codex-darwin-arm64";
const GENERATE_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------ 输出与结果收集
/** @typedef {{id:string,status:"PASS"|"FAIL"|"INFO"|"SKIP",detail:string}} Check */
/** @type {Check[]} */
const checks = [];
const humanLines = [];

function emit(line = "") {
  humanLines.push(line);
  if (!humanLines.silent) process.stdout.write(line + "\n");
}
function emitFatal(line) {
  process.stderr.write(line + "\n");
}
function record(id, status, detail) {
  checks.push({ id, status, detail });
}
function pass(id, detail) {
  record(id, "PASS", detail);
  emit(`  PASS ${id}: ${detail}`);
}
function fail(id, detail) {
  record(id, "FAIL", detail);
  emit(`  FAIL ${id}: ${detail}`);
}
function info(id, detail) {
  record(id, "INFO", detail);
  emit(`  INFO ${id}: ${detail}`);
}
function skip(id, detail) {
  record(id, "SKIP", detail);
  emit(`  SKIP ${id}: ${detail}`);
}
function section(id, title) {
  emit("");
  emit(`[${id}] ${title}`);
}

function usage(stream = process.stdout) {
  stream.write(
    [
      "用法: node scripts/assert-codex-baseline.mjs [options]",
      "",
      "  --binary <path|cmd>            要断言的 codex（默认取 PATH 上的 codex）",
      `  --expect <version-prefix>      期望版本前缀（默认 ${DEFAULTS.expectVersionPrefix}）`,
      `  --expect-client-request <n>    期望 ClientRequest 数（默认 ${DEFAULTS.clientRequest}）`,
      `  --expect-server-notification <n>  期望 ServerNotification 数（默认 ${DEFAULTS.serverNotification}）`,
      `  --expect-server-request <n>    期望 ServerRequest 数（默认 ${DEFAULTS.serverRequest}）`,
      "  --strict-bundle                profile 内旧载荷 DIFF 也算失败（升级完成后应开启）",
      "  --json                         输出机器可读 JSON（不打印人读日志）",
      "  --keep                         保留导出的 schema 目录（便于排查）",
      "  -h, --help                     显示本帮助",
      "",
      "退出码: 0=通过 1=断言失败 2=用法/环境错误",
    ].join("\n") + "\n",
  );
}

// ------------------------------------------------------------------ 参数解析
function parseCli(rawArgv) {
  // `pnpm -s baseline:codex -- --strict-bundle` / `npm run ... -- --flag` 会把字面量 `--`
  // 一起传进来（实测 pnpm 11 行为）；剥掉首个 `--` 才能让 npm/pnpm 风格调用与直接调用一致。
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        binary: { type: "string" },
        expect: { type: "string" },
        "expect-client-request": { type: "string" },
        "expect-server-notification": { type: "string" },
        "expect-server-request": { type: "string" },
        "strict-bundle": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        keep: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    emitFatal(`[assert-codex-baseline] 参数错误: ${/** @type {Error} */ (error).message}`);
    usage(process.stderr);
    process.exit(2);
  }

  if (values.help) {
    usage();
    process.exit(0);
  }

  const toPositiveInt = (raw, flag) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      emitFatal(`[assert-codex-baseline] 参数错误: ${flag} 需要正整数，收到 ${JSON.stringify(raw)}`);
      process.exit(2);
    }
    return n;
  };

  return {
    binary: values.binary ?? "codex",
    expectVersionPrefix: values.expect ?? DEFAULTS.expectVersionPrefix,
    expect: {
      clientRequest: toPositiveInt(values["expect-client-request"], "--expect-client-request") ?? DEFAULTS.clientRequest,
      serverNotification: toPositiveInt(values["expect-server-notification"], "--expect-server-notification") ?? DEFAULTS.serverNotification,
      serverRequest: toPositiveInt(values["expect-server-request"], "--expect-server-request") ?? DEFAULTS.serverRequest,
    },
    strictBundle: Boolean(values["strict-bundle"]),
    json: Boolean(values.json),
    keep: Boolean(values.keep),
  };
}

// ------------------------------------------------------------------ 工具
/** 在 PATH 中解析可执行文件；找不到返回 undefined。 */
function which(command) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
  }
  return undefined;
}

/** 解析 --binary：绝对/相对路径直接校验；裸命令名走 PATH。 */
function resolveBinary(spec) {
  const looksLikePath = spec.includes("/") || spec.includes("\\");
  const candidate = looksLikePath ? resolve(spec) : which(spec);
  if (candidate === undefined) {
    return { ok: false, reason: looksLikePath ? `路径不存在: ${resolve(spec)}` : `PATH 中找不到命令: ${spec}` };
  }
  try {
    accessSync(candidate, constants.X_OK);
    if (!statSync(candidate).isFile()) return { ok: false, reason: `不是普通文件: ${candidate}` };
  } catch (error) {
    return { ok: false, reason: `不可执行: ${candidate} (${/** @type {Error} */ (error).message})` };
  }
  let display = candidate;
  try {
    display = realpathSync(candidate);
  } catch {
    /* 保留未解析路径 */
  }
  return { ok: true, path: candidate, display };
}

/** 从 `codex --version` 之类输出里抓语义版本。 */
function extractVersion(raw) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(raw);
  return match ? match[1] : undefined;
}

function runVersion(binaryPath) {
  const stdout = execFileSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout.trim();
}

function runGenerateSchema(binaryPath, outDir) {
  execFileSync(binaryPath, ["app-server", "generate-json-schema", "--out", outDir], {
    encoding: "utf8",
    timeout: GENERATE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * 统计某个协议文件的「方法数」。
 * 口径：唯一 `properties.method` 的 enum/const 字符串（与设计包 probe §4 一致）。
 */
function countMethods(filePath) {
  const doc = JSON.parse(readFileSync(filePath, "utf8"));
  const methods = new Set();
  const take = (node) => {
    for (const key of ["enum", "const"]) {
      if (!(key in node)) continue;
      const raw = node[key];
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value === "string" && value.length > 0) methods.add(value);
      }
    }
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const props = node.properties;
    if (props !== null && typeof props === "object" && props.method !== null && typeof props.method === "object") {
      take(props.method);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  return { methods, rootVariants: Array.isArray(doc.oneOf) ? doc.oneOf.length : null };
}

/** 扫描 DSH profile 里的 codex bundle 载荷。 */
function detectProfileBundles() {
  if (!existsSync(PROFILE_ROOT)) return [];
  const found = [];
  for (const profile of safeReaddir(PROFILE_ROOT)) {
    const pkgRoot = join(PROFILE_ROOT, profile, "node_modules", BUNDLE_PKG);
    const vendorRoot = join(pkgRoot, "vendor");
    if (!existsSync(vendorRoot)) continue;
    let pkgVersion;
    try {
      pkgVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
    } catch {
      pkgVersion = undefined;
    }
    for (const target of safeReaddir(vendorRoot)) {
      const bin = join(vendorRoot, target, "bin", "codex");
      if (!existsSync(bin)) continue;
      let version;
      try {
        version = extractVersion(runVersion(bin));
      } catch (error) {
        version = `不可执行(${/** @type {Error} */ (error).message.split("\n")[0]})`;
      }
      found.push({ profile, target, path: bin, pkgVersion, version });
    }
  }
  return found;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ 主流程
function main() {
  const cli = parseCli(process.argv.slice(2));
  humanLines.silent = cli.json;

  const resolved = resolveBinary(cli.binary);
  emit("== codex baseline assertion (D-015: single baseline, zero-quota) ==");
  emit(`  binary      : ${cli.binary}${resolved.ok ? ` -> ${resolved.display}` : ""}`);
  emit(`  expect ver  : ${cli.expectVersionPrefix}*`);
  emit(
    `  expect count: ClientRequest=${cli.expect.clientRequest} ` +
      `ServerNotification=${cli.expect.serverNotification} ServerRequest=${cli.expect.serverRequest}`,
  );
  emit(`  strictBundle: ${cli.strictBundle ? "on（旧载荷 DIFF 即失败）" : "off（旧载荷 DIFF 仅警告）"}`);

  const diag = [];
  let schemaDir;
  let keepDir = false;

  try {
    // ---------------- [1] 版本断言
    section("1", "版本");
    let hostVersion;
    if (!resolved.ok) {
      fail("version", `无法解析二进制：${resolved.reason}`);
      diag.push(`二进制解析失败：${resolved.reason}`);
      diag.push("排查：command -v codex；或 --binary 指向绝对路径（如 ~/.nvm/.../bin/codex）");
    } else {
      try {
        const rawVersion = runVersion(resolved.path);
        hostVersion = extractVersion(rawVersion);
        if (hostVersion === undefined) {
          fail("version", `--version 输出无法解析出版本: ${JSON.stringify(rawVersion)}`);
        } else if (!hostVersion.startsWith(cli.expectVersionPrefix)) {
          fail("version", `${hostVersion} 不匹配期望前缀 ${cli.expectVersionPrefix}（原始输出: ${JSON.stringify(rawVersion)}）`);
          diag.push(`版本漂移：期望前缀 ${cli.expectVersionPrefix}，实际 ${hostVersion}`);
          diag.push("若是有意升级基线：同步改本脚本 DEFAULTS 与 ../repro/probe-codex.sh 的 EXPECT_*，再复跑");
        } else {
          pass("version", `${hostVersion}（原始输出: ${JSON.stringify(rawVersion)}）`);
        }
      } catch (error) {
        fail("version", `执行 --version 失败: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
        diag.push(`复现：${resolved.display} --version`);
      }
    }

    // ---------------- [2]+[3] 协议计数与关键能力（依赖可执行的二进制）
    const canGenerate = resolved.ok === true && hostVersion !== undefined;
    if (!canGenerate) {
      skip("protocol-counts", "跳过（二进制不可用或版本未通过，避免在错误基线上做协议断言）");
      skip("required-methods", "跳过（同上）");
    } else {
      section("2", "协议计数（app-server generate-json-schema）");
      schemaDir = mkdtempSync(join(tmpdir(), "mocl-codex-baseline-"));
      keepDir = cli.keep;
      if (cli.keep) emit(`  保留目录   : ${schemaDir}`);
      try {
        runGenerateSchema(resolved.path, schemaDir);
      } catch (error) {
        fail("generate-json-schema", `导出失败: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
        diag.push(`复现：${resolved.display} app-server generate-json-schema --out ${schemaDir}`);
      }

      const expected = [
        ["ClientRequest", "clientRequest"],
        ["ServerNotification", "serverNotification"],
        ["ServerRequest", "serverRequest"],
      ];
      let countsOk = false;
      const observed = {};
      let hasFailure = checks.some((c) => c.id === "generate-json-schema" && c.status === "FAIL");

      if (!hasFailure) {
        const entries = countEntries(schemaDir);
        if (entries !== SCHEMA_FILES_HINT) {
          info("schema-files", `${entries} 项（历史基线 ${SCHEMA_FILES_HINT} 项，仅提示：可能新增/删除了协议文件）`);
        } else {
          info("schema-files", `${entries} 项（与历史基线一致）`);
        }

        countsOk = true;
        for (const [file, expectKey] of expected) {
          const filePath = join(schemaDir, `${file}.json`);
          if (!existsSync(filePath)) {
            fail(`count:${file}`, `缺少 ${file}.json`);
            countsOk = false;
            continue;
          }
          try {
            const { methods, rootVariants } = countMethods(filePath);
            observed[file] = methods.size;
            const want = cli.expect[/** @type {"clientRequest"|"serverNotification"|"serverRequest"} */ (expectKey)];
            if (methods.size !== want) {
              fail(`count:${file}`, `${methods.size} != 期望 ${want}（schema 漂移）`);
              countsOk = false;
            } else {
              pass(`count:${file}`, `${methods.size}（= 期望 ${want}）`);
            }
            if (rootVariants !== null && rootVariants !== methods.size) {
              info(`oneOf:${file}`, `root oneOf=${rootVariants} 与唯一 method 数 ${methods.size} 不一致（schema 形状变化）`);
            }
          } catch (error) {
            fail(`count:${file}`, `解析失败: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
            countsOk = false;
          }
        }
        if (!countsOk) {
          diag.push(`协议计数漂移，实测 ${JSON.stringify(observed)}`);
          diag.push(`复现：${resolved.display} app-server generate-json-schema --out /tmp/cx && node scripts/assert-codex-baseline.mjs`);
          diag.push("对照：../docs/adapters/codex.md §1.2 协议差异表；升级基线时同步 repro/probe-codex.sh 的 EXPECT_*");
        }
      } else {
        skip("count:*", "跳过（schema 导出失败）");
      }

      // ---------------- [3] 关键能力
      section("3", "关键方法/变体存在性");
      if (hasFailure) {
        skip("required-methods", "跳过（schema 导出失败）");
      } else {
        const client = countMethods(join(schemaDir, "ClientRequest.json")).methods;
        const missing = REQUIRED_CLIENT_METHODS.filter((m) => !client.has(m));
        if (missing.length === 0) {
          pass("client-methods", REQUIRED_CLIENT_METHODS.join(", "));
        } else {
          fail("client-methods", `ClientRequest 缺少: ${missing.join(", ")}`);
          diag.push(`缺失方法 ${missing.join(", ")} → 适配器握手/续接/打断会直接不可用；核对此 codex 是否是预期基线`);
        }

        const v2Path = join(schemaDir, "codex_app_server_protocol.v2.schemas.json");
        if (!existsSync(v2Path)) {
          fail("thread-item:collabAgentToolCall", `缺少 v2 协议文件: ${v2Path}`);
        } else {
          try {
            const defs = JSON.parse(readFileSync(v2Path, "utf8")).definitions ?? {};
            const variants = new Set(
              (defs.ThreadItem?.oneOf ?? [])
                .map((variant) => variant?.properties?.type?.enum?.[0])
                .filter((value) => typeof value === "string"),
            );
            const missingVariants = REQUIRED_ITEM_VARIANTS.filter((v) => !variants.has(v));
            const toolNames = defs.CollabAgentTool?.enum ?? [];
            if (missingVariants.length === 0) {
              pass(
                "thread-item:collabAgentToolCall",
                `ThreadItem 变体 ${variants.size} 种；CollabAgentTool=${toolNames.length} 值`,
              );
            } else {
              fail("thread-item:collabAgentToolCall", `ThreadItem 缺少变体: ${missingVariants.join(", ")}`);
              diag.push("原生子代理（collabAgentToolCall）在此基线缺失 → ABI 的 nativeSubagents 能力位必须降级为 false");
            }
          } catch (error) {
            fail("thread-item:collabAgentToolCall", `解析 v2 协议失败: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
          }
        }
      }
    }

    // ---------------- [4] 旧载荷一致性（警告级 / --strict-bundle 升级为失败）
    section("4", "DSH profile 旧载荷一致性");
    let bundles = [];
    try {
      bundles = detectProfileBundles();
    } catch (error) {
      info("bundle", `扫描失败（忽略）: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    }
    if (bundles.length === 0) {
      skip("bundle", `未发现 profile bundle 载荷（${join(PROFILE_ROOT, "*", "node_modules", BUNDLE_PKG)}）`);
    } else {
      const diffs = [];
      for (const bundle of bundles) {
        const same = hostVersion !== undefined && bundle.version === hostVersion;
        const verdict = same ? "SAME" : "DIFF";
        if (!same) diffs.push(bundle);
        const id = `bundle:${bundle.profile}/${bundle.target}`;
        const detail =
          `${bundle.version ?? "?"}（npm ${bundle.pkgVersion ?? "?"}） vs 基线 ${hostVersion ?? "?"} → ${verdict}`;
        if (same) {
          pass(id, detail);
        } else if (cli.strictBundle) {
          fail(id, detail);
        } else {
          info(id, `${detail}（警告：旧载荷待升级；加 --strict-bundle 可将其升级为失败）`);
        }
      }

      if (diffs.length > 0) {
        const profile = diffs[0].profile;
        emit("");
        emit("  → 升级指引（DSH profile 内的 @openai/codex 是插件精确依赖，插件无配置项可绕开）：");
        emit("    A) 升级 profile 依赖（推荐，改 DSH profile 而非 asar）：");
        emit(`       pnpm --dir ${join(PROFILE_ROOT, profile)} update @openai/codex @openai/codex-darwin-arm64`);
        emit(`       或在 ${join(PROFILE_ROOT, profile, "package.json")} 加 pnpm.overrides 后：`);
        emit(`       pnpm -C ${join(PROFILE_ROOT, profile)} install && 重启 DSH`);
        emit("    B) 不动 DSH：把兼容层/适配器的 codexBinaryPath 指向基线绝对路径：");
        emit(`       ${resolved.ok ? resolved.display : "<codex 绝对路径>"}`);
        emit("    升级后复跑：pnpm -s baseline:codex -- --strict-bundle");
        diag.push(`profile 旧载荷 DIFF: ${diffs.map((d) => `${d.profile}=${d.version}`).join(", ")} vs 基线 ${hostVersion ?? "未解析"}`);
      }
    }
  } finally {
    if (schemaDir !== undefined && !keepDir) {
      try {
        rmSync(schemaDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }

  // ---------------- 汇总
  const failed = checks.filter((c) => c.status === "FAIL");
  const warned = checks.filter((c) => c.status === "INFO" && c.id.startsWith("bundle:"));
  const ok = failed.length === 0;

  if (!cli.json) {
    emit("");
    emit("------------------------------------------------------------");
    emit(`RESULT: ${ok ? "PASS" : "FAIL"}  (assertions: ${checks.filter((c) => c.status === "PASS").length} pass, ${failed.length} fail, ${warned.length} warn)`);
    if (!ok) {
      emit("");
      emit("DIAG 复现命令：");
      for (const line of diag.length > 0 ? diag : ["（无额外诊断）"]) emit(`  - ${line}`);
      if (resolved.ok) {
        emit(`  - ${resolved.display} --version`);
        emit(`  - ${resolved.display} app-server generate-json-schema --out /tmp/cx && ls /tmp/cx | wc -l`);
      }
      emit("  - 本次未运行任何 turn / 未读取 ~/.codex 会话或凭据（零额度）");
    }
  } else {
    process.stdout.write(
      JSON.stringify(
        {
          ok,
          binary: resolved.ok ? resolved.display : null,
          expect: { versionPrefix: cli.expectVersionPrefix, ...cli.expect },
          checks,
          bundleWarnings: diffsOf(checks),
          strictBundle: cli.strictBundle,
        },
        null,
        2,
      ) + "\n",
    );
  }

  process.exit(ok ? 0 : 1);
}

/** 计数目录顶层条目数（与 `ls | wc -l` 同口径：37 JSON + v1/ + v2/ = 39）。 */
function countEntries(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function diffsOf(list) {
  return list.filter((c) => c.status !== "PASS" && c.id.startsWith("bundle:")).map((c) => ({ id: c.id, detail: c.detail }));
}

main();
