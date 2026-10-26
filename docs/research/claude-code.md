# claude-code 后端调研（D1 / 本机实测）

> 结论标记：`[实测]` = 本机跑出的可复跑证据；`[文档]` = 官方 `--help` / typings 文本；`[推断]` = 由前两者推导、未直接执行验证。
> 证据统一由 `bash repro/probe-claude.sh` 复跑（只读、**零额度**：不发起任何 LLM 请求、不写 `~/.claude`）。
> 安全：只读 typings / `--help` / 二进制字符串 / 会话元数据；未读取 `auth` 内容，未打印任何凭据。

## 1. 版本与安装路径

| 角色 | 路径 | 版本 | 证据 |
|---|---|---|---|
| Claude Code CLI（**宿主线**，适配器默认不用） | `/Users/lakii2982/.nvm/versions/node/v24.18.1/bin/claude` → `.../@anthropic-ai/claude-code/bin/claude.exe`（Mach-O arm64，274 MB bun 单文件） | **2.1.310** | `claude --version` → `2.1.310 (Claude Code)` `[实测]` |
| **SDK 内置 CLI（适配器基线）** | Agent SDK 平台包 `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263` 内的 `claude`（bun 单文件，~199 MB） | **2.1.263** | 平台包 `manifest.json.version` `[实测]`；C5 `init.claude_code_version=2.1.263` `[实测]` |
| Agent SDK（DSH bundle 内） | `~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/` | **0.3.263** | 该包 `package.json` `[实测]` |
| SDK typings | 同目录 `sdk.d.ts` **8804 行** / `sdk-tools.d.ts` **4134 行** | — | `wc -l` `[实测] §10-[1]` |
| DSH 插件 | `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-claude-code/` | `0.2.1-rc.3` | 插件 `package.json` `[实测]` |
| 本机会话存储 | `~/.claude/projects/<slug>/<sessionId>.jsonl`（5 个 jsonl、3 个项目目录） | — | `find \| wc -l` `[实测] §10-[6]` |

关键结构性事实：**存在三条身份、两条升级线**——SDK `0.3.263`（线 A）、它内置的 CLI `2.1.263`（线 A，适配器基线）、宿主 nvm 全局 CLI `2.1.310`（线 B，默认不用）。SDK 通过平台包/`pathToClaudeCodeExecutable` 启动 CLI（`sdk.d.ts:1824`），**SDK 与内置 CLI 之间没有显式握手校验**；宿主 CLI 属独立安装、独立升级。版本错配行为未定义 → 见 §6 风险 1。

## 2. 证据：CLI 面真实帮助文本（带行号，`claude --help` 输出存档 309 行）

`[实测] §10-[2]`（行号 = `claude --help` 输出行号）

| Flag | 帮助原文（摘要） | 行 |
|---|---|---|
| `--agents <json-or-file>` | *"JSON object defining custom agents, or with --print the path to a file that holds one (e.g. '{"reviewer": {"description": "...", "prompt": "..."}}')"* | 14 |
| `-r, --resume [value]` | *"Resume a conversation by session ID or name, or open interactive picker with optional search term"* | 210 |
| `-c, --continue` | *"Continue the most recent conversation in the current directory"* | 67 |
| `--fork-session` | *"When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)"* | 104 |
| `--include-partial-messages` | *"Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)"* | 120-122 |
| `--forward-subagent-text` | *"Forward subagent text and thinking blocks as assistant/user messages with parent_tool_use_id set (only works with --print and --output-format=stream-json)"* | 107-110 |
| `--from-pr [value]` | *"Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term"* | 111 |
| `--permission-mode <mode>` | choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` | 151-154 |
| `--permission-prompts <target>` | *"Who answers permission prompts with --print: host (the SDK host or --permission-prompt-tool) or none (nobody: anything that would prompt is denied automatically ...) (choices: host, none, default: host)"* | 155-161 |
| `--output-format <format>` | choices: `text, json, stream-json`（仅 `--print`） | 146-150 |
| `--input-format <format>` | choices: `text, stream-json`（`stream-json` = realtime streaming input） | 123-127 |
| `--session-id <uuid>` | *"Use a specific session ID for the conversation (must be a valid UUID)"* | 224 |
| `--no-session-persistence` | *"sessions will not be saved to disk and cannot be resumed (only works with --print)"* | 143 |
| `--restricted` | *"removes the built-in tools that run commands or code (Bash, PowerShell and the other code-running tools) and WebFetch unless --tools names them ..."* | 195-199 |
| `--tools <tools...>` | *"Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use the default set, or specify tool names"* | 255 |

补充（同一次 `claude --help` 取证，`[实测]`）：`--mcp-config <configs...>`(133)、`--strict-mcp-config`(230)、`--fallback-model <model>`(94)、`-w, --worktree [name]`(263)、`--tmux`(251，需 `--worktree`)、`--bg, --background`(33)、`--teleport [session]`(249)、`--plugin-dir`(163)、`--add-dir`(10)。

子命令（`claude --help` 的 `Commands:`）：`agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, purge, respawn, rm, setup-token, stop|kill, ultrareview, update` `[实测]`

`claude agents --help` 的脚本化接口：`--json`（*"Print active sessions (interactive and background) as a JSON array and exit (for scripting; does not require a TTY)"*）、`--all`（含已完成的）、`--cwd <path>` `[实测] §10-[2]`

二进制里可确证的 CLI 参数串与其互斥校验（零额度、`grep -a -F`）：`--include-partial-messages`、`--forward-subagent-text`、`--include-hook-events`、`--session-mirror`、`--await-claim`、`--await-initialize`、`--replay-user-messages`；且有硬约束错误串 *"Error: --forward-subagent-text requires --print and --output-format=stream-json."* `[实测] §10-[4]`

## 3. 证据：Agent SDK typings（带行号，`sdk.d.ts`）

`[实测] §10-[3]` —— 行号为 `sdk.d.ts` 内行号。

| 选项 | 行号 | 语义（原文摘要） |
|---|---|---|
| `resume?: string` | 1925 | *"Session ID to resume. Loads the conversation history from the specified session."* |
| `forkSession?: boolean` | 1574 | *"When true, resumed sessions will fork to a new session ID rather than continuing the previous session. Use with `resume`."* |
| `resumeSessionAt?: string` | 1939 | *"When resuming, only resume messages up to and including the message with this UUID ... Accepts any chain-entry UUID"* |
| `sessionId?: string` | 1931 | *"Cannot be used with `continue` or `resume` unless `forkSession` is also set"* |
| `continue?: boolean` | 1459 | *"Mutually exclusive with `resume`."* |
| `agents?: Record<string, AgentDefinition>` | 1441 | 自定义代理定义表 |
| `includePartialMessages?: boolean` | 1725 | *"When true, `SDKPartialAssistantMessage` events will be emitted during streaming."* |
| `forwardSubagentText?: boolean` | 1732（Options）/ 4016（`SDKControlInitializeRequest`） | *"Forward subagent text and thinking blocks as assistant/user messages with `parent_tool_use_id` set. By default, only tool_use/tool_result blocks from subagents are emitted ..."* |
| `permissionMode?: PermissionMode` | 91 / 1833 | 6 值联合，见下 |
| `canUseTool?: CanUseTool` | 1454 | *"Called before each tool execution to determine if it should be allowed, denied, or prompt the user."* |
| `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` | 1595 | 33 个 Hook 事件，含 `SubagentStart/SubagentStop/TeammateIdle/TaskCreated/TaskCompleted` |
| `persistSession?: boolean` | 1680 | **默认 true**；*"When false ... Sessions will not be saved to ~/.claude/projects/ and cannot be resumed later."* ⚠ |
| `disallowedTools?: string[]` | 50 / 1469 | *"These tools will be removed from the model's context and cannot be used"* |
| `maxTurns?: number` | 75 / 1772 | 轮次上限 |
| `abortController?: AbortController` | 1401 | 取消 |
| `permissionPrompts?: 'host' \| 'none'` | 1859 | `'none'` = 无人应答，需审批的一律立即拒绝，`canUseTool` 永不被调用 |
| `allowDangerouslySkipPermissions?: boolean` | 1845 | `bypassPermissions` 必配 |
| `sandbox?: SandboxSettings` | 2032 | 见 §4 sandbox 行 |

类型定义 `[实测]`：

- `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（`sdk.d.ts:2317`）
  ⚠ 与 CLI 的 6 个 choices **不完全同名**：CLI 是 `manual`，SDK 是 `default` —— 映射不能直接透传。
- `HookEvent`（`873`）33 值：`PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay`
- `CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal; suggestions?; blockedPath?; ... }) => Promise<PermissionResult>`（`209`）—— 支持 `updatedPermissions` 的"永久放行"与 `blockedPath` 诊断。
- `SDKMessage` 联合 **39 种**（`4681`），含 `SDKPartialAssistantMessage`（`type:'stream_event'`，即 Anthropic Messages 原始流事件）、`SDKResultMessage`（`success | error_*`）、`SDKTaskStarted/Updated/Progress/Notification`、`SDKPermissionDeniedMessage`、`SDKRateLimitEvent`、`SDKThinkingTokensMessage`、`SDKToolProgressMessage`、`SDKAuthStatusMessage`。
- `Query` 控制面（`2601`）：`interrupt()`(2615)、`setPermissionMode()`(2622)、`setMcpPermissionModeOverride()`(2639)、`setModel()`(2649)、`rewindFiles()`(2850)、`stopTask()`(2926)。
- 成本/用量：`total_cost_usd`(4968 |=5031)、`usage: NonNullableUsage`(4972)、`modelUsage: Record<string, ModelUsage>`(4976)；`SDKResultSuccess` 还有 `duration_ms / duration_api_ms / ttft_ms`(5005+)。
- `AgentDefinition`（`38`）：`description`、`prompt`、`tools?`、`disallowedTools?`、`model?`（`'inherit'` 继承主模型）、`mcpServers?`、`skills?`、`initialPrompt?`、`maxTurns?`、`background?`、`memory?`、`criticalSystemReminder_EXPERIMENTAL?`。
- `query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`（`2953`）。
- **程序化会话 API（本机实跑通过）**：`forkSession(_sessionId, {upToMessageId?, title?})`(738) → `{sessionId}`、`listSessions({dir?,limit?,offset?,includeWorktrees?,includeProgrammatic?,sessionStore?})`(992)、`getSessionInfo`(767)、`getSessionMessages`(797)、`listSubagents(sessionId)`(1047)、`getSubagentMessages(sessionId, agentId)`(834)、`renameSession`(2964)、`deleteSession`(568)、`tagSession`(8521)、`importSessionToStore`(895)、`InMemorySessionStore`、`foldSessionSummary`(720)。
- `SDKSystemMessage`（`5150`）字段：`subtype:'init'`、`agents?: string[]`、`tools: string[]`、`mcp_servers[]`、`model`、`permissionMode`、`slash_commands[]`、`skills[]`、`plugins[]`、`apiKeySource`、`claude_code_version` —— **`tools[]` 是运行时真实工具清单，是"原生子代理存在"的最直接运行时证据位**。

## 4. 证据：原生子代理（Agent / SendMessage / ListAgents / Workflow）

三条互补证据，全部零额度：

**A. 二进制字符串（`[实测] §10-[4]`）**

```text
var g={Task:"Agent",KillShell:"TaskStop",KillBash:"TaskStop",ListPeers:"ListAgents",
       Brief:"SendUserMessage",ListMcpResources:"ListMcpResourcesTool",...}
```

即 2.1.310 的**工具别名表**：`Task → Agent`、`ListPeers → ListAgents`、`Brief → SendUserMessage`。出现次数：`ListAgents` 7、`SendMessage` 63、`TaskStop` 31、`Workflow` 241、`SendUserMessage` 13、`ListPeers` 3。

工具描述原文（同处）：

- `ListAgents`：*"Lists agents you can `<SendMessage>` to — in-process subagents you spawned, the teammates on your team, other local Claude sessions on this machine, your Claude sessions running in the cloud ..., and (when Remote Control is connected here) your account's other sessions ... Names are the address: send with `SendMessage({to: "<name>", message: "..."})`"*
- `Agent`：*"Launch a new agent to handle complex, multi-step tasks"*，参数含 `description`、`prompt`、`name`（*"Makes it addressable via SendMessage({to: name}) while running"*）

**B. SDK typings（`[实测] §10-[3]`）**

- `sdk-tools.d.ts:12` `AgentInput`：`description`、`prompt`、`subagent_type?`、`model?`（`sonnet|opus|haiku|fable`）、`run_in_background?`、`name?`、`isolation?: 'worktree'|'remote'`。
- `sdk-tools.d.ts:21` `TaskStopInput`、`:42` `WorkflowInput`（含 `script`/`scriptPath`/`runId` 断点续跑）、`:14` `TaskOutputInput`。
- ⚠ `SendMessage` / `ListAgents` **没有公开的 typing**（`ToolInputSchemas` 联合里没有），只能靠运行时 `init.tools[]` 或二进制证据 → 属 `TO-VERIFY`（见 §9）。

**C. 落盘形状（`[实测] §10-[5c]`）**

`~/.claude/projects/<project-slug>/<sessionId>/subagents/agent-<agentId>.meta.json` 实际存在，键为
`agentType`、`description`、`spawnDepth`、`toolUseId`；本机两条样本 `agentType` 分别为 `general-purpose` 与 `claude`，`spawnDepth=1`。
→ **`spawnDepth` 是嵌套深度的第一等字段**，可直接用作兼容层的深度上限依据。`[实测]`

## 5. 证据：会话枚举与续接（本机实跑）

1. `claude agents --json`（零额度、无 TTY 需求）：RC=0，返回 JSON 数组，行键 `[cwd, kind, name, pid, sessionId, startedAt, status]`，本机 1 条（`kind=interactive, status=idle`）。`[实测] §10-[5]`
2. **SDK 程序化 API 实跑**（`node -e` 导入 `sdk.mjs`，纯读文件、零额度）：`[实测] §10-[5b]`
   - `sdk` 导出 31 个符号；会话类：`listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, forkSession, renameSession, deleteSession, tagSession, importSessionToStore, InMemorySessionStore, foldSessionSummary`
   - `listSessions({limit:5})` → 5 行，行键 `createdAt, customTitle, cwd, fileSize, firstPrompt, gitBranch, lastModified, sessionId, summary, tag`
   - `listSubagents(<sessionId>)` → `[]`（见 §6 坑 5）
3. 落盘：5 个 session jsonl / 3 个项目目录。`[实测]`

## 6. 限制与已知坑

1. **CLI 与 SDK 双版本线（且有三条身份）**：SDK 0.3.263 + 内置 CLI 2.1.263（适配器基线，SDK 平台包的 `manifest.json.version`）；宿主 nvm CLI 2.1.310 属**另一条升级线**，默认不使用。SDK 通过平台包/`pathToClaudeCodeExecutable`(1824) 启动 CLI，**没有显式握手校验**。适配器必须钉死「SDK 包版本 + 内置 CLI 版本」并做首轮 `init.claude_code_version` 断言（不能只钉宿主 `claude --version`）。
2. **`persistSession: false` 会直接掐死 resume/fork**：SDK 明确写 *"cannot be resumed later"*（`1680`）。DSH 现有插件正是这么设的 → 见 §7。
3. **`--include-partial-messages` / `--forward-subagent-text` 只在 `--print` + `--output-format=stream-json` 下有效**（CLI 帮助 + 二进制硬错误串双证）。交互 TUI 模式下没有增量流 → 进度流必须走 `--print` 路径。
4. **`permissionMode` 命名不一致**：CLI `manual` vs SDK `default`；此外 CLI 的 `--permission-mode` 不接受 SDK 的 `'default'`。透传会直接报错。
5. **`listSubagents` 依赖 `agent-<agentId>.jsonl`**（`sdk.d.ts:1047` 注释），而本机只有 `agent-<id>.meta.json`（无 jsonl）→ 返回空数组。**不能把 `listSubagents()` 当作"子代理是否存在"的判据**；判据应用 `subagents/` 目录扫描 + `SDKSystemMessage.tools` 包含 `Agent`。`[实测]`
6. **无人值守的默认姿态**：`--permission-prompts none` 会让"本应弹窗"的一律**立即拒绝**（帮助原文 + `permissionPrompts` 注释 1859）。这与 DSH 现有插件用 `canUseTool: () => deny` 效果等价，但 `none` 更彻底（连 `canUseTool` 都不调）。若要"自动放行读、拒绝写"，只能走 `--permission-mode` + `--allowedTools/--disallowedTools` 的组合，或 `canUseTool` 实现策略。
7. **worktree 有两个入口，语义不同**：CLI 侧 `-w, --worktree [name]`（*"Create a new git worktree for this session (optionally specify a name)"*，`claude --help:263`）与 `--tmux`(251，需 `--worktree`) 作用于**整个会话**；SDK 侧 `AgentInput.isolation: 'worktree' | 'remote'`（`sdk-tools.d.ts:12`）只作用于**子代理**。二者不互通：会话级 worktree 只能由 CLI 参数或外层环境提供。`[实测]`
8. **`--from-pr` 不可脚本化**：它打开交互 picker 或按 PR 号 resume；PR 号→sessionId 的映射未导出 API，属 `TO-VERIFY`。`[文档]`

## 7. 证据：DSH 现有插件把哪些能力关掉了

`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-claude-code/lib/index.js`（554 行）`[实测] §10-[7]`

```js
// L296-326 function claudeQueryOptions(...)
return {
  abortController: controller,
  cwd: spec.cwd,
  ...(spec.model === void 0 ? {} : { model: spec.model }),
  env: { ...scrubbedParentEnv(), ...spec.env },
  persistSession: false,                          // ← L306：续接/落盘被关
  disallowedTools: spec.permissionMode === "plan"
    ? ["AskUserQuestion", "ExitPlanMode"]
    : ["AskUserQuestion"],                         // ← L307：只禁两把工具
  permissionMode: spec.permissionMode,             // ← L308
  ...(spec.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : { canUseTool: () => { ...; return { behavior: "deny", message: "This unattended Claude Code subagent cannot request human approval." }; } }),  // ← L309-314：一律 deny
  onElicitation: () => ({ action: "decline" }),    // ← L316
  onUserDialog: () => ({ behavior: "cancelled" }), // ← L320
  supportedDialogKinds: ["refusal_fallback_prompt"], // ← L324
  spawnClaudeCodeProcess: (options) => {...}
};
```

结论（对照 `QueryOptions`）：

| SDK 能力 | 插件是否使用 | 后果 |
|---|---|---|
| `persistSession: false` | 用（L306） | 会话不落盘 → **`resume`/`forkSession`/`listSessions` 全部失效** |
| `resume` / `forkSession` / `continue` | **未传** | 一次性执行 |
| `includePartialMessages` | **未传** | 无增量流，只能拿完整消息 |
| `forwardSubagentText` | **未传** | 子代理只有 tool_use/result，无嵌套转写 |
| `agents` | **未传** | 不能用 `--agents` 自定义角色 |
| `hooks` | **未传** | 无 `SubagentStart/Stop`、`PreToolUse` 等观测点 |
| `canUseTool` | 用（一律 `deny`） | 除 `bypassPermissions` 外无法放行任何工具 |
| `permissionMode` | 用，枚举 `["dontAsk","acceptEdits","auto","plan","bypassPermissions"]`，默认 `dontAsk` | **缺 `default`**；`manual` 不可用 |
| `maxTurns` | 未传 | 无轮次硬上限 |
| 结果消费 | `for await` 全流但**只认 `type==="result" && subtype==="success"`**，其余非 success 直接抛 `ClaudeCodeFailure`（L211-243） | 中间事件全部丢弃；失败被压成错误分类 |
| `env` | `scrubbedParentEnv()` + `spec.env` | 父进程敏感变量已清洗（正面事实） |

→ **产品侧原语齐全，缺口全在插件的选项选择**：`persistSession:false` + 只取一条 result 这两个决定，单独就足以让"可续接/可观测"归零。

## 8. 15 项能力清单（claude-code 侧，供 D3 矩阵直接引用）

| # | 能力 | 结论 | 证据（可复跑） |
|---|---|---|---|
| 1 | headless | **支持** | `claude -p --output-format {text,json,stream-json}`、`--input-format stream-json` `§10-2` |
| 2 | stream | **支持** | `--include-partial-messages`（仅 print+stream-json）+ `SDKPartialAssistantMessage`(4826，39 种消息之一) `§10-2/3` |
| 3 | resume | **支持** | CLI `-r/--resume`(210)、`--continue`(67)；SDK `resume`(1925) `§10-2/3` |
| 4 | fork | **支持** | CLI `--fork-session`(104)+`--resume`；SDK `forkSession?:boolean`(1574)、`forkSession()`(738)、`resumeSessionAt`(1939) `§10-2/3` |
| 5 | session-list | **支持（程序化）** | `listSessions()` 实跑返回 5 行(`§10-5b`) + `claude agents --json`(`§10-5`) + `getSessionInfo/listSubagents` `§10-3` |
| 6 | interrupt | **支持** | `Query.interrupt()`(2615)、`stopTask()`(2926)+`SDKControlInterruptResponse` `§10-3` |
| 7 | native-subagents | **支持** | `Agent/TaskStop/Workflow/ListAgents/SendMessage` 二进制证据 + `AgentInput`(`sdk-tools:12`) + `subagents/agent-*.meta.json`(`spawnDepth`) `§10-4/5c` |
| 8 | tool-extension | **支持** | `--mcp-config/--strict-mcp-config`、`mcpServers`、`agents`(1441)、`hooks`(1595)、`--plugin-dir`、`createSdkMcpServer`(511) `§10-2/3` |
| 9 | permission-modes | **支持（有命名坑）** | CLI 6 choices(151) / SDK `PermissionMode`(2317) / `--permission-prompts host\|none`(155) / `canUseTool`(1454) `§10-2/3` |
| 10 | sandbox | **部分（无 OS 级强制）** | 无 CLI 沙箱 flag；`Settings.sandbox?: SandboxSettings`(2032) + `--restricted`(195) + `--tools`(255) 只有工具级收窄；C5 实测未获得 OS 级强制证据 → 适配器能力位 `emulated` `§10-2/3` |
| 11 | auth-model-routing | **支持** | `--model/--fallback-model`、`AgentDefinition.model`、`Query.setModel()`(2649)、`--settings`、`apiKeySource`(5155，仅来源枚举、不含值) `§10-2/3` |
| 12 | concurrency | **部分（无硬上限文档化）** | 后台会话 `--bg`+`claude agents`+`attach/logs/stop/rm/respawn`；`Agent.run_in_background`；但**未发现全局并发上限配置项** → `TO-VERIFY`（见 §9） `§10-2` |
| 13 | usage-observability | **支持** | `total_cost_usd`(4968)、`usage`(4972)、`modelUsage`(4976)、`SDKRateLimitEvent`、`SDKThinkingTokensMessage` `§10-3` |
| 14 | structured-protocol | **支持** | `stream-json` 双向流（`--input-format/--output-format`）+ 39 种 SDKMessage + control protocol `SDKControlInitializeRequest`(3971) `§10-2/3` |
| 15 | version-pinning | **部分（有坑）** | SDK 0.3.263 + 内置 CLI 2.1.263 为基线（宿主 CLI 2.1.310 是另一条线）、无握手校验；靠 SDK/平台包版本静态断言 + 首轮 `init.claude_code_version`(5157) 运行时断言（stream 模式下 init 在首次输入后才到） `§10-1/3` |

## 9. 未决项（TO-VERIFY）

| ID | 缺什么 | 怎么补（施工阶段） |
|---|---|---|
| V-CC-1 | `SendMessage` / `ListAgents` 的**输入 schema**（typings 无） | C5：跑 1 次 `query({prompt:"..."})`，读 `init` 消息的 `tools[]` 与 `tool_use` 入参；或抓二进制里工具 JSON schema 串 |
| V-CC-2 | `resume` + `forkSession:true` 的真实往返（会写盘，本次按只读纪律未跑） | C5：新建 session → resume 1 turn → `forkSession` → 断言新 `sessionId` 且旧会话可再读 |
| V-CC-3 | `--from-pr` 的 PR→sessionId 映射是否可编程 | 只读查 `~/.claude` 是否有 PR 索引；否则登记为"不可脚本化" |
| V-CC-4 | 并发硬上限在哪配置（是否有 `maxConcurrentAgents` 类键） | 在 `resolveSettings()/Settings` 里 grep `agents|concurren|parallel`；或读 `claude --settings` 支持的 schema |
| V-CC-5 | `canUseTool` 的 `updatedPermissions` 精确回填语义 | 读 `PermissionUpdate` 类型 + 1 次实测 allow 后不再询问 |
| V-CC-6 | `permissionMode: 'auto'` 的分类器是否可离线/可控 | 读 `auto-mode` 子命令；实测 1 turn |

## 10. 复跑命令块

```bash
# 一键复跑全部证据（幂等、只读、零额度）；退出码 0 = 探测完成
cd /Users/lakii2982/项目/多智能体编排
bash repro/probe-claude.sh
# 原始产物落在 ${TMPDIR}/mocl-probe/claude/（可用 MOCL_PROBE_OUT 覆盖）

# --- 单条精查 ---
# 1) 双版本
claude --version
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/package.json'))['version'])"

# 2) CLI flag 真实帮助（带行号）
claude --help > /tmp/cc-help.txt
grep -nE '^  (-[a-zA-Z], )?--(agents|resume|continue|fork-session|include-partial-messages|forward-subagent-text|from-pr|permission-mode|permission-prompts|output-format|worktree|mcp-config)\b' /tmp/cc-help.txt

# 3) SDK typings 行号
S=$HOME/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
grep -nF -e 'resume?: string;' -e 'forkSession?: boolean;' -e 'agents?: Record<string, AgentDefinition>;' \
          -e 'includePartialMessages?: boolean;' -e 'persistSession?: boolean;' -e 'canUseTool?: CanUseTool;' "$S"
grep -nE '^export declare (function|type) (listSessions|forkSession|listSubagents|getSessionInfo|PermissionMode|SDKMessage)' "$S"

# 4) 原生子代理工具：二进制字符串（零额度）
BIN=$(readlink -f "$(command -v claude)")
for p in ListAgents SendMessage TaskStop Workflow; do printf '%-14s ' "$p"; LC_ALL=C grep -a -c -F "$p" "$BIN"; done
LC_ALL=C grep -a -o -E 'var g=\{Task:"Agent"[^}]*\}' "$BIN" | head -1

# 5) 会话枚举
claude agents --json | python3 -m json.tool | head -20

# 5b) SDK 程序化会话 API（只读实跑）
node --input-type=module -e "
const sdk = await import('$HOME/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
console.log(Object.keys(sdk).filter(n=>/Session|Subagent/.test(n)).join(', '));
const l = await sdk.listSessions({ limit: 3 });
console.log(l.length, Object.keys(l[0]||{}).join(','));
"

# 5c) 子代理落盘形状（spawnDepth 是第一等字段）
find ~/.claude/projects -type d -name subagents -exec ls {} \;
cat ~/.claude/projects/*/*/subagents/agent-*.meta.json 2>/dev/null | head -5

# 6) DSH 插件把能力关在哪
P=$HOME/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-claude-code
sed -n '296,330p' $P/lib/index.js
grep -nE 'persistSession|canUseTool|includePartialMessages|resume|forkSession|agents:' $P/lib/index.js
```
