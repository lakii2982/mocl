import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABI_METHODS,
  EXTENSION_METHODS,
  METHOD_NAMES,
  SCHEMA_BACKED_METHODS,
  getMethodMeta,
  isAbiMethod,
  isSchemaBackedMethod,
  validateRequest,
} from "../../src/abi/index.ts";
import type { MoclRequest } from "../../src/abi/index.ts";

function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/${rel}`, import.meta.url), "utf8"));
}

describe("方法目录（ABI §6，18 方法）", () => {
  it("恰好 18 个方法、编号连续、无重复", () => {
    expect(ABI_METHODS).toHaveLength(18);
    expect(new Set(METHOD_NAMES).size).toBe(18);
    expect(ABI_METHODS.map((m) => m.num)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("核心 9 方法（schema 已冻结）+ 扩展 9 方法 = 18，无交集", () => {
    expect(SCHEMA_BACKED_METHODS).toHaveLength(9);
    expect(EXTENSION_METHODS).toHaveLength(9);
    const intersection = SCHEMA_BACKED_METHODS.filter((m) =>
      (EXTENSION_METHODS as readonly string[]).includes(m),
    );
    expect(intersection).toEqual([]);
    expect([...SCHEMA_BACKED_METHODS, ...EXTENSION_METHODS].sort()).toEqual([...METHOD_NAMES].sort());
  });

  it("写方法必须要求幂等键，读/流方法不得要求", () => {
    for (const meta of ABI_METHODS) {
      if (meta.kind === "write") expect(meta.requiresClientRequestId, meta.name).toBe(true);
      else expect(meta.requiresClientRequestId, meta.name).toBe(false);
    }
  });

  it("方法名符合 ABI 命名规范且可被 isAbiMethod 识别", () => {
    for (const name of METHOD_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/);
      expect(isAbiMethod(name)).toBe(true);
    }
    expect(isAbiMethod("session.explode")).toBe(false);
    expect(isSchemaBackedMethod("session.send")).toBe(true);
    expect(isSchemaBackedMethod("session.steer")).toBe(false);
    expect(getMethodMeta("session.steer").kind).toBe("write");
  });

  it("合法 session.send 请求 fixture 通过 schema", () => {
    const result = validateRequest(fixture("valid/request.session-send.json"));
    expect(result.ok).toBe(true);
  });

  it("session.send 缺 clientRequestId 被拒绝（ABI §9.1 幂等键必填）", () => {
    const result = validateRequest(fixture("invalid/request.send-missing-idempotency.json"));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes("session.send") || issue.keyword === "required")).toBe(true);
  });

  it("请求类型 union 覆盖 M1–M18（编译期 + 运行时方法名核对）", () => {
    const sample: MoclRequest = {
      abiVersion: "0.1",
      requestId: "req_1",
      method: "session.steer",
      sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
      clientRequestId: "01J9ZR4D5E6F7G8H9J0K1M2N3P",
      params: { input: [{ type: "text", text: "转向" }] },
    };
    expect(sample.method).toBe("session.steer");
    expect(METHOD_NAMES).toContain(sample.method);
  });
});
