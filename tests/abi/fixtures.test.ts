import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileSchema } from "../../src/abi/index.ts";
import type { SchemaName } from "../../src/abi/index.ts";

interface FixtureEntry {
  readonly file: string;
  readonly schema: SchemaName;
  readonly expect: "valid" | "invalid";
}

const manifest = JSON.parse(
  readFileSync(new URL("../../fixtures/manifest.json", import.meta.url), "utf8"),
) as FixtureEntry[];

function load(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/${rel}`, import.meta.url), "utf8"));
}

describe("fixtures 契约样例", () => {
  it("manifest 至少 5 条且覆盖合法与非法", () => {
    expect(manifest.length).toBeGreaterThanOrEqual(5);
    expect(manifest.some((entry) => entry.expect === "valid")).toBe(true);
    expect(manifest.some((entry) => entry.expect === "invalid")).toBe(true);
  });

  for (const entry of manifest) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const validator = compileSchema(entry.schema);
      const ok = validator(load(entry.file));
      expect(ok).toBe(entry.expect === "valid");
    });
  }
});
