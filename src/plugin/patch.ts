/**
 * Patch 覆盖文件的解析与静态断言（C8）。
 *
 * 独立于宿主：既被 `scripts/assert-dsh-tool.mjs` 调用（Node ≥24 原生 TS），
 * 也被 `tests/plugin/patch.test.ts` 直接测试。无外部 YAML 依赖（只覆盖 impl/patch 子集）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMPL_ROOT = resolve(HERE, "../..");
export const PATCH_DIR = join(IMPL_ROOT, "patch");

export const PLUGIN_ID = "mocl";
export const PLUGIN_PACKAGE = "@mocl/dsh-plugin";
export const TOOL_NAMES = ["subagent_agent", "mocl_status"] as const;
export const LEGACY_IDS = [
  "subagent-codex",
  "subagent-claude-code",
  "tool-subagent-codex",
  "tool-subagent-claude-code",
] as const;

/* ------------------------------------------------------------------ */
/* 最小 YAML 子集解析                                                  */
/* ------------------------------------------------------------------ */

interface YamlToken {
  readonly indent: number;
  readonly text: string;
  readonly lineNo: number;
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " ")) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "") return null;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((entry) => parseScalar(entry))
      .filter((entry): entry is YamlValue => entry !== null);
  }
  return text;
}

/** 解析 patch 文件所需的 YAML 子集：嵌套 map、`- key: value` / `- scalar` 列表、引号字符串。 */
export function parsePatchYaml(source: string): YamlValue {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const tokens: YamlToken[] = [];
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const raw = stripComment(lines[lineNo] as string);
    if (raw.trim() === "") continue;
    if (raw.includes("\t")) throw new Error(`YAML line ${lineNo + 1}: tabs are not allowed`);
    const indent = raw.length - raw.trimStart().length;
    tokens.push({ indent, text: raw.trim(), lineNo: lineNo + 1 });
  }
  let cursor = 0;
  const fail = (message: string, token: YamlToken | undefined): never => {
    throw new Error(`YAML parse error${token === undefined ? "" : ` at line ${token.lineNo}`}: ${message}`);
  };
  const parseBlock = (indent: number): YamlValue => {
    if (cursor >= tokens.length) return null;
    const first = tokens[cursor] as YamlToken;
    if (first.indent < indent) return null;
    if (first.indent > indent) fail("unexpected indentation", first);
    return first.text.startsWith("- ") || first.text === "-" ? parseList(indent) : parseMap(indent);
  };
  const parseNested = (parentIndent: number): YamlValue => {
    if (cursor >= tokens.length || (tokens[cursor] as YamlToken).indent <= parentIndent) return null;
    return parseBlock((tokens[cursor] as YamlToken).indent);
  };
  const splitMapEntry = (token: YamlToken): [string, string | null] => {
    const colon = token.text.indexOf(":");
    if (colon <= 0) fail("expected `key: value`", token);
    const key = token.text.slice(0, colon).trim();
    const value = token.text.slice(colon + 1).trim();
    return [key, value === "" ? null : value];
  };
  const parseList = (indent: number): YamlValue[] => {
    const out: YamlValue[] = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor] as YamlToken;
      if (token.indent < indent) break;
      if (token.indent > indent) fail("unexpected indentation in list", token);
      if (!(token.text.startsWith("- ") || token.text === "-")) fail("expected list item", token);
      cursor += 1;
      const rest = token.text === "-" ? "" : token.text.slice(2).trim();
      if (rest === "") {
        out.push(parseNested(indent));
        continue;
      }
      const colon = rest.indexOf(":");
      if (colon === -1) {
        out.push(parseScalar(rest));
        continue;
      }
      const key = rest.slice(0, colon).trim();
      const valueText = rest.slice(colon + 1).trim();
      const item: { [key: string]: YamlValue } = {};
      if (valueText !== "") {
        item[key] = parseScalar(valueText);
      } else {
        const nested = parseNested(indent);
        item[key] = nested === null ? {} : nested;
      }
      while (
        cursor < tokens.length &&
        (tokens[cursor] as YamlToken).indent > indent &&
        !(tokens[cursor] as YamlToken).text.startsWith("- ")
      ) {
        const continuation = parseMap((tokens[cursor] as YamlToken).indent);
        Object.assign(item, continuation);
      }
      out.push(item);
    }
    return out;
  };
  const parseMap = (indent: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = {};
    while (cursor < tokens.length) {
      const token = tokens[cursor] as YamlToken;
      if (token.indent < indent) break;
      if (token.indent > indent) fail("unexpected indentation in map", token);
      if (token.text.startsWith("- ")) fail("unexpected list item in map", token);
      const [key, valueText] = splitMapEntry(token);
      cursor += 1;
      if (valueText === null) {
        const nested = parseNested(indent);
        out[key] = nested === null ? {} : nested;
      } else {
        out[key] = parseScalar(valueText);
      }
    }
    return out;
  };
  const value = parseBlock(0);
  if (cursor !== tokens.length) fail("trailing tokens", tokens[cursor] as YamlToken);
  return value;
}

/* ------------------------------------------------------------------ */
/* 静态断言                                                            */
/* ------------------------------------------------------------------ */

export interface PatchReport {
  readonly cordisIds: readonly string[];
  readonly legacyIds: readonly string[];
  readonly toolNames: readonly string[];
  readonly pluginId: string;
  readonly pluginPackage: string;
  readonly legacyDisabled: number;
  readonly bytes: { readonly cordis: number; readonly legacy: number };
}

function collectIds(rows: YamlValue): string[] {
  const ids: string[] = [];
  if (!Array.isArray(rows)) return ids;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row["id"] === "string") ids.push(row["id"]);
    const insert = row["insert"];
    if (Array.isArray(insert)) {
      for (const inserted of insert) {
        if (
          inserted !== null &&
          typeof inserted === "object" &&
          !Array.isArray(inserted) &&
          typeof inserted["id"] === "string"
        ) {
          ids.push(inserted["id"]);
        }
      }
    }
  }
  return ids;
}

/** 静态断言入口（脚本与 vitest 复用）；失败抛错，成功返回报告。 */
export function assertStaticPatchFiles(): PatchReport {
  const cordisPath = join(PATCH_DIR, "cordis.patch.yml");
  const legacyPath = join(PATCH_DIR, "disable-legacy.yml");
  for (const path of [cordisPath, legacyPath]) {
    if (!existsSync(path)) throw new Error(`missing patch file: ${path}`);
  }
  const cordisText = readFileSync(cordisPath, "utf8");
  const legacyText = readFileSync(legacyPath, "utf8");
  const cordis = parsePatchYaml(cordisText);
  const legacy = parsePatchYaml(legacyText);
  if (!Array.isArray(cordis)) throw new Error("cordis.patch.yml root must be a list");
  if (!Array.isArray(legacy)) throw new Error("disable-legacy.yml root must be a list");

  const cordisIds = collectIds(cordis);
  const legacyIds = collectIds(legacy);
  const allIds = [...cordisIds, ...legacyIds];
  const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate patch ids: ${[...new Set(duplicates)].join(", ")}`);
  if (!cordisIds.includes(PLUGIN_ID)) throw new Error(`cordis.patch.yml missing plugin id "${PLUGIN_ID}"`);
  if (!cordisText.includes(PLUGIN_PACKAGE)) throw new Error(`cordis.patch.yml missing plugin package "${PLUGIN_PACKAGE}"`);
  for (const tool of TOOL_NAMES) {
    if (!cordisText.includes(tool)) throw new Error(`cordis.patch.yml missing tool name "${tool}"`);
  }
  for (const legacyId of LEGACY_IDS) {
    if (!legacyIds.includes(legacyId)) throw new Error(`disable-legacy.yml missing legacy id "${legacyId}"`);
  }
  for (const row of legacy) {
    if (
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      typeof row["id"] === "string" &&
      row["disabled"] !== true
    ) {
      throw new Error(`disable-legacy.yml row "${row["id"]}" must set disabled: true`);
    }
  }
  return {
    cordisIds,
    legacyIds,
    toolNames: [...TOOL_NAMES],
    pluginId: PLUGIN_ID,
    pluginPackage: PLUGIN_PACKAGE,
    legacyDisabled: legacy.length,
    bytes: { cordis: cordisText.length, legacy: legacyText.length },
  };
}
