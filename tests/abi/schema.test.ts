import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_NAMES, compileSchema, validateCapabilities, validateError, validateEvent, validateRequest, validateSession, schemaPath } from "../../src/abi/index.ts";

function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/${rel}`, import.meta.url), "utf8"));
}

describe("schema 编译与冒烟", () => {
  it("5 个 schema 均可被 AJV 2020-12 编译", () => {
    expect(SCHEMA_NAMES).toHaveLength(5);
    for (const name of SCHEMA_NAMES) {
      expect(typeof compileSchema(name)).toBe("function");
    }
  });

  it("schemaPath 指向 schema/ 下的同步副本", () => {
    expect(schemaPath("session")).toMatch(/\/schema\/session\.json$/);
  });

  it("合法 session fixture 通过", () => {
    const result = validateSession(fixture("valid/session.json"));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("合法 event fixture 通过", () => {
    const result = validateEvent(fixture("valid/event.turn-completed.json"));
    expect(result.ok).toBe(true);
  });

  it("合法 error fixture 通过", () => {
    const result = validateError(fixture("valid/error.rate-limited.json"));
    expect(result.ok).toBe(true);
  });

  it("合法 capabilities fixture 通过", () => {
    const result = validateCapabilities(fixture("valid/capabilities.codex.json"));
    expect(result.ok).toBe(true);
  });

  it("合法 request fixture 通过", () => {
    const result = validateRequest(fixture("valid/request.session-send.json"));
    expect(result.ok).toBe(true);
  });

  it("非法 event（未知 type）被拒绝且给出 issues", () => {
    const result = validateEvent(fixture("invalid/event.unknown-type.json"));
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("非法 session（未知 state）被拒绝", () => {
    const result = validateSession(fixture("invalid/session.bad-state.json"));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === "enum")).toBe(true);
  });

  it("非法 error（缺 userMessage）被拒绝", () => {
    const result = validateError(fixture("invalid/error.missing-user-message.json"));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === "required")).toBe(true);
  });

  it("非法 request（session.send 缺 clientRequestId）被拒绝", () => {
    const result = validateRequest(fixture("invalid/request.send-missing-idempotency.json"));
    expect(result.ok).toBe(false);
  });
});
