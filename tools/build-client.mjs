#!/usr/bin/env node
/**
 * W2：把 src/client-ui 打包成 DSH 可加载的 client 半。
 *
 * 产物形状（S1 实测，硬事实见 .agentspec/issues/18/W2.md §0.1 与 spike/reference/hmr-client.js）：
 *   window.__ModuleLoader__.load({
 *     id: "@mocl/dsh-plugin",
 *     factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports;
 *       // ...esbuild --format=cjs 打包产物（name/inject/apply）...
 *       return module.exports;
 *     }
 *   })
 *
 * 脚本内自带产物校验（不通过即非零退出，绝不静默）：
 * 1. 产物首行必须是 `window.__ModuleLoader__.load({`；
 * 2. `node --check` 必须通过；
 * 3. client.css 不得出现裸色值（只允许 --dsw-* / --ds-* 令牌）。
 *
 * esbuild 是 devDependency（由 Lead `pnpm -s install` 安装）；react / react-dom /
 * @deepseek-ai/* 全部 external（宿主静态模块表提供）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "dist", "plugin-package");
const outFile = join(outDir, "client.js");
const cssOutFile = join(outDir, "client.css");
const cssSrcFile = join(root, "src", "client-ui", "panel.css");
const LOADER_ID = "@mocl/dsh-plugin";

function fail(message) {
  console.error(`[build-client] ${message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let result;
try {
  result = await build({
    entryPoints: [join(root, "src", "client-ui", "index.tsx")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    // panel.css 以文本内联进 bundle（apply 运行时注入 <style>）；同目录另存 client.css。
    loader: { ".css": "text" },
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "@deepseek-ai/*"],
    legalComments: "none",
    logLevel: "warning",
  });
} catch (error) {
  fail(`esbuild 失败（先 \`pnpm -s install\` 安装 devDependencies）：${error?.message ?? error}`);
}

// write:false 且未指定 outdir 时，esbuild 的 outputFiles[].path 是 "<stdout>"（无 .js
// 后缀），不能按后缀挑 JS；panel.css 已被 loader:text 内联进 bundle，产物只可能多出
// CSS 输出（当前配置下不会），故按「非 CSS」取 JS，数量校验保持恰好 1。
const jsOutputs = (result.outputFiles ?? []).filter((file) => !file.path.endsWith(".css"));
if (jsOutputs.length !== 1) fail(`期望恰好 1 个 JS 输出，实际 ${jsOutputs.length}`);

// ── lazy-CJS 包装（首行即校验目标，保持与 spike/reference 完全同形） ──
const banner = [
  "window.__ModuleLoader__.load({",
  `\tid: ${JSON.stringify(LOADER_ID)},`,
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  "",
].join("\n");
const footer = ["", "\t\treturn module.exports;", "\t}", "});", ""].join("\n");
const finalText = banner + jsOutputs[0].text + footer;
writeFileSync(outFile, finalText);

// CSS：源文件原样拷入包目录（bundle 内已有同一份文本用于运行时注入）。
try {
  copyFileSync(cssSrcFile, cssOutFile);
} catch (error) {
  fail(`拷贝 client.css 失败：${error?.message ?? error}`);
}

// ── 产物校验 1：首行 ────────────────────────────────────────────────
const firstLine = finalText.split("\n", 1)[0];
if (firstLine !== "window.__ModuleLoader__.load({") {
  fail(`产物首行必须是 "window.__ModuleLoader__.load({"，实际："${firstLine}"`);
}

// ── 产物校验 2：语法（node --check，只解析不执行） ─────────────────
try {
  execFileSync(process.execPath, ["--check", outFile], { stdio: "inherit" });
} catch {
  fail("node --check 未通过（产物语法非法）");
}

// ── 产物校验 3：CSS 裸色值扫描（W2 硬约束：只允许令牌） ─────────────
const css = readFileSync(cssOutFile, "utf8");
const rawColor = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/);
if (rawColor !== null) {
  fail(`client.css 出现裸色值 "${rawColor[0]}"（样式只允许 --dsw-* / --ds-* 令牌，见 design/inputs/dsh-official-tokens.css）`);
}

console.log(`[build-client] ${outFile}（${Buffer.byteLength(finalText, "utf8")} bytes）`);
console.log(`[build-client] ${cssOutFile}（样式令牌校验通过）`);
