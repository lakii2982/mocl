/**
 * ABI v0 方法清单（真源：docs/abi/abi-v0.md §6.1 总表，18 个方法）。
 *
 * 本文件是施工期的方法注册表：`validate-abi.mjs` 断言 18、请求类型按 `AbiMethod` 收敛、
 * 测试断言与 `schema/request.json` 的 9 个已冻结变体一致（M10–M18 属 §13.1 加法扩展，
 * 请求体在 C2+ 按同一信封补齐；ABI 真源未变）。
 */
export type MethodKind = "read" | "write" | "stream";

export interface MethodMetaShape {
  readonly name: string;
  readonly num: number;
  readonly kind: MethodKind;
  readonly requiresClientRequestId: boolean;
  readonly requiresSessionId: boolean;
  readonly summary: string;
}

export const ABI_METHODS = [
  {
    name: "abi.negotiate",
    num: 1,
    kind: "read",
    requiresClientRequestId: false,
    requiresSessionId: false,
    summary: "取 ABI 版本与后端能力摘要",
  },
  {
    name: "session.create",
    num: 2,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: false,
    summary: "建会话（可选首轮）",
  },
  {
    name: "session.send",
    num: 3,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "发一轮输入",
  },
  {
    name: "session.resume",
    num: 4,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "续接既有后端会话并可选发一轮",
  },
  {
    name: "session.interrupt",
    num: 5,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "中断进行中一轮",
  },
  {
    name: "session.query",
    num: 6,
    kind: "read",
    requiresClientRequestId: false,
    requiresSessionId: true,
    summary: "查单会话状态/最后 seq/结果",
  },
  {
    name: "session.list",
    num: 7,
    kind: "read",
    requiresClientRequestId: false,
    requiresSessionId: false,
    summary: "列举会话（状态/backend/父会话过滤）",
  },
  {
    name: "session.recover",
    num: 8,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "冷恢复（探测 + 重连 + 重放）",
  },
  {
    name: "session.close",
    num: 9,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "关闭/释放资源（幂等）",
  },
  {
    name: "session.fork",
    num: 10,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "从既有会话分叉",
  },
  {
    name: "session.archive",
    num: 11,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "归档（后端可选，能力位 sessionArchive）",
  },
  {
    name: "session.respond",
    num: 12,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "应答权限/输入请求",
  },
  {
    name: "session.steer",
    num: 13,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "运行中转向/追加",
  },
  {
    name: "session.setMode",
    num: 14,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "切权限/计划模式",
  },
  {
    name: "session.setModel",
    num: 15,
    kind: "write",
    requiresClientRequestId: true,
    requiresSessionId: true,
    summary: "切模型/推理档",
  },
  {
    name: "session.subscribe",
    num: 16,
    kind: "stream",
    requiresClientRequestId: false,
    requiresSessionId: true,
    summary: "订阅事件（从 seq 起）",
  },
  {
    name: "session.replay",
    num: 17,
    kind: "read",
    requiresClientRequestId: false,
    requiresSessionId: true,
    summary: "按 seq 区间重放事件（冷恢复/断线补偿）",
  },
  {
    name: "sys.ping",
    num: 18,
    kind: "read",
    requiresClientRequestId: false,
    requiresSessionId: false,
    summary: "心跳/活性探针",
  },
] as const satisfies readonly MethodMetaShape[];

export type AbiMethodMeta = (typeof ABI_METHODS)[number];
export type AbiMethod = AbiMethodMeta["name"];

/** 与 schema/request.json 的 `method` 枚举一一对应的 9 个核心方法（M1–M9）。 */
export const SCHEMA_BACKED_METHODS = [
  "abi.negotiate",
  "session.create",
  "session.send",
  "session.resume",
  "session.interrupt",
  "session.query",
  "session.list",
  "session.recover",
  "session.close",
] as const satisfies readonly AbiMethod[];

export type SchemaBackedMethod = (typeof SCHEMA_BACKED_METHODS)[number];

/** M10–M18：ABI §13.1 加法扩展方法（schema 尚未冻结请求体）。 */
export const EXTENSION_METHODS = [
  "session.fork",
  "session.archive",
  "session.respond",
  "session.steer",
  "session.setMode",
  "session.setModel",
  "session.subscribe",
  "session.replay",
  "sys.ping",
] as const satisfies readonly AbiMethod[];

export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];

export const METHOD_NAMES: readonly AbiMethod[] = ABI_METHODS.map((m) => m.name);

export function isAbiMethod(value: string): value is AbiMethod {
  return (METHOD_NAMES as readonly string[]).includes(value);
}

export function isSchemaBackedMethod(value: string): value is SchemaBackedMethod {
  return (SCHEMA_BACKED_METHODS as readonly string[]).includes(value);
}

export function getMethodMeta(name: AbiMethod): AbiMethodMeta {
  const found = ABI_METHODS.find((m) => m.name === name);
  if (found === undefined) throw new Error(`unknown ABI method: ${name}`);
  return found;
}
