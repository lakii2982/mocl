#!/usr/bin/env node
/**
 * 构建可安装的 MOCL 插件包（dist/plugin-package）：
 * - 用 tsconfig.build.json 把 src 下的 TS 编译成 JS（node_modules 下 Node 不做 TS 类型剥离）；
 * - 生成 package.json（含 meta 展示信息 + dsh.bundle.patch，使插件出现在 DSH「插件」页）；
 * - 生成 bundle patch（insert id=mocl，configPath 指向本仓 config.local.json）。
 *
 * 用法：node tools/build-plugin-package.mjs [--version <semver>]
 * 之后：dsh plugin --profile desktop remove @mocl/dsh-plugin && dsh plugin --profile desktop add file:$PWD/dist/plugin-package
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(root, "dist", "plugin-package");
const configPath =
  process.env.MOCL_CONFIG_PATH ??
  (existsSync(join(root, "config.local.json"))
    ? join(root, "config.local.json")
    : join(root, "config.example.json"));

const versionArgIndex = process.argv.indexOf("--version");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const version = versionArgIndex >= 0 ? process.argv[versionArgIndex + 1] : `0.0.0-local.${stamp}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("[build] tsc → dist/plugin-package/src");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });

// W2：client 半（lazy-CJS + client.css）打进来；脚本内自带首行 / node --check / 令牌校验。
console.log("[build] esbuild client 半 → dist/plugin-package/client.js(+client.css)");
execFileSync(process.execPath, [join(root, "tools", "build-client.mjs")], { cwd: root, stdio: "inherit" });
if (!existsSync(join(out, "client.js")) || !existsSync(join(out, "client.css"))) {
  throw new Error("[build] client 半产物缺失（先 `pnpm -s install` 安装 esbuild，再重试）");
}

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "@mocl/dsh-plugin",
      version,
      private: true,
      type: "module",
      main: "index.mjs",
      // W2：boot graph 以 exports["./client"] 发现 client 半（spike/panel-spike/package.json 同形）。
      exports: { ".": "./index.mjs", "./client": "./client.js" },
      description: "MOCL 多智能体编排兼容层（subagent_agent / mocl_status / 外部代理面板）",
      meta: {
        title: "MOCL 多智能体编排",
        description: "在 DSH 内编排 codex / claude-code / kimi / opencode 外部编码子代理：subagent_agent 启动、mocl_status 查状态、右侧栏「外部代理」面板。",
      },
      dsh: {
        bundle: { patch: "./cordis.patch.yml" },
        // W2 §0.2/§0.5：非基线包必须在 dsh.client.inject 声明（boot graph 已实测解析该包）。
        client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-sidebar-right"] },
      },
      files: ["index.mjs", "client.js", "client.css", "cordis.patch.yml", "src"],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(out, "index.mjs"),
  "// MOCL 插件入口（编译产物；源码见 src/）\nexport * from './src/plugin/index.js';\n",
);

writeFileSync(
  join(out, "cordis.patch.yml"),
  `# MOCL 兼容层 bundle patch：插入插件行（configPath 指向施工仓运行时配置）
- insert:
    - id: mocl
      name: '@mocl/dsh-plugin'
      config:
        configPath: ${configPath}
`,
);

console.log(`[build] ${out} (version=${version}, configPath=${configPath})`);
