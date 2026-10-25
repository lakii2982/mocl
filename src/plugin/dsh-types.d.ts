/**
 * DSH 宿主 API 最小类型声明（基线：DSH **0.2.1-rc.3**）。
 *
 * 来源（实测抽取，非文档猜测）：
 * - `@deepseek-ai/dsh-tools@0.2.1-rc.3`：`ctx.tools.register(definition)`（见 lib/index.js
 *   `register(definition)`，要求 `output.{schema,render}`；参数为 JSON Schema）；
 * - `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.3`：插件模块形状 `export { name, inject, apply }`，
 *   `inject = ["tools", …]`，`apply(ctx, config, session)`；`ctx.logger.warn/…`、`ctx.on(event, cb)`。
 *
 * **升级宿主需复核本文件**（字段名/注册签名/工具 schema 子集都可能变）；本文件只声明用到的面。
 */

export type DshJsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** `dsh-tools` 支持的 JSON Schema 子集（只声明我们用到的关键字）。 */
export interface DshJsonSchema {
  readonly type?: DshJsonSchemaType;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly properties?: Readonly<Record<string, DshJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: DshJsonSchema;
  readonly oneOf?: readonly DshJsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
}

/** 工具执行上下文（`defineTool` 的 `execute(args, exec)` 第二个参数）。 */
export interface DshToolExec {
  readonly signal?: AbortSignal;
  readonly agent?: unknown;
}

/** 工具结果内容块。 */
export interface DshContentBlock {
  readonly type: "text";
  readonly text: string;
}

/** 注册到 `ctx.tools.register()` 的定义（与 `defineTool` 产物同形）。 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: DshJsonSchema;
  readonly output: {
    readonly schema: DshJsonSchema;
    readonly render: (args: UnknownArgs, value: unknown) => readonly DshContentBlock[];
  };
  readonly timeoutMs?: number;
  execute(args: UnknownArgs, exec: DshToolExec): Promise<unknown>;
}

export type UnknownArgs = Readonly<Record<string, unknown>>;

export interface DshLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 宿主 Context 的最小子集（只声明用到的服务/事件）。 */
export interface DshHostContext {
  readonly tools: {
    register(definition: DshToolDefinition): () => void;
  };
  readonly logger?: DshLogger;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  /** Host 设置读取（用于 D-016 的 `subagent.maxActiveSubagents` 运行时值）。 */
  readonly settings?: {
    get(key: string): unknown;
  };
  get?(service: string): unknown;
}

/** 插件配置（patch 行 `config:` 传入；全部可选，默认最小权限）。 */
export interface DshPluginConfig {
  readonly configPath?: string;
  readonly configOverrides?: unknown;
  readonly toolNamePrefix?: string;
}

/** `@deepseek-ai/dsh-tools` 的模块声明（运行期由宿主提供，施工仓不安装该依赖）。 */
declare module "@deepseek-ai/dsh-tools" {
  export function defineTool(options: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly output: {
      readonly schema: unknown;
      readonly render: (args: UnknownArgs, value: unknown) => readonly DshContentBlock[];
    };
    execute(args: UnknownArgs, exec: DshToolExec): Promise<unknown>;
  }): DshToolDefinition;
}
