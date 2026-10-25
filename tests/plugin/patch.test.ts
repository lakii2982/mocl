import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStaticPatchFiles,
  IMPL_ROOT,
  LEGACY_IDS,
  PATCH_DIR,
  PLUGIN_ID,
  PLUGIN_PACKAGE,
  TOOL_NAMES,
  parsePatchYaml,
} from "../../src/plugin/patch.ts";

describe("patch 覆盖文件（C8）", () => {
  it("cordis.patch.yml：插件 id/包名/两个工具名都在，id 唯一", () => {
    const report = assertStaticPatchFiles();
    expect(report.pluginId).toBe(PLUGIN_ID);
    expect(report.pluginPackage).toBe(PLUGIN_PACKAGE);
    expect(report.cordisIds).toEqual([PLUGIN_ID]);
    expect(report.toolNames).toEqual([...TOOL_NAMES]);
    expect(report.legacyDisabled).toBe(LEGACY_IDS.length);
  });

  it("cordis.patch.yml 可解析：insert 行 + mocl config + toolNames 清单", () => {
    const parsed = parsePatchYaml(readFileSync(join(PATCH_DIR, "cordis.patch.yml"), "utf8")) as Array<{
      insert: Array<{ id: string; name: string; config: { configPath: string; toolNames: Record<string, unknown> } }>;
    }>;
    expect(parsed).toHaveLength(1);
    const inserted = parsed[0]?.insert[0];
    expect(inserted?.id).toBe("mocl");
    expect(inserted?.name).toBe("@mocl/dsh-plugin");
    expect(inserted?.config.configPath).toBe("config.default.json");
    expect(Object.keys(inserted?.config.toolNames ?? {})).toEqual(["subagent_agent", "mocl_status"]);
  });

  it("disable-legacy.yml：四个旧 id 全部 disabled: true（R25 冲突规避）", () => {
    const parsed = parsePatchYaml(readFileSync(join(PATCH_DIR, "disable-legacy.yml"), "utf8")) as Array<{
      id: string;
      disabled: boolean;
    }>;
    expect(parsed.map((row) => row.id)).toEqual([...LEGACY_IDS]);
    expect(parsed.every((row) => row.disabled === true)).toBe(true);
  });

  it("patch 目录位于 impl/patch 且只含两份覆盖文件", () => {
    expect(PATCH_DIR).toBe(join(IMPL_ROOT, "patch"));
    const report = assertStaticPatchFiles();
    expect(report.bytes.cordis).toBeGreaterThan(0);
    expect(report.bytes.legacy).toBeGreaterThan(0);
  });

  it("YAML 子集解析器：识别嵌套 map/list 与标量类型", () => {
    const parsed = parsePatchYaml("- insert:\n    - id: x\n      enabled: true\n      depth: 2\n      name: 'pkg'\n");
    expect(parsed).toEqual([{ insert: [{ id: "x", enabled: true, depth: 2, name: "pkg" }] }]);
  });

  it("YAML 子集解析器：tab 缩进/非法结构 → 抛错（不静默解析）", () => {
    expect(() => parsePatchYaml("- id:\tx\n")).toThrow(/tabs/);
    expect(() => parsePatchYaml("a: 1\n  b: 2\n")).toThrow(/indentation/);
    expect(() => parsePatchYaml("- just-a-scalar\n  more: x\n")).toThrow(/indentation/);
  });
});
