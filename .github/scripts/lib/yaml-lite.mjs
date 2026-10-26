/**
 * yaml-lite — 零依赖 YAML 子集解析器（CI / 校验脚本共用）。
 *
 * 为什么不用现成依赖：本仓 devDependencies 中没有 YAML 库，CI 也不允许
 * 为「校验 GitHub 配置」再引入第三方依赖（供应链 + lockfile 漂移）。
 * 因此本文件自实现 MOCL `.github/**` 用到的 YAML 子集：
 *
 *   块映射 / 块序列 / 嵌套节点 / 行内数组 [a, b] / 行内映射 {a: b} /
 *   单双引号标量 / 布尔 true|false / null|~ / 整数与小数 /
 *   块标量 | 与 >（含 - 与 + chomp 指示符）/ 注释 / 文档分隔符 --- 与 ...
 *
 * 不支持（仓库配置中也未使用）：锚点/别名（& *）、标签（!!）、复杂键（? :）、
 * 多文档、YAML 1.1 的 yes/no/on/off 布尔别名。遇到不支持的语法一律抛错，
 * 而不是静默接受——校验器宁可直接失败，也不给出假绿。
 *
 * 用法：
 *   import { parseYaml, YamlLiteError } from "./lib/yaml-lite.mjs";
 *   const data = parseYaml(text, "ci.yml");
 */

export class YamlLiteError extends Error {
  constructor(message, source = "<yaml>", line = null) {
    super(line === null ? `${source}: ${message}` : `${source}:${line}: ${message}`);
    this.name = "YamlLiteError";
    this.source = source;
    this.line = line;
  }
}

/** 去掉行尾注释（尊重单双引号；`#` 前需为行首或空白）。 */
export function stripComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === "'" && ch === "'") {
        if (line[i + 1] === "'") {
          out += line[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      } else if (quote === '"' && ch === '"' && line[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) break;
    out += ch;
  }
  return out.replace(/[ \t]+$/u, "");
}

function indentOf(line) {
  const match = /^[ \t]*/u.exec(line);
  const prefix = match ? match[0] : "";
  return prefix.length;
}

function isBlankOrIgnorable(line) {
  if (/^[ \t]*$/u.test(line)) return true;
  const stripped = stripComment(line).trim();
  return stripped === "" || stripped === "---" || stripped === "...";
}

/** 找「冒号 + 行尾或空白」的位置，跳过引号与行内集合。 */
function findKeyColon(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === "'" && ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else quote = null;
      } else if (quote === '"' && ch === '"' && text[i - 1] !== "\\") {
        quote = null;
      } else if (quote === "'" && text[i - 1] !== "'" && ch === "'") {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

function looksLikeMappingStart(text) {
  if (/^[\[{]/u.test(text)) return false;
  if (/^["']/u.test(text)) {
    // "- 'a: b'" 是标量；"- 'k': v" 是映射。先找闭合引号再看冒号。
    const close = text.indexOf(text[0], 1);
    if (close === -1) return false;
    const after = text.slice(close + 1).trimStart();
    return after.startsWith(":");
  }
  return findKeyColon(text) !== -1;
}

function splitFlowItems(text) {
  const items = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (quote === "'" && ch === "'") {
        if (text[i + 1] === "'") {
          current += text[i + 1];
          i += 1;
        } else quote = null;
      } else if (quote === '"' && ch === '"' && text[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

function unquoteDouble(text, parser, line) {
  try {
    return JSON.parse(text);
  } catch {
    // JSON 不接受的 YAML 双引号转义（如 \x41）——保守处理：仅解常见转义。
    const inner = text.slice(1, -1);
    return inner.replace(/\\(["\\/])/gu, "$1").replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
  }
}

function parseScalar(text, parser, line) {
  const value = text.trim();
  if (value === "") return null;
  if (value.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/u.test(value)) parser.err(`双引号标量未闭合或含非法转义: ${value}`, line);
    return unquoteDouble(value, parser, line);
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) parser.err(`单引号标量未闭合: ${value}`, line);
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) parser.err(`行内数组未闭合: ${value}`, line);
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map((item) => parseScalar(item, parser, line));
  }
  if (value.startsWith("{")) {
    if (!value.endsWith("}")) parser.err(`行内映射未闭合: ${value}`, line);
    const inner = value.slice(1, -1).trim();
    const map = {};
    if (inner === "") return map;
    for (const pair of splitFlowItems(inner)) {
      const colon = findKeyColon(pair);
      if (colon === -1) parser.err(`行内映射缺少冒号: ${pair}`, line);
      const key = parseScalar(pair.slice(0, colon), parser, line);
      map[String(key)] = parseScalar(pair.slice(colon + 1), parser, line);
    }
    return map;
  }
  if (/^(?:true|false)$/iu.test(value)) return value.toLowerCase() === "true";
  if (/^(?:null|~)$/iu.test(value)) return null;
  if (/^[+-]?\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return Number.parseFloat(value);
  return value;
}

class Parser {
  constructor(text, source) {
    this.source = source;
    this.lines = text.split(/\r?\n/u);
    this.i = 0;
  }

  err(message, line = this.i) {
    throw new YamlLiteError(message, this.source, line + 1);
  }

  indentAt(index) {
    return indentOf(this.lines[index]);
  }

  nextSignificant(from) {
    let index = from;
    while (index < this.lines.length && isBlankOrIgnorable(this.lines[index])) index += 1;
    return index < this.lines.length ? index : -1;
  }

  parseDocument() {
    const start = this.nextSignificant(0);
    if (start < 0) return null;
    this.i = start;
    const value = this.parseNode(this.indentAt(start));
    const trailing = this.nextSignificant(this.i);
    if (trailing >= 0) this.err("文档内容结束后仍有无法归属的行（请检查缩进或用 --- 分隔）", trailing);
    return value;
  }

  parseNode(indent) {
    const index = this.nextSignificant(this.i);
    if (index < 0) return null;
    this.i = index;
    const content = stripComment(this.lines[index]).slice(this.indentAt(index));
    if (content === "-" || content.startsWith("- ")) return this.parseSequence(indent);
    return this.parseMapping(indent);
  }

  parseMapping(indent) {
    const map = {};
    for (;;) {
      const index = this.nextSignificant(this.i);
      if (index < 0) break;
      const lineIndent = this.indentAt(index);
      if (lineIndent < indent) break;
      if (lineIndent > indent) this.err("映射缩进不一致", index);
      const raw = stripComment(this.lines[index]).slice(lineIndent);
      if (raw === "-" || raw.startsWith("- ")) this.err("映射位置出现序列项", index);
      const colon = findKeyColon(raw);
      if (colon === -1) this.err(`映射行缺少冒号: ${raw}`, index);
      const key = String(parseScalar(raw.slice(0, colon), this, index));
      if (/\t/u.test(raw.slice(0, colon))) this.err("键中不得含制表符（YAML 禁止 tab 缩进）", index);
      if (Object.prototype.hasOwnProperty.call(map, key)) this.err(`重复键: ${key}`, index);
      const rest = raw.slice(colon + 1).trim();
      this.i = index + 1;
      if (rest === "") {
        const next = this.nextSignificant(this.i);
        if (next >= 0 && this.indentAt(next) > indent) {
          this.i = next;
          map[key] = this.parseNode(this.indentAt(next));
        } else {
          map[key] = null;
        }
      } else if (/^[|>][+-]?\d*$/u.test(rest)) {
        map[key] = this.parseBlockScalar(indent, rest, index);
      } else {
        map[key] = parseScalar(rest, this, index);
      }
    }
    return map;
  }

  parseSequence(indent) {
    const list = [];
    for (;;) {
      const index = this.nextSignificant(this.i);
      if (index < 0) break;
      const lineIndent = this.indentAt(index);
      if (lineIndent < indent) break;
      if (lineIndent > indent) this.err("序列缩进不一致", index);
      const raw = stripComment(this.lines[index]).slice(lineIndent);
      if (!(raw === "-" || raw.startsWith("- "))) break;
      const rest = raw === "-" ? "" : raw.slice(2).trimStart();
      if (rest === "") {
        const next = this.nextSignificant(index + 1);
        if (next >= 0 && this.indentAt(next) > indent) {
          this.i = next;
          list.push(this.parseNode(this.indentAt(next)));
        } else {
          this.i = index + 1;
          list.push(null);
        }
      } else if (/^[|>][+-]?\d*$/u.test(rest)) {
        this.i = index + 1;
        list.push(this.parseBlockScalar(indent, rest, index));
      } else if (looksLikeMappingStart(rest)) {
        // "- key: value" 等价于缩进两格的映射；就地改写成独立行后复用 parseMapping。
        this.lines[index] = " ".repeat(indent + 2) + rest;
        this.i = index;
        list.push(this.parseMapping(indent + 2));
      } else {
        this.i = index + 1;
        list.push(parseScalar(rest, this, index));
      }
    }
    return list;
  }

  parseBlockScalar(parentIndent, header, headerLine) {
    const style = header[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const explicit = /\d/u.test(header) ? Number.parseInt(header.replace(/[^0-9]/gu, ""), 10) : null;
    const collected = [];
    let index = this.i;
    while (index < this.lines.length) {
      const line = this.lines[index];
      if (/^[ \t]*$/u.test(line)) {
        collected.push(line);
        index += 1;
        continue;
      }
      if (this.indentAt(index) <= parentIndent) break;
      collected.push(line);
      index += 1;
    }
    // 尾随空行不属于内容（由 chomp 处理）。
    while (collected.length > 0 && /^[ \t]*$/u.test(collected[collected.length - 1])) collected.pop();
    this.i = index; // index 指向块标量之后的第一行（缩进回退或 EOF）
    if (collected.length === 0) return "";
    const baseIndent = explicit === null
      ? Math.min(...collected.filter((line) => line.trim() !== "").map((line) => indentOf(line)))
      : parentIndent + explicit;
    const cleaned = collected.map((line) => (line.trim() === "" ? "" : line.slice(baseIndent)));
    let text;
    if (style === "|") {
      text = cleaned.join("\n");
    } else {
      const parts = [];
      let previousBlank = false;
      for (const line of cleaned) {
        if (line === "") {
          parts.push("\n");
          previousBlank = true;
          continue;
        }
        if (parts.length > 0 && !previousBlank) parts.push(" ");
        parts.push(line);
        previousBlank = false;
      }
      text = parts.join("");
    }
    if (chomp === "strip") return text.replace(/\n+$/u, "");
    if (chomp === "clip") return text.replace(/\n+$/u, "") + "\n";
    return text + "\n";
  }
}

/**
 * 解析 YAML 文本。
 * @param {string} text
 * @param {string} [source] 文件名（用于错误定位）
 * @returns {unknown}
 */
export function parseYaml(text, source = "<yaml>") {
  if (typeof text !== "string") throw new YamlLiteError("输入必须是字符串", source);
  if (/\t/u.test(text.split(/\r?\n/u).map((line) => /^[ \t]*/u.exec(line)[0]).join(""))) {
    throw new YamlLiteError("缩进中不得含制表符（YAML 禁止 tab 缩进）", source);
  }
  return new Parser(text, source).parseDocument();
}
