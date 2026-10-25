/**
 * ABI v0 运行时校验（AJV 2020-12 编译 5 个 schema，编译结果按 schema 缓存）。
 *
 * schema 来源：`schema/*.json`（由 `tools/sync-schema.mjs` 从设计包 `docs/abi/schema/*.json`
 * 同步；设计包是唯一真源）。校验失败返回结构化 issues，不抛异常（调用方决定 fail-open/closed）。
 *
 * 说明：设计包的 schema 使用 JSON Schema 2020-12；AJV 的 strict 模式会拒绝「oneOf 分支只写
 * required 不写 type」这种合法但宽松的写法，因此这里 `strict: false`（schema 是外部真源，
 * 校验器适配它，而不是反过来改 schema）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  CapabilityDeclaration,
  ErrorRef,
  MoclEvent,
  MoclRequest,
  Session,
} from "./types.ts";

export const SCHEMA_NAMES = ["session", "event", "error", "capabilities", "request"] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

const SCHEMA_FILES: Readonly<Record<SchemaName, string>> = {
  session: "session.json",
  event: "event.json",
  error: "error.json",
  capabilities: "capabilities.json",
  request: "request.json",
};

export interface ValidationIssue {
  /** JSON Pointer（空串表示根）。 */
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly issues: readonly ValidationIssue[];
}

export function schemaPath(name: SchemaName): string {
  return fileURLToPath(new URL(`../../schema/${SCHEMA_FILES[name]}`, import.meta.url));
}

/**
 * ajv v8 是 CJS 包，其 .d.ts 与 NodeNext 的 ESM 视角不兼容（类型层会把它当命名空间），
 * 但运行时 `require()` 返回的就是 Ajv2020 类本身。这里用 createRequire 取运行时值，
 * 并用本文件的局部结构类型约束最小接口（只用到 compile/errors）。
 */
interface AjvErrorObjectLike {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
  readonly params?: unknown;
}

export interface AjvValidatorLike {
  (data: unknown): boolean;
  errors?: readonly AjvErrorObjectLike[] | null;
}

interface AjvLike {
  compile(schema: object): AjvValidatorLike;
  addFormat(name: string, format: unknown): AjvLike;
}

type Ajv2020Ctor = new (opts?: Record<string, unknown>) => AjvLike;
type AddFormats = (ajv: AjvLike, opts?: unknown) => AjvLike;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as Ajv2020Ctor;
const addFormats = require("ajv-formats") as AddFormats;

let ajvInstance: AjvLike | undefined;
const compiledValidators = new Map<SchemaName, AjvValidatorLike>();

function getAjv(): AjvLike {
  if (ajvInstance === undefined) {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    ajvInstance = ajv;
  }
  return ajvInstance;
}

/** 编译并缓存一个 schema 的校验函数（同一 schema 只编译一次）。 */
export function compileSchema(name: SchemaName): AjvValidatorLike {
  const cached = compiledValidators.get(name);
  if (cached !== undefined) return cached;

  const file = schemaPath(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`failed to load ABI schema ${name} from ${file}; run \`pnpm -s sync:schema\` first`, {
      cause,
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`ABI schema ${name} is not a JSON object: ${file}`);
  }
  const validator = getAjv().compile(parsed);
  compiledValidators.set(name, validator);
  return validator;
}

function toIssues(errors: readonly AjvErrorObjectLike[] | null | undefined): ValidationIssue[] {
  if (errors === null || errors === undefined) return [];
  return errors.map((err) => ({
    path: err.instancePath === undefined || err.instancePath === "" ? "/" : err.instancePath,
    keyword: err.keyword ?? "unknown",
    message: `${err.message ?? "invalid"}${err.params === undefined ? "" : ` ${JSON.stringify(err.params)}`}`,
  }));
}

function validateWith<T>(name: SchemaName, input: unknown): ValidationResult<T> {
  const validator = compileSchema(name);
  const ok = validator(input) as boolean;
  if (ok) return { ok: true, value: input as T, issues: [] };
  return { ok: false, issues: toIssues(validator.errors) };
}

export function validateSession(input: unknown): ValidationResult<Session> {
  return validateWith<Session>("session", input);
}

export function validateEvent(input: unknown): ValidationResult<MoclEvent> {
  return validateWith<MoclEvent>("event", input);
}

export function validateError(input: unknown): ValidationResult<ErrorRef> {
  return validateWith<ErrorRef>("error", input);
}

export function validateCapabilities(input: unknown): ValidationResult<CapabilityDeclaration> {
  return validateWith<CapabilityDeclaration>("capabilities", input);
}

export function validateRequest(input: unknown): ValidationResult<MoclRequest> {
  return validateWith<MoclRequest>("request", input);
}
