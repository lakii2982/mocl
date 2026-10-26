# claude-code 适配器规格（D5a / L1 适配器）

> 本文件只写 **claude-code → ABI** 的映射与实现约束。ABI 定义一律引用 `docs/abi/abi-v0.md`（**唯一命名真源**），
> 不在此处重述事件/错误码/能力位/方法名；DSH 接入属 `docs/integration/*`（D6 写域），不在本文。
> 写域：本文件 + `docs/adapters/codex.md`。

| 项 | 值 |
|---|---|
| `backendId` | `claude-code` |
| `transport` | `agent-sdk`（ABI §4 绑定表；SDK 内部拉起 CLI 子进程） |
| 钉死的 SDK | `~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/` → **`0.3.263`**（入口 `sdk.mjs`） |
| 钉死的 CLI | **SDK 内置 CLI `2.1.263`**（平台包 `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263` 的 `manifest.json.version`；默认**不传** `pathToClaudeCodeExecutable`）。宿主 nvm 全局 `claude` = `2.1.310` 属**另一条升级线**，默认不使用 |
| 禁止 | 直接拼 CLI 参数、交互 TUI 模式、`persistSession:false` |
| 上游契约 | `docs/abi/abi-v0.md`、`docs/research/claude-code.md`（下称 `R`）、`docs/research/capability-matrix.md`（下称 `M`）、`docs/integration/00-dsh-integration.md`（下称 `C`） |
| 状态 | **C5 实测回填版**（基线 CLI 2.1.263 / stream 握手时序 / sandbox=emulated / 禁 `allowedTools` 已按真实链路修订；`[未验证]` 项保留标注） |

**证据标记**：`[实测]` = 本机可复跑（`bash repro/probe-claude.sh`）；`[实测-本轮]` = 本次规格编写时的只读探测（命令见 §12.3、输出见附录 A）；`[文档]` = typings/`--help` 原文；`[推断]` = 前两者推导、未直接执行。

**一句话架构**：`Broker(L2) → L1 claude 适配器 → L0 agent-sdk 绑定 → SDK query() → CLI 子进程`。SDK 不是"另一个后端"，它是 **CLI 的控制面 + 类型化消息流**；ABI 事件 = `SDKMessage`（39 种）筛选映射 + 轮次推导。

---

## 1. 身份与版本

### 1.1 身份字段（**两条升级线**，必须双钉）

> **C5 实测修订（D5a-1）**：适配器基线 CLI 是 **SDK 内置 CLI `2.1.263`**，不是宿主 nvm 的 `claude` 2.1.310。
> SDK 0.3.263 通过 `optionalDependencies` 安装平台包 `@anthropic-ai/claude-agent-sdk-<platform>@0.3.263`，
> 其 `manifest.json.version = "2.1.263"`；**不传** `pathToClaudeCodeExecutable` 时 `query()` 直接用它。
> 宿主的 `~/.nvm/versions/node/v24.18.1/bin/claude`（2.1.310）是**另一条升级线**，只有显式配置 `claudeCodeExecutable` 才走，必须单独断言。

| 角色 | 路径 | 版本 | 证据 |
|---|---|---|---|
| **基线** SDK 内置 CLI | `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.263/.../claude`（bun 单文件，~199 MB） | **2.1.263** | 平台包 `manifest.json.version` `[实测-本轮]`；C5 `init.claude_code_version=2.1.263` `[实测]` |
| Agent SDK 包 | `@anthropic-ai/claude-agent-sdk/package.json` | **0.3.263** | `R:12`、`[实测-本轮]` |
| SDK typings | 同目录 `sdk.d.ts`（8804 行）/ `sdk-tools.d.ts`（4134 行） | — | `R:13` `[实测]` |
| 宿主 CLI（**另一条线**，默认不用） | `~/.nvm/versions/node/v24.18.1/bin/claude` | 2.1.310 | `claude --version` `[实测]`；仅显式 `claudeCodeExecutable` 时生效 |

| 字段 | 取值 | 说明 |
|---|---|---|
| `backendVersion` | `0.3.263+2.1.263`（SDK+**内置 CLI**） | ABI `backendVersion` 是单串，故组合表达；外部 CLI 线才是 `0.3.263+2.1.310` |
| `nativeProtocolVersion` | `sdk-0.3.263/cli-2.1.263`（**无协议版本号**，用组合版本代替） | SDK 无握手校验（`R:129`） |
| `protocolSchema` | `recorded`（**无离线 schema 导出**） | `M:26`：claude 用录制回放做契约回归 |
| `pinnedCliPath` | **默认不传**（走 SDK 平台包内置 CLI）；仅外部 CLI 线传绝对路径给 `pathToClaudeCodeExecutable`（`sdk.d.ts:1824`） | 不用 `PATH` 上的 `claude`，也不混用宿主线 |

**为什么必须双钉**（**最容易踩的坑 #1**）：SDK 与它内置的 CLI 也是两个独立产物（平台包 `0.3.263` 内含 CLI `2.1.263`，`R:17`），SDK 经平台包/`pathToClaudeCodeExecutable` 启动 CLI，**二者之间没有显式握手校验**（`R:129` `[实测]`）。宿主 CLI 2.1.310 是**第三条身份**（nvm 全局安装、独立升级）；混用会让 `init.claude_code_version`、`--help`/flag 证据（`R:2`）全部错位 → 默认禁止。

### 1.2 版本断言（四个断言点；**V3 在首轮 `send` 内完成**，见 §2.3）

| # | 断言点 | 期望 | 失败分类 |
|---|---|---|---|
| V1 | SDK 包 `package.json.version`（启动前静态） | `0.3.263` | `protocol.version-mismatch` |
| V2 | SDK 平台包内置 CLI `manifest.json.version`（启动前静态）；外部 CLI 线改为 `claude --version` | `2.1.263`（默认线）/ `2.1.310`（外部线） | `protocol.version-mismatch` |
| V3 | 首个 `send` 内收到的 `system/init.claude_code_version` | 同 V2 的线 | `protocol.version-mismatch`（**首轮 send 时**发现；该会话后续 `send` sticky 失败） |
| V4 | `system/init.tools[]` 含 `Agent`（或旧别名 `Task`） | 存在 | `session.warning{code:"native-subagents-absent"}` + `nativeSubagents` 降为 `unavailable` |

V1/V2 是"我们启动了什么"，V3 是"对端实际是什么"，V4 是**运行时能力探测**（比"文档说支持"更硬，ABI SEC-5）。
**注意**：stream-input 模式下 `init` 不在 `open()` 内到达（§2.3），所以 V3 只能在首轮 `send` 中完成，不能作为 open 的失败条件。

### 1.3 与 DSH 现有插件的差别（为什么现在"一次性"）

现有插件（`@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`）把能力关在选项里（`R:140-180`、seam 事实基线（`docs/integration/00-dsh-integration.md` §1））：

| 插件选择 | 后果 | 本文要求 |
|---|---|---|
| `persistSession:false`（L306） | 会话不落盘 → `resume`/`forkSession`/`listSessions` **全部失效**（`R:168`） | **必须 true**（默认即 true，见 `sdk.d.ts:1680` `@default true`） |
| `canUseTool` 一律 deny（L309-314） | 无审批桥，任何需审批动作直接失败 | 改为**策略化代答 + 超时 fail-closed**（§7.2） |
| 只认 `type==="result" && subtype==="success"`，其余抛错（L211-243） | 中间事件全丢、失败被压成单一异常 | 全量映射 39 种消息（§5.2），失败按 §10.1 分类 |
| 未传 `resume`/`forkSession`/`includePartialMessages`/`agents`/`hooks`/`maxTurns` | 无续接、无增量、无自定义角色、无观测点、无轮次上限 | 按 §2.2 基线全开 |

---

## 2. 启动与握手

### 2.1 传输通道选型：Agent SDK（为什么不选 CLI `-p`）

| 通道 | 判定 | 依据 |
|---|---|---|
| **Agent SDK（选）** | 进程内控制面：`Query.interrupt()`（`sdk.d.ts:2615`）、`setPermissionMode()`（2622）、`setModel()`（2649）、`stopTask()`（2926）、`streamInput()`（2921）；程序化会话 API：`listSessions()`（992）、`getSessionInfo()`（767）、`getSessionMessages()`（797）、`forkSession()`（738）；权限桥 `canUseTool`（1454/209） | `R:81`、`R:85`、`[实测]` |
| CLI `--print --output-format stream-json`（**不作主通道**） | 只有 stdin/stdout；无 `interrupt`/`setModel`/`setPermissionMode` 的控制方法（只能发信号）；无程序化会话列举/分叉（`claude agents --json` 只能列 active，`R:45`）；参数互斥由 CLI 硬校验（如 `--forward-subagent-text` 必须配 `--print`+`stream-json`，`R:47`）；`--from-pr` 打开交互 picker（`R:136`） | `R:41`、`R:131`、`R:136` |
| ACP（不可选） | claude 产品面**没有** ACP；`--help` 子命令表无 `acp`（`R:43` 子命令清单） | `M:38` |
| 交互 TUI（不选） | `--include-partial-messages` **仅** `--print` + `stream-json` 生效（`R:131`）→ TUI 无增量流，进度面归零 | `R:29`、`R:131` |

**关键事实：SDK 就是 CLI 的壳，不是替代实现**。`sdk.mjs` 内部把 `Options` 拼成 CLI 参数（`[实测-本轮]` 读取 `sdk.mjs` 第 121 行的参数构造器，见附录 A-5）：`resume → --resume=<id>`、`forkSession → --fork-session`、`continue → --continue`、`includePartialMessages → --include-partial-messages`、`permissionPrompts → --permission-prompts <x>`、`canUseTool → --permission-prompt-tool stdio`、`persistSession:false → --no-session-persistence`。→ **选 SDK 的收益是控制面与类型化消息，不是换协议**；也正因如此，**禁止**在 `env`/`spawnClaudeCodeProcess` 里再手拼这些 flag（会与 SDK 的构造逻辑重复/冲突）。

**切换成本（退回裸 CLI `-p`）**：低代码量、高能力损失。必须把 `interruptTurn` 降为 `processKillInterrupt`（R-3）、`permissionAutoReply` 降 `unavailable`（R-6，只能 `--permission-prompts none` 全拒）、`permissionRequestBridge` 降 `unavailable`（R-7）、`listSessions` 降 `emulated`（只能 `claude agents --json` 看 active）、`forkSession` 降 `emulated`（`--fork-session` 能分叉但拿不到程序化结果对象）、`planUpdates/diffUpdates` 本来就无。等于把一个 11✅ 后端降级（`M:7` 口径），故只作应急。

### 2.2 spawn 与 `query()` 基线选项

SDK 每次 `query()` 拉起一个 CLI 子进程（`sdk.d.ts:2953` 签名 `query({prompt: string | AsyncIterable<SDKUserMessage>, options?})`）。基线 `Options`：

```js
{
  cwd,                                   // sdk.d.ts:1463（绝对路径，适配器先校验）
  // pathToClaudeCodeExecutable: 默认不传 → 走 SDK 平台包内置 CLI 2.1.263（§1.1）；
  // 只有外部 CLI 线才传绝对路径（此时 V2/V3 期望 2.1.310）
  sessionId: crypto.randomUUID(),        // sdk.d.ts:1931 —— 新建会话预生成 UUID（§2.3）
  env: scrubbedEnv,                      // sdk.d.ts:1525；参照插件的 scrubbedParentEnv()
  persistSession: true,                  // sdk.d.ts:1680 —— 关掉即失去续接
  includePartialMessages: true,          // sdk.d.ts:1725 —— token 级增量
  forwardSubagentText: true,             // sdk.d.ts:1732 —— 子代理文本可见（childSessionUpdates）
  permissionPrompts: 'host',             // sdk.d.ts:1859 —— 让 canUseTool 能被调用
  canUseTool: policy,                    // sdk.d.ts:1454 / 209 —— 权限唯一入口（§7.2）
  permissionMode, disallowedTools,       // §7.1；**禁止 allowedTools**（会绕过 canUseTool）
  maxTurns: 200,                         // sdk.d.ts:1772 —— 轮次硬上限（防跑飞）
  maxBudgetUsd,                          // sdk.d.ts:1777 —— 产品侧预算门禁（可选）
  sandbox: sandboxSettings,              // sdk.d.ts:2032 —— 产品面选项；能力声明见 §7.3（emulated）
  settings: policyTierSettings,          // sdk.d.ts:2050 —— 策略层
  abortController,                       // sdk.d.ts:1401 —— 超时/中断
  mcpServers, plugins, strictMcpConfig,  // §6 工具扩展面
}
```

- `env`：只透传白名单（系统变量 + `ANTHROPIC_*`/`CLAUDE_*`；`GITHUB_TOKEN`/`AWS_*` 等敏感变量不传且不打印）；`CLAUDE_CONFIG_DIR` 可用于隔离（`sdk.d.ts:1687` 的 `sessionStore` 注释提到该变量）。
- `sessionId`：新建会话时由适配器预生成 UUID 并作为 ABI `remoteSessionId` 返回；`resume`/`forkSession` 互斥语义见 §4.3。
- 一个 ABI 会话 ↔ 一个 SDK `query()` 会话；进程数 = 活跃查询数（§9.1）。

### 2.3 握手（**stream 模式下 init 在首轮 `send` 内到达**，open 只预生成会话 id）

> **C5 实测修订（D5a-2）**：`query({prompt: AsyncIterable<SDKUserMessage>})`（模式 A，长驻查询）时，
> `system/init` **要等首次输入写入后**才发出；实测空输入流下等 15 s 仍无 init，`deferSpawn:false` 也无效（非公开选项）。
> 因此 `open()` **不能**等 init，否则必然 30 s 超时。做法：open 用 `Options.sessionId` 预生成 UUID 并作为
> `remoteSessionId` 返回；版本/`session_id` 断言挪到首个 `send`。

```text
open():  randomUUID() → Options.sessionId
         query() 启动（此时 CLI 尚未发首帧）→ 返回 { remoteSessionId, capabilities }

send():  写入首条 user 消息 → CLI 子进程启动 → 首条消息：
{ "type":"system", "subtype":"init", "session_id":"<预生成 UUID>", "claude_code_version":"2.1.263",
  "cwd":"/abs/path", "model":"…", "permissionMode":"dontAsk", "apiKeySource":"oauth|none|…",
  "tools":["Agent","Bash","Read",…], "mcp_servers":[…], "agents":[…], "skills":[…],
  "plugins":[…], "capabilities":[…], "slash_commands":[…] }
        → 校验 claude_code_version / session_id
        → 成功后才把本 turn 视为已受理；失败 → 关闭查询，后续 send 立即失败
```

`SDKSystemMessage` 字段（`sdk.d.ts:5148-5200`）：`agents?`、`apiKeySource`、`claude_code_version`、`cwd`、`tools`、`mcp_servers`、`model`、`permissionMode`、`slash_commands`、`skills`、`plugins`、`capabilities?`、`session_id`、`uuid`。

- **open 契约**：`remoteSessionId` = 预生成 UUID（**先于 init 可知**）；`persistSession:true` 下它就是会话文件名，首轮后可在 `~/.claude/projects/**/<uuid>.jsonl` 探测到（§4.4）。`sessionId` 与 `resume` 互斥（`sdk.d.ts:1931`，仅 `forkSession` 可组合）。
- **首轮 send 内的握手断言**：写入首条输入后等 init，默认 30 s；超时 → `transport.timeout`（fail-closed，关闭查询）。
  `claude_code_version` 不符 → `protocol.version-mismatch`（**sticky**：该会话后续 send 直接失败）；`session_id` 与预生成 UUID 不符 → `protocol.unexpected-response`。
- **resume 时** `session_id` 以 init 回填（`forkSession` 会产生新 id）；此后每条消息都带 `session_id`，可用于发现 `conversation_reset` 的 id 变更（§5.2 #39）。
- **`tools[]` 是运行时真实工具清单**，是"原生子代理存在"最硬的运行时证据位（`R:86`）；`agents?` 是自定义代理名列表（用 `agents` 选项定义后出现）。
- `apiKeySource` 只有**来源枚举**（`sdk.d.ts:127`：`ANTHROPIC_API_KEY|apiKeyHelper|/login managed key|none|user|project|org|temporary|oauth`），`none` → `auth.missing-credential`；**绝不**读取凭据值。
- **ABI AB-V2 的结论保持不变**：`init` **稳定提供** `claude_code_version` 与 `tools[]`（`[实测]` typings + C5 真实一轮），可作版本断言与 `nativeSubagents` 判据；**修订的只是时序**（首轮内，而非 open 内）。

### 2.4 能力声明（`capabilities.json` 校验通过；34 位全量，按 `bit` 名排序）

```json
{
  "abiVersion": "0.1",
  "backendId": "claude-code",
  "backendVersion": "0.3.263+2.1.263",
  "transport": "agent-sdk",
  "nativeProtocolVersion": "sdk-0.3.263/cli-2.1.263",
  "bits": [
    {"bit": "backgroundRuns", "state": "emulated", "detail": "查询为前台子进程；后台语义由 Broker 队列模拟"},
    {"bit": "childSessionUpdates", "state": "native", "detail": "task_started/updated/notification + parent_tool_use_id；需 forwardSubagentText"},
    {"bit": "concurrencyControl", "state": "unavailable", "detail": "未发现全局并发上限配置键（U6）→ 由 Broker 信号量强制"},
    {"bit": "diffUpdates", "state": "unavailable", "detail": "无结构化 diff 事件；改动在 tool_result 文本里"},
    {"bit": "forkSession", "state": "native", "detail": "forkSession:true + resume；或 forkSession() API"},
    {"bit": "handshakeVersion", "state": "native", "detail": "init.claude_code_version + claude --version 双断言"},
    {"bit": "headless", "state": "native", "detail": "SDK 非交互；CLI --print 面"},
    {"bit": "inputInbox", "state": "emulated", "detail": "无产品队列 API；适配器内存队列 + streamInput 转发"},
    {"bit": "interruptTurn", "state": "native", "detail": "Query.interrupt() / stopTask()"},
    {"bit": "listSessions", "state": "native", "detail": "listSessions()/getSessionInfo()（跨项目）"},
    {"bit": "modelRouting", "state": "native", "detail": "Options.model / Query.setModel() / AgentDefinition.model"},
    {"bit": "multiTurn", "state": "native", "detail": "streamInput() 同进程续轮；或 resume 重开"},
    {"bit": "nativeSubagents", "state": "native", "detail": "init.tools[] 含 Agent；task_* 事件；SendMessage/ListAgents 属实验面"},
    {"bit": "permissionAutoReply", "state": "native", "detail": "canUseTool 确定性代答 + 2s 超时 fail-closed"},
    {"bit": "permissionModes", "state": "native", "detail": "PermissionMode 6 值（CLI manual ≠ SDK default）"},
    {"bit": "permissionRequestBridge", "state": "native", "detail": "canUseTool + control protocol（--permission-prompt-tool stdio）"},
    {"bit": "planUpdates", "state": "unavailable", "detail": "plan 模式只产出文本，无结构化 plan 事件（R-17）"},
    {"bit": "processKillInterrupt", "state": "native", "detail": "SIGKILL 后 resume 可接回（persistSession:true）"},
    {"bit": "resumeSession", "state": "native", "detail": "Options.resume / resumeSessionAt"},
    {"bit": "sandboxModes", "state": "emulated", "detail": "SDK 无 OS 级沙箱强制：只有 Settings.sandbox/--restricted + 权限规则；C5 能力声明为 emulated（§7.3）"},
    {"bit": "sessionArchive", "state": "unavailable", "detail": "无归档 API；仅 Broker 侧归档记录"},
    {"bit": "sessionDelete", "state": "native", "detail": "deleteSession()"},
    {"bit": "sessionExport", "state": "emulated", "detail": "getSessionMessages() 拼转写"},
    {"bit": "sessionReseed", "state": "emulated", "detail": "新 query + seedSummary 注入首条 prompt"},
    {"bit": "sessionUnarchive", "state": "unavailable", "detail": "无归档即无取消归档"},
    {"bit": "steerTurn", "state": "native", "detail": "streamInput() 推 SDKUserMessage（priority:'now'）"},
    {"bit": "streaming", "state": "native", "detail": "includePartialMessages + stream_event"},
    {"bit": "structuredProtocol", "state": "emulated", "detail": "stream-json + control protocol，但无离线 schema 导出 → 录制回放"},
    {"bit": "tokenLevelStream", "state": "native", "detail": "SDKPartialAssistantMessage(event=content_block_delta)"},
    {"bit": "tokenUsage", "state": "native", "detail": "result.usage / message_delta.usage / modelUsage"},
    {"bit": "toolExtension", "state": "native", "detail": "mcpServers/plugins/agents/hooks/--mcp-config"},
    {"bit": "usageReporting", "state": "native", "detail": "total_cost_usd / usage / modelUsage / duration_ms"},
    {"bit": "versionPinning", "state": "native", "detail": "V1/V2/V3/V4 四断言"},
    {"bit": "worktreeIsolation", "state": "emulated", "detail": "SDK 无会话级 worktree 选项；外层建 worktree 后传 cwd"}
  ],
  "limits": {"maxTurnMs": 1800000, "idleTimeoutMs": 120000, "maxSessionsPerBackend": 8,
             "maxNestingDepth": 2, "maxConcurrentTurns": 3},
  "warnings": ["structuredProtocol 无离线 schema（录制回放）", "并发上限无产品配置键（U6）",
               "sandbox 仅为 SDK 选项面，无 OS 级强制（C5 实测，emulated）", "SendMessage/ListAgents 无公开 typing（U4，实验面）"],
  "observedAt": "2026-10-25T13:54:07.123Z"
}
```

---

## 3. 会话生命周期

### 3.1 建立（ABI `session.create`）

两种等价实现，**都要求 `persistSession:true`**：

| 模式 | 实现 | 适用 |
|---|---|---|
| **A：长驻查询 + 输入流**（推荐） | `query({prompt: asyncIterable, options})`，`AsyncIterable<SDKUserMessage>` 由适配器持有；后续 `session.send` 往流里 push，`session.steer` 用 `priority:'now'` | 高交互、低延迟；进程常驻 |
| **B：一轮一查询 + resume** | 每轮新建 `query({prompt:"…", options:{...base, resume: sessionId}})` | 崩溃隔离好；每轮多一次进程启动 |

- `backendSessionId` 从 `init.session_id` 取：**init 在 query 启动后立即到达、不需要先发输入**（`[推断-强]`：SDK 在首条输入前即完成 `initialize` 控制握手；C5 再确认一次时序）。因此模式 A 可以做到"建会话不发轮"；若某版本 init 晚于首条输入，则 `session.created` 先发、`backendSessionId` 后回填（ABI M2 允许 `null`→回填）。
- 模式 A 显式 `Query.streamInput()`（`sdk.d.ts:2921`）也可推消息；`close()`（2950）结束。
- **cwd 决定项目 slug**：会话文件落在 `~/.claude/projects/<project-slug>/<sessionId>.jsonl`（`R:15`），`<project-slug>` 由 cwd 派生 → resume 时 `cwd` 必须与创建时一致（否则可能找不到会话；`[未验证]` 留给 C5，见 §4.4 风险 R-CC-1）。

### 3.2 一轮（ABI `session.send`）

```text
query() 流开始 → [system/init] → stream_event(message_start/content_block_*) → assistant
             → (user tool_result → assistant …) → result{success|error_*}
终态：result 即一轮结束（恰一个 turn.* 终态）
```

- `turn.started`：收到**首条** `assistant` 或 `stream_event` 时发（说明模型开始产出），`model` 取 `init.model`。
- `result` → `turn.completed`（success）或 `turn.failed`（error_*），**并且**必须发 `usage.updated{scope:"turn"}`（含 `costUsd`、`durationMs`）。
- 一轮结束后会话**不终止**：`activation=inactive`，`state=running`（可被下一轮 `session.send` 或 `session.resume` 复用）；只有 `close`/超时/进程退出才改变会话状态。ABI `session.state-changed` 与 `activation` 正交（见 `session.json` 的 `activation` 字段说明）。
- 模式 B 的每轮 `result` 后 CLI 子进程退出 → 下一轮必须先 `resume`；**不能**在已退出的 query 对象上继续迭代。

### 3.3 状态映射

| 原生信号 | 判定 | ABI |
|---|---|---|
| `system/init` | 会话就绪 | `session.created{state:"running",cwd}`（首次）+ 版本/工具断言 |
| `system/session_state_changed{state}` | `idle`/`running`/`requires_action`（`sdk.d.ts:5105`） | `session.state-changed`：`running`→running，`idle`→running（act=inactive），`requires_action`→`awaiting-input` |
| `system/status{status:"requesting"}` | 正在等审批/输入（`sdk.d.ts:5133`、`SDKStatus`=5131） | 若尚未 `awaiting-input` → 发一次 `session.state-changed` |
| `system/status{status:"compacting"}` | 上下文压缩中 | `session.warning{code:"context-compacting"}` |
| `result` | 一轮结束 | `turn.*` 终态（不动会话状态） |
| `system/worker_shutting_down` | CLI 子进程将退出（`sdk.d.ts:5464`） | `session.lost{reason}`（随后 `session.recover`） |
| `query.close()`/`abortController.abort()` | 适配器主动 | `session.closed` 或 `turn.aborted`（看是关会话还是中断轮） |

### 3.4 关闭 / 删除 / 枚举

| ABI | 原生 | 注意 |
|---|---|---|
| `session.close`（M9） | `query.close()`（2950）：杀掉 CLI 子进程；**会话文件保留** | 返回 `{closed:true,alreadyClosed}`；不删 transcript |
| *（ABI v0 无删除方法，只有 `sessionDelete` 位）* | `deleteSession(sessionId)`（`sdk.d.ts:568`） | 真删产品侧记录；ABI 侧只走 M11 归档 + Broker tombstone，**不发明** `session.delete`（新增方法须 D4 走 MINOR） |
| `session.list`（M7） | `listSessions({dir?,limit?,offset?,includeWorktrees?,includeProgrammatic?})`（992）→ `SDKSessionInfo[]`（`sessionId,summary,lastModified,fileSize,customTitle,firstPrompt,gitBranch,cwd,tag,createdAt`） | 本机实测 3~5 行、含 `cwd`（附录 A-2） |
| `session.archive`（M11） | **无** → `sessionArchive=unavailable`，只归档 Broker 侧 | 不得伪造成"已归档" |
| 会话重命名 | `renameSession()`（2964）/ `tagSession()`（8521） | 非 ABI 必需；只作 label 同步 |

---

## 4. 续接与恢复

### 4.1 CLI `--resume` → SDK 的**完整映射**（本项目此前缺的就是这张表）

`Options` 是唯一入口；**禁止**手拼 CLI 参数（SDK 自己拼，见 §2.1 与附录 A-5）。映射逐条（`sdk.d.ts` 行号 + SDK 内部构造的 flag）：

| CLI flag | SDK `Options` 字段 | SDK 实际拼出的参数（`sdk.mjs:121`） | 约束 |
|---|---|---|---|
| `-r, --resume <id>`（`R:26`，帮助第 210 行） | `resume?: string`（`sdk.d.ts:1925`） | `--resume=<id>`（**等号形式**） | 需 `persistSession:true`；与 `continue` 互斥 |
| `-c, --continue`（`R:27`，第 67 行） | `continue?: boolean`（1459） | `--continue` | 与 `resume` 互斥（typings 原文） |
| `--fork-session`（`R:28`，第 104 行） | `forkSession?: boolean`（1574） | `--fork-session` | 必须与 `resume` 搭配才有意义 |
| `--session-id <uuid>`（`R:36`，第 224 行） | `sessionId?: string`（1931） | `--session-id=<uuid>` | 不能与 `resume`/`continue` 同用，除非同时 `forkSession`（typings 原文） |
| *（无 CLI 等价）* | `resumeSessionAt?: string`（1939） | `--resume-session-at=<uuid>` | **SDK 面独有**：从历史某条 chain UUID 处续接；CLI 帮助里没有对应 flag → 这是"选 SDK 而非裸 CLI"的直接理由之一 |
| *（无 CLI 等价）* | `resumeDropsTurn?: boolean` | `--resume-drops-turn=<v>` | 同上，实验面 |
| `--no-session-persistence`（`R:37`，第 143 行） | `persistSession: false`（1680） | `--no-session-persistence` | **绝对禁止**：一旦出现，`resume`/`fork`/`listSessions` 全部失效（`R:168`） |
| `--include-partial-messages`（`R:29`） | `includePartialMessages: true`（1725） | `--include-partial-messages` | 仅非交互面生效（SDK 即非交互） |
| `--forward-subagent-text`（`R:30`） | `forwardSubagentText: true`（1732） | `--forward-subagent-text` | 子代理文本/思考作为带 `parent_tool_use_id` 的消息出现 |
| `--permission-prompts <host\|none>`（`R:33`） | `permissionPrompts: 'host'\|'none'`（1859） | `--permission-prompts <x>` | 选 `'none'` 则 `canUseTool` **永不被调用**（`R:134`） |
| `--permission-mode <mode>`（`R:32`） | `permissionMode`（1833） | `--permission-mode <mode>` | CLI 接受 `manual` 而 SDK 类型是 `default`（`R:132`）→ **不能按名字透传** |
| `--agents <json>`（`R:25`） | `agents?: Record<string, AgentDefinition>`（1441） | 经 SDK 的初始化配置下发（`sdk.mjs` 中 `initConfig.agents`），**不是** CLI `--agents` flag | 见 §6 |
| `--mcp-config`/`--strict-mcp-config` | `mcpServers`（1802）/`strictMcpConfig`（2134） | `--mcp-config`/`--strict-mcp-config` | 白名单注入（§6） |
| `--fork-session` 之外的分叉 API | `forkSession(sessionId,{upToMessageId?,title?})`（738） | —（程序化） | 返回 `{sessionId}`；用于 `session.fork`，不必起 query |
| `--from-pr`（`R:31`） | **无映射** | — | 交互 picker / PR→sessionId 映射未导出（`R:136`）→ 不支持 |

### 4.2 `persistSession:false` 是续接死因（**最容易踩的坑 #2**）

- typings 原文（`sdk.d.ts:1680`）：*"When false, disables session persistence to disk. Sessions will not be saved to ~/.claude/projects/ and **cannot be resumed later**."* —— 默认值 `true`，但 DSH 现有插件**显式设 false**（`R:149`）。
- SDK 内部据此加 `--no-session-persistence`（附录 A-5），CLI 帮助也写明 *"sessions will not be saved to disk and cannot be resumed"*（`R:37`，第 143 行）。
- 结论：`persistSession` 不是性能开关，而是**续接能力的总闸**。适配器把它写死 `true`，并在能力声明里据此声明 `resumeSession=native`。
- 副作用：会话文件会落 `~/.claude/projects/`（含 prompt/产物摘要）→ 属敏感数据面，需在隐私/威胁模型（D7）里登记；**不要**用 `sessionStore`（`sdk.d.ts:1687`，alpha）替代本地落盘来"绕开"这一点。

### 4.3 fork / continue / sessionId 的组合语义

| 需求 | 组合 | 结果 |
|---|---|---|
| 续接原会话 | `resume: sid` | 复用原 `sessionId`，历史连续 |
| 续接但分叉 | `resume: sid` + `forkSession:true` | 新 `sessionId`，原会话仍可读（`R:56` 原文） |
| 从历史某点续接 | `resume: sid` + `resumeSessionAt:<uuid>` | 截断到该 chain entry（SDK 独有） |
| 指定新会话 id | `sessionId: uuid`（不带 resume/continue） | 用指定 id 建新会话 |
| 分叉已有会话（不起 query） | `forkSession(sid,{upToMessageId})`（738） | 直接返回新 `{sessionId}`，再 `resume` 它 |
| 最近会话 | `continue:true` | 与 `resume` 互斥；**不用于**多智能体编排（"最近"是不可控全局态） |

### 4.4 冷恢复阶梯（ABI M8，`auto`）

```text
1) 探测：getSessionInfo(sessionId)   → 会话文件在不在；getSessionMessages() 取尾部若干条
2) 重判轮：最后一条是否 result？无 result 说明崩溃时轮未终结 → 该轮 turn.failed{partial:true}
3) resume：query({prompt: seedOrNull, options:{...base, resume: sid}}) → 等 init → epoch+1
4) fork ：resume + forkSession:true（要求隔离/保留原会话时）
5) reseed：新 query + 交接摘要作首条 prompt（seedSummary）→ strategy:"reseed"
6) abort ：state=aborted + preservedThroughSeq（R-11）
```

| 观察 | 结论 | 动作 |
|---|---|---|
| `getSessionInfo` 返回 `undefined` | 会话文件不存在/未持久化 | 跳过 resume → reseed（R-1） |
| 尾部无 `result` | 崩溃时轮未终结 | `turn.failed{partial:true,error.code:"process.crashed"}` → resume 后开新轮（**不重放**） |
| 尾部 `result` 的 `is_error=true` | 上轮已失败 | 补 `turn.failed`，再 resume |
| resume 抛 `No conversation found` 类错误 | id/cwd 不匹配 | 降级 fork/reseed；记 `session.resume-failed` |
| 进程被 SIGKILL | 有会话文件即可接回 | `processKillInterrupt` 路径，`interruptMethod:"process-kill"` |

**风险 R-CC-1（未验证）**：resume 时 `cwd` 与创建时不同，是否仍能按 `sessionId` 加载（会话按 project slug 分目录，`R:15`）。C5 必须实测两种 cwd 下的 `resume`；若不行，适配器需持久化 `(sessionId, cwd, projectSlug)` 并在 resume 时强制同一 cwd。

### 4.5 幂等 / 去重（判定顺序：**先查产品侧，再决定重发/补读**）

**幂等键**：ABI `clientRequestId`。claude **没有产品侧幂等键**（`Options`/`SDKUserMessage` 里没有 idempotency 字段）。但有**强关联句柄**：`result.user_message_uuid(s)` 与 `assistant.user_message_uuid(s)`（`sdk.d.ts:5005+`/`3318+`）会把"这次输出对应哪条用户输入"回指出来 → 崩溃后可用 `getSessionMessages()` 的尾部对齐，判断"上次发送是否已进入产品历史"。

```text
① 查 Broker 幂等账本 (sessionId, method, clientRequestId)
   ├─ committed → 回放 result，deduplicated=true，不拉起 query
   ├─ started   → 进入 ② 对账
   └─ 无记录    → 进入 ② 对账
② 产品侧对账（零额度、只读）
   ├─ getSessionInfo(sid)         → 会话是否存在/最近修改时间
   ├─ getSessionMessages(sid)     → 尾部 user/assistant 轮次与 uuid（本机实测可读，附录 A-3）
   └─ 对比 intent 里记录的 promptDigest 与尾部 user 消息内容
③ 决策
   ├─ 已存在对应 user 消息且其后有 result → 视为已完成：补 result + deduplicated=true，不重发
   ├─ 已存在对应 user 消息但无 result     → 视为已接受未完成：发 turn.started，等待/恢复（不重发）
   ├─ 不存在                              → 允许重发（新 query / resume 后发）
   └─ 会话不存在                          → reseed 或 abort（§4.4）
④ 同键不同载荷 → session.conflict，不执行不覆盖
```

| 场景 | 处置 |
|---|---|
| 重复发同一 prompt（同 `clientRequestId`） | 仅 1 次产品调用（ABI-T4 的 claude 版断言） |
| 重复发同一 prompt（不同 `clientRequestId`） | **是两次请求**；产品无内容去重 → 两次真实计费，适配器不合并、只记录 |
| 轮中途崩溃后重发 | 先 ② 对账；有 user 消息无 result → 不重发，标 `process.crashed` 后 resume 开新轮；无痕迹 → 允许重发一次 |
| 映射表损坏（journal 校验失败） | 产品侧 `getSessionInfo` 可读 → 以产品侧存在性 + journal seq 重建映射（`replayedEvents=0` + `session.warning`）；不可读 → `session.mapping-corrupt` 隔离 |
| `conversation_reset`（`new_conversation_id`） | 产品侧换了会话 id（`sdk.d.ts:4485`）→ 适配器**必须**更新 `backendSessionId` 映射并发 `session.warning{code:"conversation-reset"}`；未更新即后续 resume 失败 |

### 4.6 最小可运行示例（Node / Agent SDK，≤40 行）

```js
// claude_min.mjs — 建会话 → 一轮 → 续接。Node ≥ 20，仅用已安装的 Agent SDK。
// 状态：本机已验证 = SDK 导入 / listSessions / getSessionInfo / getSessionMessages（零额度）；
//       未验证 = query() 的真实一轮与 resume（需可用凭据 + 消耗额度，留给 C5）。
import os from 'node:os';
const SDK = process.env.CLAUDE_SDK_PATH
  || `${os.homedir()}/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`;
const { query, getSessionInfo } = await import(SDK);
const base = {
  cwd: process.cwd(),
  // pathToClaudeCodeExecutable: 默认不传 → 走 SDK 平台包内置 CLI 2.1.263（§1.1）；外部线才传绝对路径
  persistSession: true,          // 关掉即失去 resume（sdk.d.ts:1680）
  includePartialMessages: true,  // token 级增量（sdk.d.ts:1725）
  permissionMode: 'dontAsk',     // 本文 read-only 档（§7.1）
  permissionPrompts: 'host',     // 保留审批桥（dontAsk 下多数请求先被静态规则裁决，sdk.d.ts:1859）
  // 禁止 allowedTools：裸名单会先于 canUseTool 自动放行（§7.2）
  canUseTool: async (tool, input, ctx) => (
    ['Read', 'Grep', 'Glob'].includes(tool)
      ? { behavior: 'allow', toolUseID: ctx.toolUseID }
      : { behavior: 'deny', message: 'unattended read-only', toolUseID: ctx.toolUseID }),
  maxTurns: 8,
};
let sid;
for await (const m of query({ prompt: '只回复 OK', options: base })) {
  if (m.type === 'system' && m.subtype === 'init') {
    sid = m.session_id;
    console.log('init', m.claude_code_version, 'hasAgentTool', m.tools.includes('Agent'));
  }
  if (m.type === 'stream_event') process.stdout.write('.');
  if (m.type === 'result') console.log('\nturn', m.subtype, 'cost', m.total_cost_usd, 'sid', m.session_id);
}
for await (const m of query({ prompt: '继续', options: { ...base, resume: sid } })) {
  if (m.type === 'result') console.log('resumed', m.subtype, 'same sid', m.session_id === sid);
}
const info = await getSessionInfo(sid);
console.log('persisted cwd', info?.cwd, '| summary', String(info?.summary).slice(0, 40));
```

---

## 5. 流事件映射

### 5.1 映射原则

1. `SDKMessage` 是**39 种**的判别联合（`sdk.d.ts:4681` 联合声明）→ 适配器用 `type`（+`subtype`）分派，**未识别类型必须忽略并计数**（产品原文：*"Consumers should ignore types and subtypes they do not recognize: the set grows over time."* `sdk.d.ts:4680` 注释）。
2. 只产出 ABI §7 事件名；原生名只出现在本表左列。
3. `messageId`：`assistant.uuid`（`SDKAssistantMessage.uuid`）或 `stream_event.event.message.id`，二者不保证相等 → **以 `assistant.uuid` 为准**，`stream_event` 的 delta 用 `event.message.id` 关联并暂存，收到 `assistant` 时统一回填为权威 `messageId`（否则 `message.delta` 与 `message.completed` 无法配对）。
4. `toolCallId`：`tool_use.id`（本机实测形如 `call_74d34eb…`，附录 A-3），与 `tool_result.tool_use_id` 对齐。
5. 终态恰一个（EV-4）；`result` 之后不再发该轮任何事件（适配器置轮关闭标记，丢弃迟到消息）。
6. 无法映射 → 丢弃 + 计数 + `session.warning{code:"adapter.event-dropped"}`（会话级 warning code，非 ABI 错误码），不伪造（ABI §7 前言）。

### 5.2 主映射表（`SDKMessage` → ABI）

| # | `type`/`subtype` | 关键字段（`sdk.d.ts`） | → ABI | ABI payload | 规则/备注 |
|---|---|---|---|---|---|
| 1 | `system/init`（5148） | `session_id`,`claude_code_version`,`cwd`,`model`,`permissionMode`,`tools[]`,`agents?`,`mcp_servers[]`,`apiKeySource` | `session.created`（首次）+ 版本/能力断言 | `state:"running"`,`cwd` | 后续 query（resume）的 init 只做断言 → `diagnostic.log`；`agents?` 或 `tools` 含 `Agent` → `nativeSubagents` |
| 2 | `stream_event` `message_start`（4826） | `event.message{id,model,role}` | `message.started` | `channel:"assistant"`,`messageId:event.message.id` | 见 §5.6（schema 未覆盖） |
| 3 | `stream_event` `content_block_start{type:"tool_use"}` | `id`,`name`,`input` | `tool.started` | `toolCallId:id`,`name`,`kind`（按 name 分类） | `input` 尚未完整 → 不填 |
| 4 | `stream_event` `content_block_delta{text_delta}` | `delta.text` | `message.delta` | `channel:"assistant"`,`text`,`granularity:"token"`,`messageId` | token 级（`includePartialMessages=true` 才有） |
| 5 | `stream_event` `content_block_delta{thinking_delta}` | `delta.thinking` | `reasoning.delta` | `text`,`granularity:"token"` | 默认不进父会话 |
| 6 | `stream_event` `content_block_delta{input_json_delta}` | `delta.partial_json` | `tool.progress` | `toolCallId`,`text`（参数片段） | 高频；折叠优先级最低 |
| 7 | `stream_event` `content_block_stop`/`message_stop` | — | **丢弃** | — | 无信息量（结尾由 `assistant`/`result` 覆盖） |
| 8 | `stream_event` `message_delta` | `event.usage`,`event.delta.stop_reason` | `usage.updated` | `usage{outputTokens,…}`,`estimated:false`,`scope:"turn"` | token 级用量；终态用量以 `result` 为准（可能覆盖） |
| 9 | `assistant`（3318） | `message.content[]`（`text`/`thinking`/`tool_use`）、`message.stop_reason`、`parent_tool_use_id`、`error?`、`uuid`、`session_id` | `message.completed` + 逐 `tool_use` 补 `tool.started` + `reasoning.summary` | `channel:"assistant"`,`text`（拼接 text blocks）,`messageId:uuid` | **权威文本**；`parent_tool_use_id!=null` → 事件路由到**子会话**（§6.2）；`error?` → §10.1 分类 |
| 10 | `user` + `content[].type="tool_result"`（5365） | `tool_use_id`,`content`,`is_error` | `tool.completed`（`status:ok|error`） | `toolCallId:tool_use_id`,`status`,`outputDigest` | `is_error=true` → `status:"error"`（工具跑完但失败）；内容超大 → artifact |
| 11 | `user`（无 tool_result；含 `tool_use_result`/`priority`） | `message.content`,`priority` | **丢弃**（回显）或 `turn.steered` | — | 我们自己推的输入回显 → 丢弃；若是运行中插入（含 `priority:"now"`）→ 发 `turn.steered{steerSeq}` |
| 12 | `user_message_replay`（5416） | 历史 user 消息重放 | **丢弃** | — | 恢复时 SDK 回放历史，不是新事件 |
| 13 | `result` `subtype:"success"`（5005） | `result`,`stop_reason`,`usage`,`total_cost_usd`,`duration_ms`,`num_turns`,`permission_denials[]`,`structured_output?`,`session_id` | `turn.completed` + `usage.updated` | `stopReason`（§5.3）,`usage{estimated:false,scope:"turn",costUsd,durationMs}` | `is_error` 仍可能为 true（看 subtype）；`permission_denials` → 逐条 `permission.resolved{deny}` |
| 14 | `result` `subtype:"error_*"`（4957） | `errors[]`,`usage`,`total_cost_usd`,`stop_reason` | `turn.failed` + `usage.updated` | `error`（§10.1）,`partial` | 四种 subtype 见 §10.1 |
| 15 | `system/task_started`（5261） | `task_id`,`tool_use_id?`,`description`,`subagent_type?`,`spawn_depth?`,`is_backgrounded?`,`prompt?` | `child.spawned` | `childSessionId`,`nativeAgentId:task_id`,`name:description`,`depth:spawn_depth` | **`spawn_depth` 是一等字段**（`R:116`）；缺省按父+1 |
| 16 | `system/task_updated`（5297） | `task_id`,`patch{status,error?,end_time?}` | `child.state-changed` | `childSessionId`,`previousState`,`state` | `pending→created`、`running→running`、`completed→completed`、`failed→failed`、`killed→aborted`、`paused→blocked` |
| 17 | `system/task_progress`（5236） | `task_id`,`description`,`subagent_type?`,`usage{total_tokens,tool_uses,duration_ms}`,`last_tool_name?` | `usage.updated`（**子会话**）+ 其余丢弃 | `usage{estimated:true,scope:"session"}`,`estimated:true` | ABI 无"子会话进度"事件；`description` 只进 `diagnostic.log`（避免伪造 `child.state-changed`） |
| 18 | `system/task_notification`（5210） | `task_id`,`status:completed|failed|stopped`,`summary`,`usage?`,`output_file` | `child.completed` | `childSessionId`,`status`,`summary` | `stopped→aborted`；`output_file` 进 artifact 引用 |
| 19 | `system/permission_denied`（4855） | `tool_name`,`tool_use_id`,`agent_id?`,`decision_reason_type?`,`decision_reason?`,`message` | `permission.resolved`（+ `tool.completed{status:"denied"}` 若已 `tool.started`） | `requestId:tool_use_id`,`decision:"deny"`,`by:"policy"`,`reason` | 子代理内（`agent_id`）路由到子会话 |
| 20 | `system/status`（5133） | `status:"compacting"|"requesting"|null`,`permissionMode?`,`compact_result?` | `session.warning{code:"context-compacting"}` / `session.state-changed{awaiting-input}` | — | `permissionMode?` 变化 → 更新本地档位快照 |
| 21 | `system/compact_boundary`（3430） | `compact_metadata{trigger,pre_tokens,post_tokens?,duration_ms?}` | `session.warning{code:"context-compacted",degrade:true}` | `message` 含 pre/post tokens | 上下文已压缩 → 父级需知道"历史不连续" |
| 22 | `system/api_retry`（3296） | `attempt`,`max_retries`,`retry_delay_ms`,`error`,`error_status` | `session.warning{code:"api-retry"}`；`error∈{rate_limit,overloaded}` 时同时按 `quota.rate-limited` 计 | `retryAfterMs:retry_delay_ms` | 不得把每次重试变成一条父会话事件（折叠） |
| 23 | `rate_limit_event`（4924） | `rate_limit_info{status,resetsAt,rateLimitType,overageStatus,overageDisabledReason}` | `session.warning` + 配额判定 | `code:"rate-limited"` / `quota.usage-exhausted` | `rejected`+`out_of_credits` → `quota.usage-exhausted`；`allowed_warning` → warning |
| 24 | `system/thinking_tokens`（5319） | `estimated_tokens`,`estimated_tokens_delta` | `usage.updated` | `usage{reasoningTokens:estimated_tokens}`,`estimated:true`,`scope:"turn"` | 估计值必须 `estimated:true` |
| 25 | `tool_progress`（5332） | `tool_use_id`,`tool_name`,`elapsed_time_seconds`,`parent_tool_use_id`,`task_id?`,`heartbeat?` | `tool.progress` | `toolCallId`,`text?` | `heartbeat=true` → 丢弃（无信息量）；子代理（`parent_tool_use_id`）路由子会话 |
| 26 | `system/session_state_changed`（5105） | `state:idle|running|requires_action` | `session.state-changed` | `previousState`,`state`,`reason` | `requires_action`→`awaiting-input` |
| 27 | `system/worker_shutting_down`（5464） | `reason` | `session.lost` | `reason`,`lastKnownSeq` | 随后 `session.recover` |
| 28 | `system/model_refusal_fallback`（4758） | `trigger`,`direction`,`original_model`,`fallback_model`,`api_refusal_category?` | `session.warning{code:"model-refusal-fallback"}` | `message` 含 from→to | 模型被换 → 父级必须可见 |
| 29 | `system/model_refusal_no_fallback`（4795） | `original_model`,`api_refusal_*` | `turn.failed{error:policy.permission-denied}` + warning | `details.code="model-refusal"` | 拒答即本轮失败（不重试） |
| 30 | `system/informational`（4591） | `content`,`level:info|notice|suggestion|warning`,`tool_use_id?`,`prevent_continuation?` | `warning` 级 → `session.warning`；其余丢弃 | `code:"informational"` | `prevent_continuation?` 视作轮失败信号（与 result 一起判定） |
| 31 | `system/compact_boundary` 之外的 `hook_started`/`hook_progress`/`hook_response`（4578/4563） | `hook_id`,`hook_name`,`hook_event`,`stdout/stderr` | **丢弃**（`hook_*` 级） | — | 观测点应由适配器自己的 hooks 输出 `diagnostic.log`，不透传 |
| 32 | `system/plugin_install`（3445+） | `status`,`name`,`error?` | **丢弃**（`diagnostic.log`） | — | 扩展安装态与 ABI 无关 |
| 33 | `auth_status`（~3480） | `isAuthenticating`,`output[]`,`error?` | `session.warning`（`isAuthenticating=false` 且 `error` 时 → `auth.*`） | — | 不打印 `output[]` 原文（可能含账户信息） |
| 34 | `system/task_*` 之外的 `background_tasks_changed`（3398） | `tasks[]{task_id,task_type,description}` | `child.state-changed`（仅新增/消失的 task） 或丢弃 | — | 与 `task_started` 去重：同一 `task_id` 只发一次 `child.spawned` |
| 35 | `system/files_persisted`（4510） | `files[]{filename,file_id}`,`failed[]` | `diagnostic.log` + 若 `failed` 非空 → `session.warning{code:"artifact-persist-failed"}` | — | 产物落盘失败必须可见 |
| 36 | `conversation_reset`（4485） | `new_conversation_id` | `session.warning{code:"conversation-reset"}` + **更新 `backendSessionId` 映射** | — | §4.5 的映射损坏来源之一 |
| 37 | `tool_use_summary`（5353）/`prompt_suggestion`（4914）/`local_command_output`/`notification`/`commands_changed`/`memory_recall`/`mirror_error`/`files_persisted` 之外展示类 | — | **丢弃**（`diagnostic.log` debug） | — | 纯 UI 面 |
| 38 | `control_request_progress`（4363） | `request_id`,`status:started|api_retry`,`attempt?` | 丢弃（或与 #22 合并） | — | 控制面进度，不重复发 warning |
| 39 | `elicitation_complete`（4501） | `mcp_server_name`,`elicitation_id` | `input.resolved{decision}` 配对 | — | 与 `onElicitation` 的应答配对（§7.2） |

### 5.3 `stop_reason` / 用量映射

| `result.stop_reason`（或 `message.stop_reason`） | ABI `turn.completed.stopReason` | 备注 |
|---|---|---|
| `end_turn` / `null` | `end-turn` | 正常 |
| `max_tokens` | `other` + `session.warning{code:"max-output-tokens"}` | 输出被截断，非上下文超限 |
| `stop_sequence` | `stop-sequence` | |
| `tool_use` | `end-turn` + `session.warning{code:"unfinished-tool-use"}` | 正常 `result` 不应出现；出现即异常 |
| `refusal` | `other` + `session.warning{code:"model-refusal"}` | 安全拒答；配合 #28/#29 |
| `error_max_turns`（subtype） | `turn.completed{stopReason:"max-turns"}` + `session.warning` | **决策**：ABI 把 `max-turns` 列为"完成"态（§7.2）；`is_error` 仍按产品语义标注在 `details`，不升级为 `turn.failed` |

用量字段：`result.usage`（`NonNullableUsage`）+ `total_cost_usd`（4968）+ `modelUsage{model→…}`（4976）+ `duration_ms` → `usage.updated{usage:{inputTokens,outputTokens,reasoningTokens?,costUsd,durationMs},estimated:false,scope:"turn"}`；`modelUsage` 多模型时按模型拆多条（同一 `seq` 不允许 → 用多个事件，`scope:"turn"`）。

### 5.4 无对应 → 丢弃 + 理由（逐类）

| # | 原生类 | 理由 | 计数 |
|---|---|---|---|
| D1 | `user` 回显 / `user_message_replay` | 输入回显不是新信息；重放是恢复产物 | `drop:echo` |
| D2 | `stream_event` `content_block_stop`/`message_stop`/`ping` | 边界/保活，无 ABI 语义 | `drop:stream-boundary` |
| D3 | `hook_started`/`hook_progress`/`hook_response` | 产品内观测面；适配器自己的 hooks 才写 `diagnostic.log` | `drop:hook` |
| D4 | `plugin_install`/`commands_changed`/`slash_commands` | 扩展/命令面，无 ABI 事件 | `drop:extension` |
| D5 | `prompt_suggestion`/`tool_use_summary`/`local_command_output`/`notification`/`memory_recall`/`mirror_error` | 展示层/提示层；`mirror_error` 另走 `diagnostic.log{warn}` | `drop:display` |
| D6 | `thinking_tokens` 的 `estimated_tokens_delta` | 增量无独立 ABI 事件；用绝对值发 `usage.updated` | `drop:usage-delta` |
| D7 | `task_progress.description/last_tool_name` | ABI 无子会话进度事件；只取 `usage`（#17） | `drop:task-progress-text` |
| D8 | `control_request_progress` | 控制面重试与 #22 重复 | `drop:control-progress` |
| D9 | `files_persisted.files[]`（成功项） | 成功落盘不产生 ABI 事件（失败才 warning） | `drop:files-persist` |

> 丢弃率指标见 §11.3；单轮丢弃 > 50% 说明映射覆盖不足。

### 5.5 顺序与去重

- `result` 后该轮关闭：迟到 `stream_event`/`assistant` 丢弃（中断/超时竞态常见）。
- `assistant` 与 `stream_event` 内容重叠 → **`assistant` 为准**（`message.completed` 权威，delta 可丢，ABI §7.3）。
- 同一 `tool_use.id` 可能从 `stream_event.content_block_start` 与 `assistant.message.content[]` 两处到达 → `tool.started` 只发一次（按 toolCallId 去重）。
- `permission_denied` 与 `result.permission_denials` 可能重复 → 按 `tool_use_id` 去重。

### 5.6 与 `docs/abi/schema/event.json` 的覆盖差异（跨文档缺口，需 D4 确认）

`event.json` 共 35 个变体（15 完整信封 + 20 内联 payload_*，见 ABI §7 与 D10 复核）；本表用到的 `session.warning`、`session.closed`、`message.started`、`reasoning.delta`、`reasoning.summary`、`tool.progress`、`tool.failed`、`usage.updated`、`child.*`、`turn.steered`、`input.resolved`、`transport.state-changed`、`diagnostic.log` 在 ABI §7 有定义且 event.json 已覆盖（D10 复核后已不再是缺口）；如施工期发现 schema 与 ABI §7 不一致，以 `abi-v0.md` §7 为准，schema 补齐归属施工 C1，**不得**改名迁就 schema。

---

## 6. 原生子代理与嵌套

### 6.1 产品能力与**实验面标注**

| 证据 | 内容 | `[实测]` |
|---|---|---|
| 二进制工具别名表 | `Task→Agent`、`ListPeers→ListAgents`、`Brief→SendUserMessage`；计数 `ListAgents` 7、`SendMessage` 63、`TaskStop` 31、`Workflow` 241 | `R:95-99` |
| `sdk-tools.d.ts` | `AgentInput`（`:12`）：`description`,`prompt`,`subagent_type?`,`model?`(`sonnet|opus|haiku|fable`),`run_in_background?`,`name?`,`isolation?:'worktree'|'remote'`；`TaskStopInput`(`:21`)、`TaskOutputInput`(`:14`)、`WorkflowInput`(`:42`) | `R:108-109` |
| 运行时工具清单 | `init.tools[]` 含 `Agent`/`Task` | `R:86` |
| 落盘形状 | `~/.claude/projects/<slug>/<sid>/subagents/agent-<id>.meta.json`：`agentType`,`description`,`spawnDepth`,`toolUseId`（本机样本 `spawnDepth=1`） | `R:114-116` |

> **实验面声明（强制）**：`SendMessage` / `ListAgents` **没有公开 typing**（不在 `ToolInputSchemas` 联合里，`R:110`）→ 标注 `@experimental`：只允许用于**观测与透传**（解析 `tool_use` 入参、记录地址名），**不得**作为控制面依赖（不能保证跨版本稳定）。判据用运行时 `init.tools[]` 探测，缺则降级 `nativeSubagents=unavailable`。入参 schema 属 U4，C5 补。

### 6.2 事件映射（子代理）

| 原生信号 | → ABI | payload | 说明 |
|---|---|---|---|
| `system/task_started`（`spawn_depth`） | `child.spawned` | `childSessionId`,`nativeAgentId:task_id`,`name:description`,`depth:spawn_depth` | 子会话必须有独立 ABI 记录（`parentSessionId`/`rootSessionId`） |
| `system/task_updated` | `child.state-changed` | `childSessionId`,`previousState`,`state` | 状态枚举见 §5.2 #16 |
| `system/task_notification` | `child.completed` | `status`,`summary` | 终态唯一信号 |
| `assistant`/`user` 带 `parent_tool_use_id`（且 `forwardSubagentText:true`） | 子会话的 `message.*`/`tool.*`/`reasoning.*` | 同父会话规则，但 `sessionId` 为子会话 | **归属判据 = `parent_tool_use_id` 非空**（`R:171`：默认只有 tool_use/tool_result，开 `forwardSubagentText` 才有文本） |
| `tool_progress` 带 `parent_tool_use_id` | 子会话 `tool.progress` | 同上 | |
| `permission_denied` 带 `agent_id` | 子会话 `permission.resolved` | 同上 | |
| `background_tasks_changed` | `child.spawned`/`child.completed`（按 task 集差分） | — | 与 `task_started` 去重（同 `task_id`） |

### 6.3 兼容层职责边界（**关键限制**）

- **宿主不能直接调用 `Agent`/`SendMessage`/`ListAgents`**：它们是**模型工具**，只能由模型在对话中调用；SDK 没有"host 调用工具"的 API。→ `nativeSubagents=native` 的含义是"**可观测 + 可供给定义**"，不是"适配器能派子代理"。派发必须通过 prompt 指令或 `agents` 定义 + 模型决策。
- 宿主能做的三件事：①`Options.agents` 定义角色（`AgentDefinition`，`sdk.d.ts:38`/1441，`model:'inherit'` 继承主模型）；②`Query.stopTask(taskId)`（2926）停子代理、`backgroundTasks()`（2941）查后台任务；③通过 `streamInput` 发消息（模型可能据此用 SendMessage 给具名子代理）。
- 深度：`spawn_depth` 是一等字段（`R:116`）→ `child.spawned.depth` 直接取它；`maxNestingDepth=2` 只对"ABI 请求的深度"生效，**产品自主加深**只能观测：`depth > 限制` 时发 `session.warning{code:"nesting-depth-exceeded"}` + `limit.nesting-exceeded` 仅用于拒绝**我们**发起的嵌套请求。
- `listSubagents()` **不可靠**：它依赖 `agent-<agentId>.jsonl`，而本机只有 `.meta.json` → 返回 `[]`（`R:133`，`[实测-本轮]` 确认 `[]`）。**禁止**用它判断"有没有子代理"；判据是 `subagents/` 目录扫描 + `init.tools` 含 `Agent`。
- `Workflow` 工具（`WorkflowInput` 含 `script/scriptPath/runId`）属实验编排面（`R:109`）→ 只透传 `tool_use`，不建模为 ABI 概念。

---

## 7. 权限与沙箱

### 7.1 六档 → ABI 三档（**命名坑**：CLI `manual` ≠ SDK `default`）

`PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（`sdk.d.ts:2317` 注释给出语义）。CLI `--permission-mode` 的 choices 是 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`（`R:32`）→ **CLI 的 `manual` 在 SDK 里叫 `default`**，直接透传会报错（`R:132`）。

| ABI `permissionProfile` | SDK 组合 | 语义 | 产品侧依据 |
|---|---|---|---|
| `read-only`（默认） | `permissionMode:'dontAsk'` + `disallowedTools:[Write,Edit,NotebookEdit,Bash,BashOutput,WebFetch,WebSearch,…]` + `canUseTool` 只读白名单（`Read/Grep/Glob/LS/NotebookRead/TodoWrite` → allow，其余 deny） | **允许读、拒绝写/执行/网络**，无需审批 | `dontAsk`=*"Don't prompt for permissions, deny if not pre-approved"*（2317）；**预批准改由 `canUseTool` 给出，不用 `allowedTools`**（§7.2） |
| `safe-auto` | `permissionMode:'acceptEdits'` + `permissionPrompts:'host'` + `canUseTool` 策略（放行 workspace 内读/写、拒绝执行/网络/越界） | 不弹人工，全部由策略代答 | `acceptEdits` 自动接受编辑；执行/网络类由 `canUseTool` 拒（§7.2） |
| `yolo` | `permissionMode:'bypassPermissions'` + `allowDangerouslySkipPermissions:true`（1845）+ **必须**外层 worktree | 全放行 | 缺 worktree → `policy.sandbox-violation`（ABI SEC-4） |

- **不要**把 `read-only` 映射成 `plan`：`plan`=*"Planning mode, **no actual tool execution**"*（2317）——连 `Read` 都不执行，无法做代码审查。`plan` 只作产品侧的"仅出计划"模式，不在 ABI 三档内。
- `auto`（模型分类器）**不作无人值守默认**：可控性未验证（U11，`R:211`）；`acceptEdits` 只用于 `safe-auto`（写由策略放行），不作为 `read-only` 的预批准手段。
- 需要执行**只读命令**（如 `git status`）时不能用 `read-only`（`Bash` 已禁）→ 用 `safe-auto` + 命令白名单（策略层）。
- 静态黑名单只用 `disallowedTools`：它把工具从模型上下文中移除（`sdk.d.ts:1469`），是 `canUseTool` 之外仍生效的**硬闸**。**禁止** `allowedTools`（见 §7.2 的 shadowing 实测）。

### 7.2 权限桥（`canUseTool` / `permissionPrompts`）——含**挂起防护**

| 事实 | 证据 |
|---|---|
| `canUseTool` 每次工具执行前调用，返回 allow/deny | `sdk.d.ts:1454`、`CanUseTool`（209） |
| `PermissionResult`：allow 可带 `updatedInput`/`updatedPermissions`；deny 可带 `message`/`interrupt` | `sdk.d.ts:2339-2353` |
| 回调可拿到 `toolUseID`、`agentID?`、`blockedPath?`、`decisionReason?`、`title/displayName/description`、`suggestions?` | `sdk.d.ts:209-250` |
| **fail-closed + 无 park 期限**：故意返回 `null` 且不自己发 control_response → 工具**无限期阻塞**（*"permission prompts have no park deadline"*） | `sdk.d.ts:205-208` |
| `permissionPrompts:'none'` → **`canUseTool` 永不被调用**，需审批的一律立即拒绝 | `sdk.d.ts:1859`、`R:134` |
| `canUseTool` 与 `permissionPromptToolName` 互斥（SDK 内部抛错） | `sdk.mjs:121`（error 串） |

**强制实现规则**：

1. **所有档位都必须** `permissionPrompts:'host'` 并注册 `canUseTool`（否则没有桥：`read-only`/`safe-auto` 只剩全拒或静态黑名单，且无法产出 `permission.*` 观测事件）。权限决策**全部收敛到 `canUseTool`**，不再用 `allowedTools` 做预批准。
2. `canUseTool` 内**同步决策**（查策略表），2 s 内必须 resolve；任何异常/超时 → 返回 `{behavior:"deny", message:"policy timeout"}`（fail-closed）。**绝不允许**返回 `null` 或挂起（ABI §4 要求 1、ABI-T8 ≤2 s）。
3. 每次调用产一对事件：`permission.requested{requestId:toolUseID, tool, risk, options, summary}` → `permission.resolved{requestId, decision, by:"policy"}`；`risk` 由工具名分类（`Read/Grep/Glob→read`，`Write/Edit/NotebookEdit→write`，`Bash→execute`，`WebFetch/WebSearch→network`，其余 `unknown`）。
4. `updatedPermissions` 只用于 `allow-always`（ABI `decision:"allow-always"`），且只在 `safe-auto` 下允许；`read-only` 一律 `deny`。
5. `onElicitation`（MCP 表单）→ 返回 `decline`（等价插件现状，`R:157`）；若 SDK 要求应答，配对发 `input.resolved{decision:"declined"}`。
6. `onUserDialog` → `cancelled`；`supportedDialogKinds:["refusal_fallback_prompt"]`（`R:158-159`）——这两个回调**必须注册**，否则交互型提示可能挂起（无人值守硬约束）。
7. **禁止配置裸 `allowedTools`**（C5 实测，D5a-4）：SDK 对裸名单会**先于回调自动放行**，并打出
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告（*"Bare allowedTools entries auto-approve the whole tool before the callback is consulted"*）——
   等于绕过 2 s fail-closed 代答。需要"放行某工具"时只能由 `canUseTool` 返回 allow；要缩小工具面用 `disallowedTools` / `--tools`。

### 7.3 沙箱

> **C5 实测口径（D5a-3）**：`Options.sandbox` / `Settings.sandbox` 是 SDK/CLI 的**配置面**，**不是 OS 级强制层**；
> 适配器实测能力声明为 `sandboxModes:"emulated"`（§2.4），**不宣称**已完成沙箱隔离。默认实现只用
> ① 权限规则（`Read`/`Edit`/`WebFetch` 等的 deny/allow）② `cwd` + allowedRoots 校验；`--restricted` 只能裁剪工具面。
> 残余风险：`safe-auto` 的写工具在 allowedRoots 之外的绝对路径上仍可能落地（只靠权限规则拦），`yolo` 必须外层 worktree。

- `Options.sandbox?: SandboxSettings`（`sdk.d.ts:2032`，字段表 `3176-3200`）：`enabled`、`failIfUnavailable`、`autoAllowBashIfSandboxed`、`allowUnsandboxedCommands`、`network{allowedDomains,deniedDomains,strictAllowlist,allowUnixSockets,allowLocalBinding,…}`、`filesystem{allowWrite,…}`、`ignoreViolations`、`disabled`。
- **职责分层（官方注释 `sdk.d.ts:1994-2000`，容易误用）**：*"Filesystem and network restrictions are configured via **permission rules**, not via these sandbox settings"* → 目录/域限制以 `Read`/`Edit`/`WebFetch` 权限规则为主；`sandbox` 负责**执行隔离层**（命令是否在沙箱进程里跑、网络代理、Unix socket 白名单）。若启用 sandbox，两者都要配；默认实现不启用 sandbox（§7.3 开头口径），只配权限规则 + cwd 校验。
- **`failIfUnavailable` 默认 `true`**（`sdk.d.ts:2006-2009`）：若启用 `sandbox.enabled:true` 且沙箱依赖缺失，`query()` **报错退出**而不是无沙箱静默跑；启用时**不得**设为 `false`（默认实现不启用 sandbox，故此项当前不生效）。
- 与工具级收窄并用：`--restricted`（`R:38`，第 195 行）去掉执行类工具；`--tools`（`R:39`，第 255 行）给白名单。
- **CLI 面无沙箱 flag**（`R:195` 矩阵行 `sandbox`=🟡）→ 只能走 SDK `options.sandbox`/`settings`；C5 实测未获得 OS 级强制证据 → 能力位按 `emulated` 声明（§2.4）。
- `yolo` 档要求外部 worktree：SDK 无会话级 worktree 选项（CLI `-w` 是 CLI 面，`R:135`；`AgentInput.isolation` 只作用于子代理）→ `worktreeIsolation=emulated`，由外层建 worktree 后传 `cwd`。

### 7.4 cwd/路径校验

与 codex 同样**不能指望后端**：适配器在 `query()` 前校验 `cwd` 是绝对路径、存在、realpath 落在允许根内；`read-only`/`safe-auto` 的**权限规则**至少拒绝仓库外路径与 `~` 的写；沙箱不提供 OS 级强制（§7.3），因此不把 `sandbox.enabled` 当作边界；`yolo` 要求独立 worktree，否则 `policy.sandbox-violation`（ABI SEC-2/SEC-4）。

---

## 8. 认证与模型路由

### 8.1 认证

| 项 | 事实 | 证据 |
|---|---|---|
| 凭据来源枚举 | `apiKeySource`：`ANTHROPIC_API_KEY`/`apiKeyHelper`/`/login managed key`/`none`/`user`/`project`/`org`/`temporary`/`oauth` | `sdk.d.ts:127` |
| 未认证 | `apiKeySource==='none'` → `auth.missing-credential`（fail fast，无人值守不尝试交互登录） | `[推断]`，C5 补 |
| 认证失败 | `SDKAssistantMessageError.authentication_failed` / `oauth_org_not_allowed` → `auth.credential-rejected` | `sdk.d.ts:3384` |
| 账户态 | `account_on_hold`/`billing_error` → `quota.usage-exhausted` | 同上 |
| 交互登录 | `claude auth` 子命令（`R:43`）→ 不调用；只提示用户先登录 | 需求基线 硬约束 2 |
| 凭据保护 | 适配器**不读** `~/.claude` 凭据文件、不打印 env；`diagnostic.log` 命中凭据模式即脱敏（ABI SEC-1） | 纪律同 `R:5` |

### 8.2 模型路由

| ABI | 原生 | 粒度/备注 |
|---|---|---|
| `session.create.model` | `Options.model`（1807） | 会话默认 |
| `session.setModel`（M15） | `Query.setModel(model?)`（2649） | **运行中**切换（下一请求生效） |
| 推理档 | `setMaxThinkingTokens()`（2672） | 与 `effort` 概念不完全对应 → `session.setModel` 的 `reasoningEffort` 映射为 thinking 预算或拒绝（记 warning） |
| 失败回退 | `Options.fallbackModel`（1549，不能与主模型相同，SDK 内部校验） | 产品级回退；发生时 `session.warning` |
| 子代理模型 | `AgentDefinition.model`，`'inherit'` 继承主模型（`R:83`） | 由 `Options.agents` 定义 |
| 不可用模型 | `model_not_found` → `auth.provider-mismatch`（fail fast，不重试） | §10.1 |
| 多模型用量 | `result.modelUsage{model→ModelUsage}`（4976） | 按模型拆 `usage.updated` |
| 被拒答/被换模型 | `model_refusal_fallback`/`model_refusal_no_fallback` | §5.2 #28/#29 |

---

## 9. 限流与并发

### 9.1 并发模型

| 层 | 上限 | 来源 | 强制者 |
|---|---|---|---|
| 单会话 | 1 个进行中轮 | `query()` 串行；`streamInput` 只是输入队列 | 适配器 turnLock |
| 单进程 | 1 个 SDK 查询 = 1 个 CLI 子进程（274 MB bun 二进制） | `R:11` | 资源上限：默认 `maxSessionsPerBackend=8`、全局活跃查询 4 |
| 子代理 | `AgentInput.run_in_background` + `stopTask` | `sdk-tools.d.ts:12`、`sdk.d.ts:2926` | 产品；适配器只观测 |
| 嵌套深度 | `spawn_depth`（观测） | `R:116` | 产品；ABI 侧限制只约束我们的请求 |
| 轮时长 | 1800 s | `limits.maxTurnMs` | 适配器计时 → `interrupt()` → `close()` |
| 轮次/预算 | `maxTurns`（1772）、`maxBudgetUsd`（1777） | 产品侧硬门禁 | 适配器在 Options 里设，超限 → `limit.turn-timeout`/`limit.budget-exceeded` |

`concurrencyControl=unavailable`（ABI §3.2 语义要求"后端声明并强制"上限；claude **未发现**全局并发上限配置键，`R:197`、`M:101` U6）→ 走 ABI R-13：Broker 全局信号量（默认 4）+ 每后端队列，可能超卖后端口径，429 按 `quota.rate-limited` 处理。

### 9.2 排队与转向

- 排队：Broker 侧 `activation=queued`；会话内并发 `session.send` → `session.locked{retryAfterMs}`。
- `steerTurn=native`：模式 A 下 `streamInput()` 推 `SDKUserMessage{priority:'now'}`（`priority` 字段见 `sdk.d.ts:5365`，实际语义 `[未验证]` → C5）；产品接受即 `turn.steered`。模式 B（一轮一 query）下无法转向 → `session.locked`（R-15 降级）。**同一位在两个实现模式下的取值不同**，能力声明必须按实际启用的模式写（默认模式 A → native）。
- `inputInbox=emulated`：产品无"可列/可取消队列"API（`queued_turn_count` 只在 result 里出现，`sdk.d.ts:5005+`）→ 适配器自建内存队列，`turn.queued` 的 `queuePosition` 由适配器给。

### 9.3 限流与配额

| 信号 | 映射 | 处置 |
|---|---|---|
| `rate_limit_event.status="rejected"` + `overageDisabledReason="out_of_credits"` | `quota.usage-exhausted`（retryable=no） | `blocked`，停止派发 |
| `rate_limit_event.status="rejected"`（其他） | `quota.rate-limited`（backoff，`retryAfterMs=resetsAt-now`） | 暂停该会话 |
| `allowed_warning` | `session.warning{code:"rate-limit-warning"}` + `utilization` 快照 | 不阻断 |
| `api_retry{error=rate_limit/overloaded}` | `quota.rate-limited`（`retryAfterMs=retry_delay_ms`） | 尊重退避 |
| `result.error_max_budget_usd` | `limit.budget-exceeded` | 中断并保留结果 |
| `result.usage` 周期采样 | `usage.updated{scope:"turn"}` + 汇总 `scope:"session"` | 预算硬控用 `maxBudgetUsd` + Broker 侧 token 计 |

---

## 10. 失败与降级

### 10.1 错误映射

**A. `result` 的 `subtype`（`SDKResultError`，`sdk.d.ts:4957`）**

| subtype | ABI | 理由 |
|---|---|---|
| `error_during_execution` | `turn.failed{backend.internal-error}`，若同轮有 `assistant.error` 则按 B 表优先映射 | `errors[]` 原文进 `details`（脱敏） |
| `error_max_turns` | `turn.completed{stopReason:"max-turns"}` + `session.warning` | ABI 把 max-turns 列为完成态（§7.2）；决策见 §5.3 |
| `error_max_budget_usd` | `turn.failed{limit.budget-exceeded}` | 预算耗尽 |
| `error_max_structured_output_retries` | `turn.failed{protocol.invalid-params}` | 本项目不用 structured output（`outputSchema` 属 DSK seam 关闭项，seam 事实基线（`docs/integration/00-dsh-integration.md` §1））→ 仅兜底 |

**B. `assistant.error`（`SDKAssistantMessageError`，`sdk.d.ts:3384`，11 值）**

| 值 | ABI |
|---|---|
| `authentication_failed` / `oauth_org_not_allowed` | `auth.credential-rejected` |
| `account_on_hold` / `billing_error` | `quota.usage-exhausted` |
| `rate_limit` / `overloaded` | `quota.rate-limited`（backoff） |
| `invalid_request` | `protocol.invalid-params`（适配器构造错误） |
| `model_not_found` | `auth.provider-mismatch` |
| `server_error` / `unknown` | `backend.internal-error` + `details.assistantError`（D10 已补齐该码，见 G7） |
| `max_output_tokens` | `turn.completed{stopReason:"other"}` + `session.warning{code:"max-output-tokens"}` |

**C. 进程/传输层**

| 观察 | ABI |
|---|---|
| CLI 不可执行 / spawn ENOENT | `process.spawn-failed`（退避 ≤2） |
| 首轮 `send` 内 30 s 未见首条 `init`（stream 模式 init 此时才发） | `transport.timeout`（关查询，fail-closed） |
| `init.claude_code_version` 不符 | `protocol.version-mismatch` |
| 子进程非零退出且无 `result` | `process.crashed` → `session.lost` → 恢复 |
| `worker_shutting_down` | `session.lost{reason}` → 恢复 |
| 查询被 `abortController` 取消 | `turn.aborted{interruptMethod:"native",partial}` |
| `mirror_error` | `diagnostic.log{warn}`（不影响轮） |

### 10.2 超时/中断阶梯

```text
轮 > maxTurnMs
 → ① Query.interrupt()（2615）—— 原生中断，会话保留
 → ② 2 s 无 result → Query.close()（2950）杀子进程
 → ③ session.recover：getSessionInfo → getSessionMessages 判轮 → resume
 → ④ resume 失败 → fork（forkSession:true）→ reseed → abort（R-11）
```

- `stopTask(taskId)`（2926）用于**只停子代理**，不终止主轮（比 `interrupt` 更细）。
- 中断/超时后**绝不重放**该轮；`turn.aborted{partial:true}` 后由调用方决定是否以新 `clientRequestId` 重发。

### 10.3 不支持 + 兼容层兜底（明确清单）

| # | claude 做不到的 ABI 能力 | 兜底 | 父级可见差异 |
|---|---|---|---|
| G1 | 宿主**不能**程序化派发原生子代理（`Agent` 是模型工具） | 通过 `agents` 定义角色 + prompt 指令；只观测 `task_*`；`nativeSubagents` 语义 = 可观测 | 派发成功率取决于模型；无"host 强制 spawn" |
| G2 | `SendMessage`/`ListAgents` 无公开 typing（U4） | `@experimental`：只解析 `tool_use` 入参做观测，不作为控制面 | 跨版本可能失效 |
| G3 | 无离线协议 schema | `structuredProtocol=emulated`：录制真实消息流做契约回归（`tests/fixtures`） | 回归靠回放，不靠 schema |
| G4 | 无结构化 plan/diff 事件 | `planUpdates`/`diffUpdates=unavailable`：计划/改动文本混在 assistant/tool_result 里（R-17） | 无计划/改动面板 |
| G5 | 无归档/取消归档 | `sessionArchive`/`sessionUnarchive=unavailable`：只归档 Broker 侧记录（ABI §3.2 默认行为） | 后端残留，不可恢复 |
| G6 | 无全局并发上限配置 | `concurrencyControl=unavailable`：Broker 信号量 + 队列（R-13） | 可能超卖，429 增多 |
| G7 | ABI v0 原无 `backend.internal-error` | **已关闭**：D10 以 MINOR 增补 `backend.internal-error`（category=internal），后端内部错误一律用它；`internal.unexpected` 仅保留给兼容层自身缺陷 | — |
| G8 | 无会话级 worktree 选项 | `worktreeIsolation=emulated`：外层建 worktree 传 `cwd`（R-16） | 隔离责任在调用方 |
| G9 | 无输入队列 API | `inputInbox=emulated`：适配器内存队列 + `streamInput` 转发 | 队列状态由兼容层自报 |
| G10 | `listSubagents()` 不可靠（本机返回 `[]`） | 深度/子代理审计改走 `subagents/*.meta.json` 扫描 + `task_*` 事件（`R:133`） | 子代理清单可能不完整 |
| G11 | `--from-pr` 不可脚本化 | 不支持（`session.create` 的 `fromPr` 类参数一律拒绝） | 「按 PR 恢复」不可用 |
| G12 | resume 的 cwd/slug 约束未验证（R-CC-1） | 持久化 `(sessionId,cwd,slug)`，resume 强制同 cwd；失败 → fork/reseed | 跨目录续接可能失败 |

### 10.4 失败模式表

| 触发 | 检测 | 分类码 | 动作 | 父级可见 |
|---|---|---|---|---|
| CLI 版本漂移 | V1 断言 | `protocol.version-mismatch` | fail fast | 「版本不匹配，已阻止启动」 |
| SDK/CLI 组合错配 | V3（init） | `protocol.version-mismatch` | 杀子进程，拒绝会话 | 同上 |
| 未登录 | `apiKeySource==='none'` | `auth.missing-credential` | `blocked`，提示先登录 | 「后端未配置凭据，请先登录」 |
| 权限桥挂起风险 | `canUseTool` 2 s 未决策 | 兜底 deny | fail-closed，绝不阻塞 | 「操作被权限策略拒绝」 |
| 轮内上下文压缩 | `compact_boundary` | `session.warning` | 记录历史不连续 | 「上下文已压缩，历史可能不连续」 |
| 凭据被拒 | `authentication_failed` | `auth.credential-rejected` | 不循环重试（防锁定） | 「后端拒绝凭据，请检查配置」 |
| 进程崩溃 | 非零退出无 result | `process.crashed` | `lost` → resume | 「后端进程崩溃，正在恢复会话」 |
| 会话不存在 | `getSessionInfo` undefined | `session.invalidated` | reseed/abort | 「会话已失效，无法续接」 |
| 映射损坏 | journal 校验失败 | `session.mapping-corrupt` | 用 `getSessionMessages` 重建或隔离 | 「会话映射损坏，需人工介入」 |
| 磁盘满 | journal 写失败 | `storage.disk-full` | 暂停新轮 | 「本地磁盘已满，已暂停新任务」 |

---

## 11. 可观测性

### 11.1 事件与诊断

| 输出 | 内容 | 约束 |
|---|---|---|
| `diagnostic.log` | `component:"adapter.claude-code"`，字段：`sdkType`/`sdkSubtype`、`sessionId`、`backendSessionId`、`messageId(uuid)`、`toolUseId`、`mappedType`、`dropReason`、`parentToolUseId`、`traceId` | 不含凭据/账户信息（`auth_status.output[]` 原文**禁止**入日志，SEC-1） |
| `session.warning` | 能力 emulated、事件丢弃、限流、压缩、模型切换、conversation-reset | 折叠 ≤1/窗口 |
| `transport.state-changed` | `connecting→ready→degraded→closed/failed` | 每次 query 生命周期 1 条 |
| 计数 | `msg.total`、`msg.byType{}`、`msg.dropped{reason}`、`turn.count/durationMs`、`perm.requested/denied{by policy}`、`child.spawned/completed`、`query.restart` | §11.3 阈值 |

### 11.2 健康与活性

- `sys.ping`（M18）→ `getSessionInfo(sessionId)`（轻、只读、零额度，`[实测-本轮]`）或对活跃 query 用 `streamInput` 心跳；不用 `listSessions`（全盘扫描，代价高）。
- 会话活性：`session_state_changed{state}`；进程活性：`worker_shutting_down` + 子进程 `exit` 事件。
- 成本观测：`result.total_cost_usd` + `modelUsage`（按模型），精度足以做预算门禁（`estimated:false`）。

### 11.3 折叠与上限

- 高頻丢弃优先：`tool.progress`（input_json_delta/tool_progress）> `message.delta` > `reasoning.delta` > `usage.updated` > child 进度 > 终态。
- 单轮 `stream_event` 数量可能极大（token 级）→ 适配器**全量发**，折叠归 L3（ABI §11；适配器只在背压时按 `dropPriority` 丢可折叠类）。
- `assistant` 文本超大 → `message.completed.text` 截断 + `truncated:true` + 全文 artifact；`tool_result` 内容 >64 KiB → 只给 `outputDigest` + artifact。
- 子代理 `output_file`（`task_notification`）作为 artifact 引用登记，不内联。

---

## 12. 验收命令

### 12.1 上游证据复跑（只读、零额度、幂等）

```bash
cd "$(git rev-parse --show-toplevel)"
bash repro/probe-claude.sh        # 退出码 0 = 探测完成
# 期望看到：
#  [1] 宿主 CLI 2.1.310（另一条线）/ SDK 0.3.263；适配器基线 = SDK 内置 CLI 2.1.263（§1.1）
#  [2] --help 关键 flag 行号（--resume 210、--fork-session 104、--include-partial-messages 120…）
#  [3] sdk.d.ts 关键符号行号（resume:1925、forkSession:1574、persistSession:1680、canUseTool:1454…）
#  [4] 二进制工具串（Agent/ListAgents/SendMessage/TaskStop/Workflow）
#  [5] claude agents --json；[5b] listSessions 实跑；[5c] subagents/*.meta.json（spawnDepth）
#  [7] DSH 插件的 query options（persistSession:false / canUseTool deny / 只认 success）
```

### 12.2 文档闸门

```bash
python3 tools/check_docs.py adapters; echo "rc=$?"
# 本文件相关必须零 FAIL
```

### 12.3 零额度 smoke（`[实测-本轮]` 已通过；只读会话文件、零额度、不写 `~/.claude`）

```bash
cd "$(git rev-parse --show-toplevel)"
node --input-type=module - <<'JS'
import os from 'node:os';
const SDK = process.env.CLAUDE_SDK_PATH
  || `${os.homedir()}/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`;
const sdk = await import(SDK);
const need = ['query','listSessions','getSessionInfo','getSessionMessages','forkSession','listSubagents'];
for (const n of need) if (typeof sdk[n] !== 'function') throw new Error(`missing ${n}`);
const pkg = JSON.parse((await import('node:fs')).readFileSync(
  `${os.homedir()}/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/package.json`, 'utf8'));
if (pkg.version !== '0.3.263') throw new Error(`SDK version ${pkg.version}`);
const list = await sdk.listSessions({ limit: 3 });          // 零额度
for (const s of list) {
  const info = await sdk.getSessionInfo(s.sessionId);        // 零额度
  const msgs = await sdk.getSessionMessages(s.sessionId);    // 零额度：读 transcript
  console.log(s.sessionId, info?.cwd, 'msgs=', msgs.length, 'subagents=', (await sdk.listSubagents(s.sessionId)).length);
}
console.log('OK sdk=', pkg.version);
JS
echo "rc=$?"
```

### 12.4 C5 施工验收（**消耗额度**；本文只列断言，不在设计阶段执行）

| # | 断言 | 做法 |
|---|---|---|
| A1 | 一轮成功：`init` → `assistant` → `result{success}`，`turn.completed` + `usage.updated` 各 1 | 真实 query |
| A2 | `persistSession:true` 下 `~/.claude/projects/<slug>/<sid>.jsonl` 新增，`getSessionInfo` 可读 | 跑前跑后对比 |
| A3 | 新建 → `resume` 一轮 → 断言 `session_id` 相同；再 `resume+forkSession` → 断言新 id 且旧会话仍可读 | U5 |
| A4 | `Query.interrupt()` 后 2 s 内 `result`（`stop_reason` 反映中断）→ `turn.aborted` | 长任务 |
| A5 | `includePartialMessages:true` → 收到 `stream_event`；关掉 → 无 `stream_event` | 两次对比 |
| A6 | `canUseTool` 走桥：需写工具被 deny，2 s 内 `permission.resolved`，无挂起（ABI-T8） | `safe-auto` 下让模型写文件 |
| A7 | 子代理：出现 `task_started(spawn_depth=1)` → `child.spawned`；`forwardSubagentText` 开/关对比 `parent_tool_use_id` 文本量 | 显式要求"派子代理" |
| A8 | `resume` 跨 cwd（R-CC-1）是否可行；不可行则记录并强制同 cwd | 两次不同 cwd |
| A9 | ~~`sandbox{enabled:true}` 真实生效~~ **C5 已实测：无 OS 级强制证据** → 能力位 `sandboxModes:"emulated"`（§2.4/§7.3）；残余风险登记，不再作为验收项 | `[实测-本轮]` + 残余风险见 §7.3 |
| A10 | 同 `clientRequestId` 重放 `session.send`，产品侧 user 消息只增 1 条 | 录制 `getSessionMessages` 前后条数 |

> 本文全部 claude-code 调研证据由 `repro/probe-claude.sh` 复跑；上级事实基线见 `docs/research/claude-code.md`、`docs/research/capability-matrix.md`。

---

## 附录 A — 本轮零额度只读探测记录（可复现）

环境：macOS arm64，SDK `0.3.263`（内置 CLI `2.1.263` = 适配器基线；宿主 nvm CLI `2.1.310` 属另一条线），未发起任何 LLM 请求。

**A-1 双版本**

```text
claude --version → 2.1.310 (Claude Code)                  # 宿主线（默认不用）
sdk package.json version → 0.3.263
SDK 平台包 manifest.json.version → 2.1.263                 # 适配器基线（C5 实测）
C5 init.claude_code_version → 2.1.263                      # 真实一轮握手
```

**A-2 SDK 程序化会话 API（真实调用）**

```text
exports_ok: query,listSessions,getSessionInfo,getSessionMessages,forkSession,listSubagents,getSubagentMessages,deleteSession
missing: none
listSessions({limit:3}) → 3 行；行键 sessionId,summary,lastModified,fileSize,customTitle,firstPrompt,gitBranch,cwd,tag,createdAt
getSessionInfo(sid)     → 同键；示例 cwd = $(git rev-parse --show-toplevel)
```

**A-3 transcript 形状（`getSessionMessages`，映射表 #10 的直接依据）**

```text
msgs = 6~8 条，type ∈ {user, assistant}；内容块实测出现：
  assistant: text / thinking / tool_use(name=Read, id=call_74d34eb…)
  user:      tool_result(is_error=false)
listSubagents(sid) → []     # 与 R:133 一致：不可作为"有无子代理"判据
```

**A-4 `sdk.d.ts` 关键符号行号（本文引用依据，可 grep 复核）**

```text
resume?: string                     1925
resumeSessionAt?: string            1939
sessionId?: string                  1931
forkSession?: boolean               1574
continue?: boolean                  1459
persistSession?: boolean            1680   （@default true；false 不可 resume）
includePartialMessages?: boolean    1725
forwardSubagentText?: boolean       1732 / 4016
permissionPrompts?: 'host'|'none'   1859
canUseTool?: CanUseTool             1454 / 类型 209 / fail-closed 注释 205
PermissionMode                      2317   （default|acceptEdits|bypassPermissions|plan|dontAsk|auto）
PermissionResult                    2339
sandbox?: SandboxSettings           2032 / 类型 3171 / enabled 语义 1994-2011
query(...)                          2953
Query.interrupt/setPermissionMode/setModel/streamInput/stopTask/close
                                    2615 / 2622 / 2649 / 2921 / 2926 / 2950
listSessions/getSessionInfo/getSessionMessages/forkSession/listSubagents
                                    992 / 767 / 797 / 738 / 1047
SDKMessage 联合（39 种）              4681
SDKSystemMessage(init)              5148 / 5144（claude_code_version 字段）
SDKAssistantMessage                 3318 / SDKPartialAssistantMessage 4826
SDKResultSuccess/Error              5005 / 4957
SDKTaskStarted/Updated/Progress/Notification
                                    5261 / 5297 / 5236 / 5210
SDKPermissionDeniedMessage          4855 / SDKRateLimitEvent 4924
SDKSessionStateChangedMessage       5105 / SDKStatus 5131 / SDKStatusMessage 5133
```

**A-5 SDK 把 `Options` 翻成 CLI 参数（`sdk.mjs` 第 121 行，压缩后的构造器）**

```text
permissionPrompts        → --permission-prompts <x>
continue                 → --continue
resume                   → --resume=<id>
forkSession              → --fork-session
resumeSessionAt          → --resume-session-at=<uuid>
resumeDropsTurn          → --resume-drops-turn=<v>
sessionId                → --session-id=<uuid>
persistSession === false → --no-session-persistence
includePartialMessages   → --include-partial-messages
includeHookEvents        → --include-hook-events
fallbackModel            → --fallback-model <m>
canUseTool               → --permission-prompt-tool stdio
                           （与 permissionPromptToolName 同时设置会直接抛错）
plugins[].type==='local' → --plugin-dir <path>
addDirs                  → --add-dir <path>
```

## 附录 B — 交叉引用与遗留

- ABI：`docs/abi/abi-v0.md` §2.2/§2.3、§3.2/§3.5、§4（反向请求与超时义务）、§5.2、§6.1/§6.2（M2/M3/M4/M5/M8/M13/M15）、§7、§8.2、§9、§10、§11。
- 上游事实：`docs/research/claude-code.md`（R）、`docs/research/capability-matrix.md`（M）、`docs/integration/00-dsh-integration.md`（C）。
- 交给 C5 的未决：V-CC-1（SendMessage/ListAgents 入参）、V-CC-2（resume+fork 往返）、V-CC-4（并发键）、V-CC-5（updatedPermissions）、V-CC-6（auto 分类器）、R-CC-1（resume 跨 cwd）、U5/U6/U11。
- 交给 D4 的缺口：`event.json` 缺 §5.6 列举的变体；ABI v0 缺 `backend.internal-error`（G7）。
- 交给 D7（威胁模型）：transcript 落盘（`~/.claude/projects`）含 prompt 与产物摘要，属敏感数据面。

---

> **本规格的全部探测证据可复跑**：`bash repro/probe-claude.sh`（幂等、只读、零额度；缺失项标 SKIP，退出码 0 = 探测完成）。
> 验收命令见 §12（12.1 证据复跑 / 12.2 文档闸门 / 12.3 零额度 SDK smoke / 12.4 C5 一轮与续接断言）。
