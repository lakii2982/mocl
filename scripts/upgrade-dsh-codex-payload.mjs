#!/usr/bin/env node
/**
 * upgrade-dsh-codex-payload.mjs — 把 DSH profile 内的 codex 载荷升到基线版本（D-015 落地动作）。
 *
 * 为什么需要它：
 *   `@deepseek-ai/dsh-subagent-codex` 对 `@openai/codex` 是**精确依赖**，插件用
 *   `require.resolve("@openai/codex/package.json")` 定位二进制（无配置项可绕开），
 *   而 desktop profile 由 Electron 进程独占管理。手工改 node_modules / 手工 pnpm 都是
 *   "散改"，一旦失败很难说清改了什么。本脚本把这次动作变成可预览、可备份、可回滚的一步。
 *
 * 安全契约（务必遵守）：
 *   - **默认 dry-run**：只读、只打印计划，不写盘、不联网、不碰 pnpm。
 *   - `--apply` 前先落完整备份到 `var/backup/codex-payload-<ts>/`（package.json +
 *     pnpm-lock.yaml + 两个 @openai 载荷目录 + manifest.json + PLAN.txt）。
 *   - **不删除任何文件**：回滚 = 把备份覆盖回去，不 `rm -rf` 用户目录；备份里没有的多余
 *     文件只报告、不删除。
 *   - 升级后自动跑 `assert-codex-baseline.mjs --strict-bundle` 复验；任一步失败自动回滚。
 *   - 不发起任何模型调用（零额度）。
 *
 * 策略（--strategy auto|update|overrides）：
 *   - update    ：profile 的 package.json **直接声明** `@openai/codex` 时，跑
 *                 `pnpm --dir <profile> update @openai/codex@<target>`。
 *   - overrides ：（本机实际情况）`@openai/codex` 只是插件的传递依赖。此时 `pnpm update`
 *                 不可靠，且 `@openai/codex-darwin-arm64@<target>` 这个 spec 在 registry 上
 *                 并不存在 —— profile 里那个目录是**别名**（其 package.json 的 name 是
 *                 `@openai/codex`，version 是 `<ver>-darwin-arm64`，lockfile 里写作
 *                 `npm:@openai/codex@<ver>-darwin-arm64`）。所以正确做法是把两条 override
 *                 写进 profile 的 package.json 再 `pnpm install`。
 *   - auto      ：默认；按上面规则自动选，dry-run 里会解释为什么。
 *
 * 退出码：
 *   0 = 成功（dry-run 计划已打印 / apply 完成并复验通过 / rollback 完成）
 *   1 = 业务失败（pnpm 非零且非独占类错误、复验失败、备份/回滚失败等；已尽力自动回滚）
 *   2 = 用法错误
 *   3 = 环境不支持（Electron/DSH 独占导致文件锁、profile 不可写、缺 pnpm/宿主 codex 等）
 *       —— 此时脚本**不会静默失败**，会打印替代路径（在 DSH 内操作 / codexBinaryPath 指向宿主基线）
 *
 * 用法：
 *   node scripts/upgrade-dsh-codex-payload.mjs                     # dry-run（默认）
 *   node scripts/upgrade-dsh-codex-payload.mjs --dry-run --json
 *   node scripts/upgrade-dsh-codex-payload.mjs --apply             # 真升级（需用户确认后执行）
 *   node scripts/upgrade-dsh-codex-payload.mjs --rollback var/backup/codex-payload-20261026-010203
 *   # 测试/CI 专用：--profile-root <假目录> --backup-root <tmp> --pnpm <假 pnpm> --verify-script <stub>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, ENV: 3 };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROFILE_ROOT = join(homedir(), ".dsh", "profiles");
const DEFAULT_PROFILE = "desktop";
const DEFAULT_BACKUP_ROOT = join(REPO_ROOT, "var", "backup");
const DEFAULT_VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "assert-codex-baseline.mjs");
const CODEX_PKG = "@openai/codex";
const PLATFORM_PKG_ALIAS = "@openai/codex-darwin-arm64"; // 仅用于 profile 内目录名与 override 键
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const HOST_VERSION_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------ 输出与状态
const state = {
  json: false,
  lines: [],
  steps: [],
  warnings: [],
  blockers: [],
  plan: null,
  backup: null,
  rollback: null,
  exitCode: EXIT.OK,
};

function emit(line = "") {
  state.lines.push(line);
  if (!state.json) process.stdout.write(line + "\n");
}
function emitErr(line) {
  process.stderr.write(line + "\n");
}
function step(name, status, detail = "") {
  state.steps.push({ name, status, detail });
  emit(`  ${status.padEnd(6)} ${name}${detail ? `: ${detail}` : ""}`);
}
function warn(text) {
  state.warnings.push(text);
  emit(`  WARN  ${text}`);
}

function usage(stream = process.stdout) {
  stream.write(
    [
      "用法: node scripts/upgrade-dsh-codex-payload.mjs [options]",
      "",
      "  --dry-run                 只打印升级计划（默认行为，不写盘、不跑 pnpm）",
      "  --apply                   执行升级（先备份 → 升级 → 严格门禁复验；失败自动回滚）",
      "  --rollback <backupDir>    从备份还原（不删除任何文件，只覆盖回备份内容）",
      "  --profile <name>          profile 名（默认 desktop）",
      "  --target <version>        目标 codex 版本（默认取 PATH 上 `codex --version`，如 0.164.0）",
      "  --strategy <auto|update|overrides>  升级策略（默认 auto，见文件头注释）",
      "  --json                    输出机器可读 JSON",
      "",
      "  # 测试/CI 钩子（默认指向真实 DSH profile，勿在真环境乱用）",
      "  --profile-root <dir>      profile 根目录（默认 ~/.dsh/profiles）",
      "  --backup-root <dir>       备份根目录（默认 <repo>/var/backup）",
      "  --pnpm <path>             pnpm 可执行文件（默认 PATH 上的 pnpm）",
      "  --verify-script <path>    复验脚本（默认 scripts/assert-codex-baseline.mjs）",
      "  --timeout-ms <n>          pnpm 超时（默认 600000）",
      "  -h, --help                显示本帮助",
      "",
      "退出码: 0=成功 1=业务失败(已尽力回滚) 2=用法错误 3=环境不支持(独占/不可写/缺依赖)",
    ].join("\n") + "\n",
  );
}

// ------------------------------------------------------------------ 参数
function parseCli(rawArgv) {
  // `pnpm -s upgrade:codex -- --dry-run` 会把字面量 `--` 一起传进来，剥掉首个。
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "dry-run": { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        rollback: { type: "string" },
        profile: { type: "string", default: DEFAULT_PROFILE },
        target: { type: "string" },
        strategy: { type: "string", default: "auto" },
        json: { type: "boolean", default: false },
        "profile-root": { type: "string" },
        "backup-root": { type: "string" },
        pnpm: { type: "string" },
        "verify-script": { type: "string" },
        "timeout-ms": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    emitErr(`[upgrade-codex] 参数错误: ${/** @type {Error} */ (error).message}`);
    usage(process.stderr);
    process.exit(EXIT.USAGE);
  }

  if (values.help) {
    usage();
    process.exit(EXIT.OK);
  }
  if (values["dry-run"] && values.apply) {
    emitErr("[upgrade-codex] 参数错误: --dry-run 与 --apply 互斥");
    process.exit(EXIT.USAGE);
  }
  if (values.rollback !== undefined && values.apply) {
    emitErr("[upgrade-codex] 参数错误: --rollback 与 --apply 互斥");
    process.exit(EXIT.USAGE);
  }
  const strategy = values.strategy ?? "auto";
  if (!["auto", "update", "overrides"].includes(strategy)) {
    emitErr(`[upgrade-codex] 参数错误: --strategy 只能是 auto|update|overrides，收到 ${JSON.stringify(strategy)}`);
    process.exit(EXIT.USAGE);
  }
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    emitErr(`[upgrade-codex] 参数错误: --timeout-ms 需要正整数，收到 ${JSON.stringify(values["timeout-ms"])}`);
    process.exit(EXIT.USAGE);
  }

  return {
    mode: values.rollback !== undefined ? "rollback" : values.apply ? "apply" : "dry-run",
    rollbackDir: values.rollback === undefined ? undefined : resolve(values.rollback),
    profile: values.profile ?? DEFAULT_PROFILE,
    profileRoot: values["profile-root"] === undefined ? DEFAULT_PROFILE_ROOT : resolve(values["profile-root"]),
    backupRoot: values["backup-root"] === undefined ? DEFAULT_BACKUP_ROOT : resolve(values["backup-root"]),
    target: values.target,
    strategy,
    json: Boolean(values.json),
    pnpm: values.pnpm,
    verifyScript: values["verify-script"] === undefined ? DEFAULT_VERIFY_SCRIPT : resolve(values["verify-script"]),
    timeoutMs,
  };
}

// ------------------------------------------------------------------ 小工具
function which(command) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
  }
  return undefined;
}

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: options.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  return {
    argv,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
    timedOut: result.error?.message.includes("ETIMEDOUT") ?? false,
  };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function semverOf(text) {
  const match = /(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text ?? "");
  return match ? { core: match[1], suffix: match[2] } : undefined;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 递归列出目录下的普通文件（相对路径 → 绝对路径），按路径排序保证可复现。 */
function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) walkFiles(abs, base, out);
    else if (stat.isFile()) out.push({ abs, rel: relative(base, abs), size: stat.size });
  }
  return out;
}

/**
 * 把 source 目录的**内容**复制进 destination（destination 可以已存在）。
 * 语义等价 `cp -R source/. destination`：覆盖同名文件、保留 destination 里多出的文件
 * —— 这是回滚"只覆盖不删除"的安全前提。
 * macOS 上优先 clonefile（`cp -c`），秒级且不额外占空间；失败回退逐项复制。
 */
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  if (process.platform === "darwin" && existsSync("/bin/cp")) {
    // 注意：必须用字符串拼接保留结尾 "/."，path.join 会把 "." 规范化掉，导致 cp 把目录自身套进目标。
    const cloned = run(["/bin/cp", "-c", "-R", `${source}/.`, destination]);
    if (cloned.status === 0) return "clonefile";
  }
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(destination, name), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }
  return "copy";
}

function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 平台载荷的 npm 版本后缀，如 darwin-arm64。 */
function platformSuffix() {
  const os = process.platform === "win32" ? "win32" : process.platform;
  return `${os}-${process.arch}`;
}

function detectDshRunning() {
  try {
    const result = run(["pgrep", "-f", "DeepSeek Harness"], { timeoutMs: 5000 });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function hostCodexVersion() {
  const binary = which("codex");
  if (binary === undefined) return { binary: undefined, version: undefined };
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: HOST_VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { binary, version: semverOf(out)?.core, raw: out.trim() };
  } catch (error) {
    return { binary, version: undefined, error: /** @type {Error} */ (error).message.split("\n")[0] };
  }
}

// ------------------------------------------------------------------ 计划构建
function buildPlan(cli) {
  const profileDir = join(cli.profileRoot, cli.profile);
  const paths = {
    profileDir,
    packageJson: join(profileDir, "package.json"),
    lockfile: join(profileDir, "pnpm-lock.yaml"),
    codexDir: join(profileDir, "node_modules", ...CODEX_PKG.split("/")),
    codexPackageJson: join(profileDir, "node_modules", ...CODEX_PKG.split("/"), "package.json"),
    platformDir: join(profileDir, "node_modules", ...PLATFORM_PKG_ALIAS.split("/")),
    platformPackageJson: join(profileDir, "node_modules", ...PLATFORM_PKG_ALIAS.split("/"), "package.json"),
  };
  const suffix = platformSuffix();
  const vendorBin = join(paths.platformDir, "vendor", `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`, "bin", "codex");

  const blockers = [];
  const warnings = [];

  if (!existsSync(cli.profileRoot)) blockers.push(`profile 根目录不存在: ${cli.profileRoot}`);
  if (!existsSync(profileDir)) blockers.push(`profile 不存在: ${profileDir}`);
  if (!existsSync(paths.packageJson)) blockers.push(`缺少 ${paths.packageJson}`);

  let profilePkg;
  try {
    profilePkg = existsSync(paths.packageJson) ? readJsonFile(paths.packageJson) : undefined;
  } catch (error) {
    blockers.push(`无法解析 ${paths.packageJson}: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
  }

  const installedCodexVersion = readOptionalVersion(paths.codexPackageJson);
  const installedPlatformVersion = readOptionalVersion(paths.platformPackageJson);
  let vendorVersion;
  let vendorError;
  if (existsSync(vendorBin)) {
    try {
      vendorVersion = semverOf(
        execFileSync(vendorBin, ["--version"], { encoding: "utf8", timeout: HOST_VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }),
      )?.core;
    } catch (error) {
      vendorError = /** @type {Error} */ (error).message.split("\n")[0];
    }
  }

  const host = hostCodexVersion();
  const target = cli.target === undefined ? host.version : semverOf(cli.target)?.core;
  if (target === undefined) {
    if (cli.target !== undefined) blockers.push(`--target 无法解析为版本号: ${JSON.stringify(cli.target)}`);
    else blockers.push("PATH 上找不到 codex 或无法解析其版本；请显式传 --target <version>");
  }

  const pnpmBin = cli.pnpm ?? which("pnpm");
  if (pnpmBin === undefined) blockers.push("PATH 上找不到 pnpm（可用 --pnpm 指定）");

  const directDependency = Object.prototype.hasOwnProperty.call(profilePkg?.dependencies ?? {}, CODEX_PKG);
  const strategy = cli.strategy === "auto" ? (directDependency ? "update" : "overrides") : cli.strategy;

  if (strategy === "update" && !directDependency) {
    blockers.push(
      `--strategy update 不可用：${paths.packageJson} 未直接声明 ${CODEX_PKG}（它只是插件的传递依赖）。请用 --strategy overrides。`,
    );
  }

  const dshRunning = detectDshRunning();
  if (dshRunning) {
    warnings.push("检测到 DeepSeek Harness (Electron) 正在运行：pnpm 可能因文件被占用失败（EBUSY/EPERM）。建议先退出 DSH 再 --apply。");
  }

  const backupDir = join(cli.backupRoot, `codex-payload-${stamp()}`);
  const verifyArgv = [
    process.execPath,
    cli.verifyScript,
    "--strict-bundle",
    "--profile-root",
    cli.profileRoot,
    ...(host.binary === undefined ? [] : ["--binary", host.binary]),
  ];

  return {
    mode: cli.mode,
    profile: cli.profile,
    profileRoot: cli.profileRoot,
    profileDir,
    paths,
    vendorBin,
    platformSuffix: suffix,
    current: {
      cliDeclaration: profilePkg?.dependencies?.[CODEX_PKG],
      directDependency,
      codexPackageJsonVersion: installedCodexVersion,
      platformPackageName: (() => {
        try {
          return readJsonFile(paths.platformPackageJson).name;
        } catch {
          return undefined;
        }
      })(),
      platformVersion: installedPlatformVersion,
      vendorVersion,
      vendorError,
    },
    host,
    target,
    strategy,
    pnpmBin,
    dshRunning,
    backupDir,
    backupItems: buildBackupItems(paths),
    upgrade: buildUpgradeSteps(strategy, target, pnpmBin, profileDir),
    verify: { script: cli.verifyScript, argv: verifyArgv },
    blockers,
    warnings,
    timeoutMs: cli.timeoutMs,
  };
}

function readOptionalVersion(path) {
  try {
    return readJsonFile(path).version;
  } catch {
    return undefined;
  }
}

function buildBackupItems(paths) {
  const items = [{ label: "package.json", source: paths.packageJson, kind: "file" }];
  if (existsSync(paths.lockfile)) items.push({ label: "pnpm-lock.yaml", source: paths.lockfile, kind: "file" });
  items.push({ label: `node_modules/${CODEX_PKG}`, source: paths.codexDir, kind: "dir" });
  items.push({ label: `node_modules/${PLATFORM_PKG_ALIAS}`, source: paths.platformDir, kind: "dir" });
  return items;
}

function buildUpgradeSteps(strategy, target, pnpmBin, profileDir) {
  if (strategy === "update") {
    return [
      {
        kind: "pnpm",
        label: `pnpm --dir <profile> update ${CODEX_PKG}@${target}`,
        argv: [pnpmBin, "--dir", profileDir, "update", `${CODEX_PKG}@${target}`],
      },
    ];
  }
  return [
    {
      kind: "write-overrides",
      label: `在 <profile>/package.json 写入 pnpm.overrides（${CODEX_PKG}=${target}，${PLATFORM_PKG_ALIAS}=npm:@openai/codex@${target}-${platformSuffix()}）`,
    },
    {
      kind: "pnpm",
      label: "pnpm --dir <profile> install --no-frozen-lockfile",
      argv: [pnpmBin, "--dir", profileDir, "install", "--no-frozen-lockfile"],
    },
  ];
}

// ------------------------------------------------------------------ 计划渲染
function renderPlan(plan) {
  const currentVendor = plan.current.vendorVersion ?? "未探测到";
  emit("== DSH profile codex 载荷升级计划 ==");
  emit(`  mode        : ${plan.mode}`);
  emit(`  profile     : ${plan.profile}（root=${plan.profileRoot}）`);
  emit(`  profile dir : ${plan.profileDir}`);
  emit("  -- 当前状态 --");
  emit(`    profile 声明 ${CODEX_PKG}     : ${plan.current.cliDeclaration ?? "<未直接声明（传递依赖）>"}`);
  emit(`    已装 ${CODEX_PKG} 版本        : ${plan.current.codexPackageJsonVersion ?? "<缺失>"}`);
  emit(`    平台载荷 ${PLATFORM_PKG_ALIAS} : ${plan.current.platformVersion ?? "<缺失>"}（包名 ${plan.current.platformPackageName ?? "?"}）`);
  emit(`    vendor 二进制版本           : ${currentVendor}${plan.current.vendorError ? `（探测失败: ${plan.current.vendorError}）` : ""}`);
  emit(`  基线（PATH 上 codex）        : ${plan.host.version ?? "<未找到>"}  ${plan.host.binary ?? ""}`);
  emit(`  目标版本                    : ${plan.target ?? "<未确定>"}`);
  emit(`  是否已达标                  : ${isAlreadyOnTarget(plan) ? "是（无需升级）" : "否"}`);
  emit(`  升级策略                    : ${plan.strategy}`);
  emit("");
  emit("  -- 备份（仅 --apply 时执行，先备份再动任何文件）--");
  emit(`    备份目录 : ${plan.backupDir}`);
  for (const item of plan.backupItems) emit(`    保留     : ${item.label}`);
  emit("");
  emit("  -- 将执行的命令 --");
  plan.upgrade.forEach((upgradeStep, index) => emit(`    ${index + 1}. ${upgradeStep.label}`));
  if (plan.strategy === "overrides") {
    emit("    说明：不使用字面量 `pnpm update @openai/codex-darwin-arm64@<target>`，因为该 spec 在");
    emit("          registry 上不存在（profile 里的目录是 npm 别名，真实发布物叫");
    emit(`          @openai/codex@<target>-${plan.platformSuffix}）。overrides 是确定性的写法。`);
  }
  emit("");
  emit("  -- 复验（升级后自动执行；非零即视为失败并回滚）--");
  emit(`    ${plan.verify.argv.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")}`);
  emit("");
  emit("  -- 回滚 --");
  emit(`    node scripts/upgrade-dsh-codex-payload.mjs --rollback ${plan.backupDir}`);
  emit("    （回滚 = 把备份覆盖回去，不删除任何用户文件）");
  if (plan.warnings.length > 0) {
    emit("");
    for (const text of plan.warnings) emit(`  WARN  ${text}`);
  }
  if (plan.blockers.length > 0) {
    emit("");
    for (const text of plan.blockers) emit(`  BLOCK ${text}`);
  }
  emit("");
}

function isAlreadyOnTarget(plan) {
  if (plan.target === undefined) return false;
  return (
    plan.current.vendorVersion === plan.target &&
    plan.current.codexPackageJsonVersion === plan.target &&
    (plan.current.platformVersion ?? "").startsWith(plan.target)
  );
}

// ------------------------------------------------------------------ 备份 / 回滚
function sha256DirManifest(dir) {
  const files = {};
  for (const file of walkFiles(dir)) files[file.rel] = sha256File(file.abs);
  return files;
}

function doBackup(plan) {
  mkdirSync(plan.backupDir, { recursive: true });
  const manifest = {
    schema: "mocl.codex-payload-backup/v1",
    createdAt: new Date().toISOString(),
    profile: plan.profile,
    profileRoot: plan.profileRoot,
    profileDir: plan.profileDir,
    target: plan.target,
    from: {
      codexPackageJsonVersion: plan.current.codexPackageJsonVersion ?? null,
      platformVersion: plan.current.platformVersion ?? null,
      vendorVersion: plan.current.vendorVersion ?? null,
    },
    items: [],
  };
  for (const item of plan.backupItems) {
    const destination = join(plan.backupDir, item.label);
    if (!existsSync(item.source)) {
      manifest.items.push({ label: item.label, kind: item.kind, present: false });
      continue;
    }
    const method = item.kind === "dir" ? copyTree(item.source, destination) : (copyFile(item.source, destination), "copy");
    manifest.items.push({
      label: item.label,
      kind: item.kind,
      present: true,
      method,
      sha256: item.kind === "file" ? sha256File(destination) : undefined,
      files: item.kind === "dir" ? sha256DirManifest(destination) : undefined,
    });
  }
  writeFileSync(join(plan.backupDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(plan.backupDir, "PLAN.txt"), state.lines.join("\n") + "\n");
  return manifest;
}

function restoreFromBackup(backupDir, profileDir) {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`备份缺少 manifest.json: ${manifestPath}`);
  }
  const manifest = readJsonFile(manifestPath);
  const restored = [];
  const mismatched = [];
  for (const item of manifest.items ?? []) {
    if (item.present === false) continue;
    const source = join(backupDir, item.label);
    const destination = join(profileDir, item.label);
    if (!existsSync(source)) continue;
    if (item.kind === "dir") {
      copyTree(source, destination);
      const expected = item.files ?? {};
      for (const [rel, hash] of Object.entries(expected)) {
        const abs = join(destination, rel);
        if (!existsSync(abs) || sha256File(abs) !== hash) mismatched.push(`${item.label}/${rel}`);
      }
    } else {
      copyFile(source, destination);
      if (item.sha256 !== undefined && sha256File(destination) !== item.sha256) mismatched.push(item.label);
    }
    restored.push(item.label);
  }
  return { manifest, restored, mismatched };
}

// ------------------------------------------------------------------ 升级执行
function applyOverrides(plan) {
  const pkg = readJsonFile(plan.paths.packageJson);
  pkg.pnpm = pkg.pnpm ?? {};
  pkg.pnpm.overrides = pkg.pnpm.overrides ?? {};
  pkg.pnpm.overrides[CODEX_PKG] = plan.target;
  pkg.pnpm.overrides[PLATFORM_PKG_ALIAS] = `npm:@openai/codex@${plan.target}-${plan.platformSuffix}`;
  writeFileSync(plan.paths.packageJson, JSON.stringify(pkg, null, 2) + "\n");
}

const ENV_FAILURE_PATTERNS = [
  /EBUSY/,
  /EPERM/,
  /ELOCKED/,
  /EACCES/,
  /ENOTEMPTY/,
  /resource busy/i,
  /operation not permitted/i,
  /being used by another process/i,
  /Text file busy/i,
  /cannot access .*: Permission denied/i,
];

function looksLikeEnvironmentFailure(text) {
  return ENV_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function readVersions(plan) {
  return {
    codexPackageJsonVersion: readOptionalVersion(plan.paths.codexPackageJson),
    platformVersion: readOptionalVersion(plan.paths.platformPackageJson),
    vendorVersion: (() => {
      if (!existsSync(plan.vendorBin)) return undefined;
      try {
        return semverOf(
          execFileSync(plan.vendorBin, ["--version"], { encoding: "utf8", timeout: HOST_VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }),
        )?.core;
      } catch {
        return undefined;
      }
    })(),
  };
}

function runUpgradeSteps(plan) {
  for (const upgradeStep of plan.upgrade) {
    if (upgradeStep.kind === "write-overrides") {
      applyOverrides(plan);
      step("write-overrides", "OK", "pnpm.overrides 已写入 profile package.json");
      continue;
    }
    const result = run(upgradeStep.argv, { timeoutMs: plan.timeoutMs });
    const detail = `exit=${result.status}${result.timedOut ? " TIMEOUT" : ""}`;
    if (result.status !== 0) {
      return { ok: false, result, detail };
    }
    step(`pnpm(${upgradeStep.argv.slice(-1)[0]})`, "OK", detail);
  }
  return { ok: true };
}

function envGuidance(plan, tail) {
  emit("");
  emit("  == 环境不支持（Electron/DSH 独占或权限），升级未完成 ==");
  emit(`  pnpm 输出尾部: ${tail.replace(/\n/g, " | ").slice(0, 400)}`);
  emit("");
  emit("  这是**可预期的环境限制**，不是脚本 bug。请按以下任一路径继续（脚本不会静默失败）：");
  emit("  A) 退出 DeepSeek Harness（含托盘/后台进程）后重跑：");
  emit("       node scripts/upgrade-dsh-codex-payload.mjs --apply");
  emit("       （或等 DSH 官方发版把 profile 载荷带到基线）");
  emit("  B) 在 DSH 的插件管理页操作：升级 @deepseek-ai/dsh-subagent-codex 及其 @openai/codex 载荷到 0.164.0");
  emit("  C) 不动 DSH：把兼容层/适配器的 codexBinaryPath 指向宿主基线二进制，DSH 现有插件继续用它自己的旧载荷");
  emit(`       ${plan.host.binary ?? "<PATH 上的 codex>"}`);
  emit("       两套路径并存期必须在配置里显式声明用哪套（见 docs/integration/01-config-and-enable.md）。");
  emit("");
  emit(`  已备份目录（本次未改动 profile 内容，备份保留供核对）：${plan.backupDir}`);
}

function rollbackAndReport(plan, reason) {
  emit("");
  emit(`  == 自动回滚（原因：${reason}）==`);
  try {
    const { restored, mismatched } = restoreFromBackup(plan.backupDir, plan.profileDir);
    if (mismatched.length === 0) {
      step("rollback", "OK", `已还原 ${restored.join(", ")}，字节一致`);
    } else {
      step("rollback", "FAIL", `还原后仍不一致: ${mismatched.slice(0, 5).join(", ")}`);
      return false;
    }
    return true;
  } catch (error) {
    step("rollback", "FAIL", /** @type {Error} */ (error).message.split("\n")[0]);
    return false;
  }
}

function execApply(plan) {
  emit("== 执行升级（--apply）==");
  emit(`  目标版本: ${plan.target}`);
  emit(`  备份目录: ${plan.backupDir}`);
  emit("");
  let manifest;
  try {
    manifest = doBackup(plan);
    step("backup", "OK", `${plan.backupDir}（${manifest.items.length} 项）`);
  } catch (error) {
    step("backup", "FAIL", /** @type {Error} */ (error).message.split("\n")[0]);
    emit("");
    emit("  备份失败 → 未对 profile 做任何修改（安全中止）。");
    return EXIT.FAIL;
  }

  const upgradeResult = runUpgradeSteps(plan);
  if (!upgradeResult.ok) {
    const combined = `${upgradeResult.result.stderr}\n${upgradeResult.result.stdout}`;
    const environmentIssue = looksLikeEnvironmentFailure(combined);
    step("upgrade", "FAIL", upgradeResult.detail);
    rollbackAndReport(plan, `pnpm ${upgradeResult.detail}`);
    if (environmentIssue) {
      envGuidance(plan, combined);
      return EXIT.ENV;
    }
    emit("");
    emit("  回滚完成。请把上面的 pnpm 报错贴给维护者；profile 已还原到升级前状态。");
    return EXIT.FAIL;
  }
  step("upgrade", "OK", `已执行 ${plan.upgrade.length} 步`);
  emit("");

  const after = readVersions(plan);
  emit("  -- 升级后版本 --");
  emit(`    ${CODEX_PKG}            : ${after.codexPackageJsonVersion ?? "<缺失>"}`);
  emit(`    ${PLATFORM_PKG_ALIAS}  : ${after.platformVersion ?? "<缺失>"}`);
  emit(`    vendor 二进制           : ${after.vendorVersion ?? "<缺失>"}`);
  if (after.vendorVersion !== plan.target) {
    step("postcheck", "FAIL", `vendor 版本 ${after.vendorVersion ?? "<缺失>"} != 目标 ${plan.target}`);
    rollbackAndReport(plan, "升级后 vendor 版本未达目标");
    return EXIT.FAIL;
  }
  step("postcheck", "OK", `vendor = ${after.vendorVersion}`);
  emit("");

  emit("  -- 严格门禁复验（assert-codex-baseline --strict-bundle）--");
  const verify = run(plan.verify.argv, { timeoutMs: plan.timeoutMs });
  const verifyTail = `${verify.stdout}\n${verify.stderr}`.trim().split("\n").slice(-6).join("\n");
  emit(verifyTail.replace(/^/gm, "    "));
  if (verify.status !== 0) {
    step("verify", "FAIL", `exit=${verify.status}`);
    rollbackAndReport(plan, "严格门禁复验失败");
    return EXIT.FAIL;
  }
  step("verify", "OK", "strict-bundle 通过（两处版本 SAME）");
  emit("");
  emit("== 升级完成 ==");
  emit(`  备份保留在: ${plan.backupDir}`);
  emit(`  回滚命令  : node scripts/upgrade-dsh-codex-payload.mjs --rollback ${plan.backupDir}`);
  emit("  下一步    : 重启 DSH，然后跑 `pnpm -s baseline:codex -- --strict-bundle` 与 C4 smoke。");
  return EXIT.OK;
}

function execRollback(cli) {
  const backupDir = cli.rollbackDir;
  emit("== 从备份回滚 ==");
  emit(`  备份目录: ${backupDir}`);
  if (!existsSync(backupDir)) {
    emit(`  FAIL  备份目录不存在: ${backupDir}`);
    return EXIT.FAIL;
  }
  let manifest;
  try {
    manifest = readJsonFile(join(backupDir, "manifest.json"));
  } catch (error) {
    emit(`  FAIL  无法读取 manifest.json: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    return EXIT.FAIL;
  }
  const profileDir = manifest.profileDir ?? join(cli.profileRoot, manifest.profile ?? cli.profile);
  emit(`  目标 profile: ${profileDir}（备份创建于 ${manifest.createdAt ?? "?"}，备份时版本 ${JSON.stringify(manifest.from ?? {})}）`);
  try {
    const { restored, mismatched } = restoreFromBackup(backupDir, profileDir);
    step("restore", "OK", restored.join(", "));
    if (mismatched.length > 0) {
      step("verify-restore", "FAIL", `不一致: ${mismatched.slice(0, 5).join(", ")}`);
      return EXIT.FAIL;
    }
    step("verify-restore", "OK", "所有文件与备份字节一致");
  } catch (error) {
    step("restore", "FAIL", /** @type {Error} */ (error).message.split("\n")[0]);
    return EXIT.FAIL;
  }
  // 只报告、不删除备份外的多余文件（安全契约：不删用户文件）。
  const extras = [];
  for (const item of manifest.items ?? []) {
    if (item.kind !== "dir" || item.present === false) continue;
    const expected = new Set(Object.keys(item.files ?? {}));
    for (const file of walkFiles(join(profileDir, item.label))) {
      if (!expected.has(file.rel)) extras.push(`${item.label}/${file.rel}`);
    }
  }
  if (extras.length > 0) {
    emit(`  INFO  备份外多出 ${extras.length} 个文件（按安全契约未删除，需人工确认）:`);
    for (const extra of extras.slice(0, 5)) emit(`          ${extra}`);
  }
  const versions = readVersions({ paths: { codexPackageJson: join(profileDir, "node_modules", ...CODEX_PKG.split("/"), "package.json"), platformPackageJson: join(profileDir, "node_modules", ...PLATFORM_PKG_ALIAS.split("/"), "package.json"), vendorBin: join(profileDir, "node_modules", ...PLATFORM_PKG_ALIAS.split("/"), "vendor", `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`, "bin", "codex") } });
  emit(`  回滚后版本: ${CODEX_PKG}=${versions.codexPackageJsonVersion ?? "<缺失>"}, vendor=${versions.vendorVersion ?? "<缺失>"}`);
  emit("  下一步    : 重启 DSH；`pnpm -s baseline:codex` 会重新显示 bundle DIFF 警告（预期，不是回归）。");
  return EXIT.OK;
}

// ------------------------------------------------------------------ main
function main() {
  const cli = parseCli(process.argv.slice(2));
  state.json = cli.json;

  let exitCode;
  if (cli.mode === "rollback") {
    exitCode = execRollback(cli);
  } else {
    const plan = buildPlan(cli);
    state.plan = plan;
    renderPlan(plan);

    if (cli.mode === "dry-run") {
      if (plan.blockers.length > 0) {
        emit("  结论: 计划不完整（见上面 BLOCK），dry-run 不写盘；请先解决阻塞项。");
        exitCode = EXIT.ENV;
      } else if (isAlreadyOnTarget(plan)) {
        emit("  结论: profile 已在目标版本，无需 --apply。");
        exitCode = EXIT.OK;
      } else {
        emit("  结论: dry-run 完成（未写盘、未调用 pnpm）。确认无误后执行：");
        emit("        node scripts/upgrade-dsh-codex-payload.mjs --apply");
        exitCode = EXIT.OK;
      }
    } else if (plan.blockers.length > 0) {
      emit("  结论: 存在阻塞项，--apply 拒绝执行（未做任何修改）。");
      for (const text of plan.blockers) emit(`    BLOCK ${text}`);
      exitCode = EXIT.ENV;
    } else {
      exitCode = execApply(plan);
    }
  }

  if (state.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: exitCode === EXIT.OK,
          exitCode,
          mode: cli.mode,
          plan: state.plan,
          steps: state.steps,
          backup: state.plan?.backupDir ?? null,
          warnings: state.warnings,
          lines: state.lines,
        },
        null,
        2,
      ) + "\n",
    );
  }
  process.exit(exitCode);
}

main();
