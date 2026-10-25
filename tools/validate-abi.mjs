#!/usr/bin/env node
/**
 * validate-abi.mjs — 施工 C1 的 ABI 契约门禁（可独立运行，无需编译）。
 *
 * 检查项（任一失败 → 非零退出）：
 *   1. AJV 编译 5 个 schema（schema/，由 sync-schema 从设计包同步）。
 *   2. 计数与集合一致性：错误码 46 / 能力位 34 / 事件 35 / 方法 18。
 *   3. 实现常量 ↔ schema 枚举逐字一致（防止实现悄悄漂移）。
 *   4. fixtures 合法/非法样例按期望通过/拒绝。
 *   5. 方法元数据自洽（编号 1..18、写操作必须带幂等键、schema 冻结的 9 方法 ⊆ 18 方法）。
 *
 * 用法：node tools/validate-abi.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ABI_METHODS,
  EXTENSION_METHODS,
  SCHEMA_BACKED_METHODS,
  METHOD_NAMES,
  isAbiMethod,
} from "../src/abi/methods.ts";
import {
  ERROR_CODES,
  ERROR_CATEGORIES,
  RETRYABILITIES,
  ERROR_CATEGORY,
  RETRYABLE,
  isRetryable,
} from "../src/abi/errors.ts";
import {
  CAPABILITY_BITS,
  CAPABILITY_GROUP_A,
  CAPABILITY_GROUP_B,
  CAPABILITY_STATES,
} from "../src/abi/capabilities.ts";
import { EVENT_TYPES, EVENT_TYPE_SET } from "../src/abi/events.ts";
import { compileSchema, SCHEMA_NAMES } from "../src/abi/validate.ts";

const failures = [];
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertSameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert(
    a.length === e.length && a.every((v, i) => v === e[i]),
    `${label} 集合不一致（actual=${a.length}, expected=${e.length}；` +
      `仅实现有=[${a.filter((v) => !e.includes(v))}]，仅 schema 有=[${e.filter((v) => !a.includes(v))}]）`,
  );
}

function readJson(relPath) {
  const path = fileURLToPath(new URL(`../${relPath}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ---------------- 1) 编译 5 个 schema ---------------- */
const validators = {};
check("AJV 编译 5 个 schema", () => {
  assert(SCHEMA_NAMES.length === 5, `SCHEMA_NAMES 应为 5，实际 ${SCHEMA_NAMES.length}`);
  for (const name of SCHEMA_NAMES) {
    const validator = compileSchema(name);
    assert(typeof validator === "function", `${name} 校验器不可调用`);
    validators[name] = validator;
  }
});

/* ---------------- 2) 错误码 46 ---------------- */
const errorSchema = readJson("schema/error.json");
check("错误码 = 46", () => {
  assert(ERROR_CODES.length === 46, `实现 ERROR_CODES 应为 46，实际 ${ERROR_CODES.length}`);
  assert(new Set(ERROR_CODES).size === 46, "ERROR_CODES 存在重复");
  const schemaCodes = errorSchema.properties.code.enum;
  assert(Array.isArray(schemaCodes) && schemaCodes.length === 46, "schema error.json 错误码应为 46");
  assertSameSet(ERROR_CODES, schemaCodes, "ERROR_CODES ↔ schema/error.json");
});

check("错误分类 = 12 且逐码可归类", () => {
  const schemaCategories = errorSchema.properties.category.enum;
  assert(ERROR_CATEGORIES.length === 12, `ERROR_CATEGORIES 应为 12，实际 ${ERROR_CATEGORIES.length}`);
  assertSameSet(ERROR_CATEGORIES, schemaCategories, "ERROR_CATEGORIES ↔ schema/error.json");
  const mappingKeys = Object.keys(ERROR_CATEGORY).sort();
  assertSameSet(mappingKeys, ERROR_CODES, "ERROR_CATEGORY 键集合");
  for (const code of ERROR_CODES) {
    assert(ERROR_CATEGORIES.includes(ERROR_CATEGORY[code]), `${code} 的 category 非法`);
  }
});

check("retryable 映射覆盖全部 46 码且取值合法", () => {
  const schemaRetryables = errorSchema.properties.retryable.enum;
  assertSameSet(RETRYABILITIES, schemaRetryables, "RETRYABILITIES ↔ schema/error.json");
  const retryKeys = Object.keys(RETRYABLE).sort();
  assertSameSet(retryKeys, ERROR_CODES, "RETRYABLE 键集合");
  for (const code of ERROR_CODES) {
    assert(RETRYABILITIES.includes(RETRYABLE[code]), `${code} 的 retryable 非法: ${RETRYABLE[code]}`);
    assert(isRetryable(code) === (RETRYABLE[code] !== "no"), `${code} isRetryable 实现不一致`);
  }
});

/* ---------------- 3) 能力位 34 ---------------- */
const capabilitiesSchema = readJson("schema/capabilities.json");
const sessionSchema = readJson("schema/session.json");
check("能力位 = 34（A15 + B19）且与 schema 一致", () => {
  assert(CAPABILITY_BITS.length === 34, `CAPABILITY_BITS 应为 34，实际 ${CAPABILITY_BITS.length}`);
  assert(new Set(CAPABILITY_BITS).size === 34, "CAPABILITY_BITS 存在重复");
  assert(CAPABILITY_GROUP_A.length === 15, `A 组应为 15，实际 ${CAPABILITY_GROUP_A.length}`);
  assert(CAPABILITY_GROUP_B.length === 19, `B 组应为 19，实际 ${CAPABILITY_GROUP_B.length}`);
  const schemaBits = capabilitiesSchema.properties.bits.items.properties.bit.enum;
  assertSameSet(CAPABILITY_BITS, schemaBits, "CAPABILITY_BITS ↔ schema/capabilities.json");
  const sessionBits = sessionSchema.$defs.bitName.enum;
  assertSameSet(CAPABILITY_BITS, sessionBits, "CAPABILITY_BITS ↔ schema/session.json#/$defs/bitName");
  const schemaStates = capabilitiesSchema.properties.bits.items.properties.state.enum;
  assertSameSet(CAPABILITY_STATES, schemaStates, "CAPABILITY_STATES ↔ schema");
});

/* ---------------- 4) 事件 35 ---------------- */
const eventSchema = readJson("schema/event.json");
check("事件 = 35 且 oneOf 与 type 枚举一致", () => {
  assert(EVENT_TYPES.length === 35, `EVENT_TYPES 应为 35，实际 ${EVENT_TYPES.length}`);
  assert(EVENT_TYPE_SET.size === 35, "EVENT_TYPES 存在重复");
  const typeEnum = eventSchema.properties.type.enum;
  assert(Array.isArray(typeEnum) && typeEnum.length === 35, "schema event.json type 枚举应为 35");
  assertSameSet(EVENT_TYPES, typeEnum, "EVENT_TYPES ↔ schema/event.json#/properties/type");

  const defs = eventSchema.$defs;
  const consts = eventSchema.oneOf.map((branch) => {
    const resolved = "$ref" in branch ? defs[branch.$ref.split("/").at(-1)] : branch;
    return resolved.properties.type.const;
  });
  assert(consts.length === 35, `event.json oneOf 变体应为 35，实际 ${consts.length}`);
  assert(new Set(consts).size === 35, "event.json oneOf 存在重复 type");
  assertSameSet(consts, typeEnum, "event.json oneOf const ↔ type 枚举");
});

/* ---------------- 5) 方法 18 ---------------- */
const requestSchema = readJson("schema/request.json");
check("方法 = 18 且元数据自洽", () => {
  assert(ABI_METHODS.length === 18, `ABI_METHODS 应为 18，实际 ${ABI_METHODS.length}`);
  assert(METHOD_NAMES.length === 18, `METHOD_NAMES 应为 18，实际 ${METHOD_NAMES.length}`);
  assert(new Set(METHOD_NAMES).size === 18, "方法名存在重复");
  const nums = ABI_METHODS.map((m) => m.num).sort((a, b) => a - b);
  assert(
    nums.every((n, i) => n === i + 1),
    `方法编号必须为 1..18，实际 ${JSON.stringify(nums)}`,
  );
  for (const meta of ABI_METHODS) {
    assert(isAbiMethod(meta.name), `方法名不合法: ${meta.name}`);
    assert(/^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(meta.name), `方法名不符合 ABI 命名: ${meta.name}`);
    assert(["read", "write", "stream"].includes(meta.kind), `${meta.name} kind 非法`);
    if (meta.kind === "write") {
      assert(meta.requiresClientRequestId, `写方法 ${meta.name} 必须要求幂等键（ABI §9.1）`);
    } else {
      assert(!meta.requiresClientRequestId, `非写方法 ${meta.name} 不应要求幂等键`);
    }
  }
  assert(SCHEMA_BACKED_METHODS.length === 9, `schema 冻结方法应为 9，实际 ${SCHEMA_BACKED_METHODS.length}`);
  assert(EXTENSION_METHODS.length === 9, `扩展方法应为 9，实际 ${EXTENSION_METHODS.length}`);
  const schemaMethods = requestSchema.properties.method.enum;
  assertSameSet(SCHEMA_BACKED_METHODS, schemaMethods, "SCHEMA_BACKED_METHODS ↔ schema/request.json");
  assertSameSet([...SCHEMA_BACKED_METHODS, ...EXTENSION_METHODS], METHOD_NAMES, "M1–M18 覆盖");
});

/* ---------------- 6) 会话状态与 schema 一致 ---------------- */
check("会话状态/激活态/终止原因枚举一致", () => {
  assertSameSet(
    sessionSchema.properties.state.enum,
    ["created", "running", "awaiting-input", "blocked", "completed", "aborted", "lost", "recovering", "archived"],
    "session.state",
  );
  assertSameSet(sessionSchema.properties.activation.enum, ["inactive", "queued", "active", "draining"], "session.activation");
});

/* ---------------- 7) fixtures ---------------- */
check("fixtures 合法/非法样例符合期望", () => {
  const manifest = readJson("fixtures/manifest.json");
  assert(Array.isArray(manifest) && manifest.length >= 5, "fixtures manifest 至少 5 条");
  for (const entry of manifest) {
    const payload = readJson(`fixtures/${entry.file}`);
    const validator = validators[entry.schema];
    assert(typeof validator === "function", `未知 schema: ${entry.schema}`);
    const ok = validator(payload);
    if (entry.expect === "valid") {
      assert(ok === true, `${entry.file} 期望合法但被拒绝: ${JSON.stringify(validator.errors)}`);
    } else {
      assert(ok === false, `${entry.file} 期望非法但被接受`);
    }
  }
  console.log(`     fixtures: ${manifest.length} 条（合法/非法）全部符合期望`);
});

/* ---------------- 汇总 ---------------- */
console.log("");
console.log(`[validate-abi] checks=${checks} failures=${failures.length}`);
console.log(
  `[validate-abi] errors=${ERROR_CODES.length}, capabilities=${CAPABILITY_BITS.length}, ` +
    `events=${EVENT_TYPES.length}, methods=${ABI_METHODS.length}`,
);
if (failures.length > 0) {
  console.error("");
  for (const { name, error } of failures) {
    console.error(`[validate-abi] FAILED ${name}`);
    if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
  }
  process.exit(1);
}
console.log("[validate-abi] ALL CHECKS PASSED (46/34/35/18)");
