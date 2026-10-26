/**
 * S11 — 发布一致性（发布经理视角）。
 *
 * 人物：准备打 tag 的发布经理。
 * 人类动作：核对版本号、CHANGELOG、ABI 计数、README 声明、默认配置、patch 声明。
 * 判定：文档声明与实现一致；不一致就是发布事故的前兆。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITY_BITS, ERROR_CODES, EVENT_TYPES, METHOD_NAMES } from "../../src/abi/index.ts";
import { DEFAULT_CONFIG, validateConfig } from "../../src/facade/config.ts";
import { assertStaticPatchFiles, LEGACY_IDS, TOOL_NAMES } from "../../src/plugin/patch.ts";
import { canonicalJson } from "../lib/util.mjs";

function normalize(text) {
  return String(text).replace(/\s+/gu, " ");
}

export default {
  id: "S11",
  scope: "repo",
  title: "发布一致性（版本 / ABI / README / 配置 / patch）",
  persona: "准备打 tag 的发布经理",
  goal: "确认对外声明与实现一致，避免「文档说 46、实现是 45」这类发布事故",
  async run(ctx) {
    const read = (name) => readFile(join(ctx.repoRoot, name), "utf8");
    const pkg = JSON.parse(await read("package.json"));
    const changelog = await read("CHANGELOG.md");
    const readmeEn = await read("README.md");
    const readmeZh = await read("README.zh-CN.md");
    const nvmrc = (await read(".nvmrc")).trim();

    ctx.match("version:semver", pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    ctx.assert("engine:node>=24", String(pkg.engines?.node ?? "").includes(">=24"), String(pkg.engines?.node));
    ctx.equal("engine:nvmrc-matches", nvmrc, "24");

    const released = [...changelog.matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/gmu)].map((match) => match[1]);
    ctx.assert("changelog:has-version", released.includes(pkg.version), `released=${released.join(",")} package=${pkg.version}`);
    const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    ctx.assert(
      "changelog:not-empty",
      new RegExp(`##\\s+\\[?v?${escapedVersion}\\]?[\\s\\S]{80,}`, "u").test(changelog),
      `${pkg.version} 段落为空`,
    );

    ctx.equal("abi:errors", ERROR_CODES.length, 46);
    ctx.equal("abi:capabilities", CAPABILITY_BITS.length, 34);
    ctx.equal("abi:events", EVENT_TYPES.length, 35);
    ctx.equal("abi:methods", METHOD_NAMES.length, 18);

    const claimsEn = normalize(readmeEn);
    ctx.assert(
      "readme:en-counts",
      claimsEn.includes("**46** error codes, **34** capability bits, **35** event types, **18** methods"),
      "README.md 的 ABI 计数声明与实现不一致",
    );
    const claimsZh = normalize(readmeZh);
    ctx.assert(
      "readme:zh-counts",
      claimsZh.includes("**46** 错误码、**34** 能力位、 **35** 事件类型、**18** 方法") ||
        claimsZh.includes("**46** 错误码、**34** 能力位、**35** 事件类型、**18** 方法"),
      "README.zh-CN.md 的 ABI 计数声明与实现不一致",
    );

    const rawDefault = JSON.parse(await read("config.default.json"));
    ctx.assert(
      "config:default-file-matches-engine",
      canonicalJson(validateConfig(rawDefault)) === canonicalJson(DEFAULT_CONFIG),
      "config.default.json 与 DEFAULT_CONFIG 不一致",
    );
    ctx.assert("config:fail-closed", rawDefault.global?.enabled === false, String(rawDefault.global?.enabled));
    ctx.assert(
      "config:backends-off",
      ["codex", "claude-code", "kimi", "opencode"].every((backend) => rawDefault.backends?.[backend]?.enabled === false),
      JSON.stringify(Object.fromEntries(Object.entries(rawDefault.backends ?? {}).map(([id, value]) => [id, value.enabled]))),
    );

    const patch = assertStaticPatchFiles();
    ctx.assert("patch:plugin", patch.pluginId === "mocl", patch.pluginId);
    ctx.assert("patch:tools", patch.toolNames.join(",") === TOOL_NAMES.join(","), patch.toolNames.join(","));
    ctx.assert("patch:legacy", patch.legacyDisabled === LEGACY_IDS.length, String(patch.legacyDisabled));
    ctx.assert(
      "patch:docs-link",
      (await read("README.zh-CN.md")).includes("docs/integration/01-config-and-enable.md"),
      "README.zh-CN.md 未链接启用文档",
    );

    ctx.note(`repo=${pkg.name}@${pkg.version} commit=${ctx.repoRoot}`);
    await ctx.artifact("release-consistency.json", {
      version: pkg.version,
      abi: {
        errors: ERROR_CODES.length,
        capabilities: CAPABILITY_BITS.length,
        events: EVENT_TYPES.length,
        methods: METHOD_NAMES.length,
      },
      patch,
    });
  },
};
