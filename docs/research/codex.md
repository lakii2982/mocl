# codex 后端调研（D1 / 本机实测）

> 结论标记：`[实测]` = 本机跑出的可复跑证据；`[文档]` = 官方 CLI/协议文本；`[推断]` = 由前两者推导、未直接执行验证。
> 所有证据命令见 §7，统一由 `bash repro/probe-codex.sh` 复跑（只读、不消耗模型额度、不写 `~/.codex`）。
> 安全：本文只写配置**键名**与文件路径；任何 token/凭据一律未读取、未打印。

## 1. 版本与安装路径

本机曾并存两个 codex。**R2 起唯一基线 = 0.164.0**（`PATH` 上的 host）；0.153.4 是 DSH profile 内**尚未升级的旧载荷**，只作迁移对照，不得作为基线、契约来源或类型生成源。

| 角色 | 路径 | 版本 | 证据 |
|---|---|---|---|
| **基线（唯一）** | `/Users/lakii2982/.nvm/versions/node/v24.18.1/bin/codex`（node 包装 → `.../lib/node_modules/@openai/codex/bin/codex.js`） | **0.164.0** | `codex --version` → `codex-cli 0.164.0` `[实测] §7-1` |
| 基线原生二进制 | `~/.nvm/versions/node/v24.18.1/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` | 0.164.0（260 MB） | `readlink -f` + `--version` `[实测] §7-1` |
| 旧载荷（待升级） | `~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` | **0.153.4** | `<bundle> --version` `[实测] §7-1` |
| 旧载荷 npm 包 | 同目录 `package.json` | `0.153.4-darwin-arm64` | `[实测]` |
| DSH 插件 | `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-codex/`（`0.2.1-rc.3`） | 其 `dependencies` **精确钉** `"@openai/codex": "0.153.4"`（非范围） | 插件 `package.json` `[实测]` |

### 1.1 升级路径：把 profile 旧载荷升到基线 0.164.0

DSH 插件用 `require.resolve("@openai/codex/package.json")` 决定子进程二进制（`lib/index.js:535`，`CODEX_PACKAGE_BIN`），**没有配置项**可指向外部路径；且插件对 `@openai/codex` 是**精确版本依赖**。因此升级只有两条路：

| 路径 | 做法 | 适用/代价 |
|---|---|---|
| **A（推荐，profile 依赖升级）** | 在 `~/.dsh/profiles/desktop/package.json` 增加 `pnpm.overrides`：`{"@openai/codex": "0.164.0", "@openai/codex-darwin-arm64": "0.164.0"}` → `pnpm install --dir ~/.dsh/profiles/desktop` → 重启 DSH | 插件零改动；需重新装依赖（离线需缓存/npm 可达）；`pnpm-lock.yaml` 里 `darwin-x64/linux-*` 旧平台包一并 override 或忽略（本机只加载 darwin-arm64） |
| **B（兼容层配置，非插件）** | 本项目的 L1 适配器支持 `codex.binaryPath` 指向基线绝对路径 | 只解决**新兼容层**；DSH 现有插件仍会用 0.153.4 → 两套路径并存期必须显式声明用哪套 |

**升级前置门禁（缺一不可，全部只读/零额度，除最后一条）**

1. 两处 `--version` 一致：`codex --version` 与 `~/.dsh/.../@openai/codex-darwin-arm64/.../bin/codex --version` 均为 `codex-cli 0.164.0`；
2. 0.164.0 能读 0.153.4 写的历史 rollout（`thread/read` 一个旧会话，见 §9 V-CX-6）；
3. 插件用到的三方法在 0.164.0 仍在且同形：`thread/start`、`turn/start`、`turn/interrupt`（`[实测] §7-4`+插件 §7-8）；
4. 1 个真实 turn 冒烟通过（消耗额度，施工 C4），并确认 `thread.ephemeral` 断言与新版本一致。

### 1.2 协议差异表（0.153.4 → 0.164.0；**迁移参考，不再作为双基线**）

两版本导出物均为 39 个文件，但内容不同 `[实测] §7-4`：

| 维度 | 0.153.4（旧载荷） | 0.164.0（基线） | 差异 |
|---|---|---|---|
| `ClientRequest` | 99 | **106** | +8 / −1（删除 `thread/rollback`） |
| `ServerNotification` | 81 | **85** | +4（`account/gatewayOAuth/changed`、`thread/attachment/updated`、`thread/prediction/updated`、`thread/readState/changed`） |
| `ServerRequest` | 10 | **10** | 无变化（8 现代 + 2 v1 legacy） |
| v2 definitions | 622 | **668** | +48 / −2（删 `ThreadRollbackParams/Response`）、53 个同名定义变化 |
| 新增 `ClientRequest` | — | `account/gatewayOAuth/{login,read,cancel}`、`feedback/save`、`thread/attachment/{add,list,remove}`、`thread/attachmentOwner/list` | 均为新面（插件/账户/附件） |
| `Thread` | — | +`originator` | 增量字段 |
| `TurnStartParams` | 16 props | +`disabledPluginIds`、`parentTurnId`、`rootTurnId` | 增量可选 |
| `ThreadResumeResponse` | 12 props | +`collaborationMode`、`disabledPluginIds` | 增量可选 |
| `ThreadStartResponse`/`ThreadForkResponse` | — | +`disabledPluginIds` | 增量可选 |
| `ThreadItem` | 19 变体 | 19 变体（`imageGeneration` +`inputImages`、`mcpToolCall` +`mcpAppUi`、`subAgentActivity` +`model/reasoningEffort`） | 增量可选 |
| 运行时独有（schema 未导出） | `server/diagnostics` | `server/diagnostics`、`userVerification/{status,enroll,delete,verify}`、`Thread.environments[]`、`thread/list.readStates` | 版本内自行扩展，**不得**写进契约 |

核心面（`thread/start|resume|fork|list|loaded/list|read|turns/list`、`turn/start|steer|interrupt`、`item/*` 通知、`collabAgentToolCall`、`CollabAgentTool` 9 值、`MultiAgentMode`）**两版本同形** `[实测]`。

### 1.3 并存期规则（旧载荷未升级前）

1. **不以旧载荷为基线**：任何只在 0.153.4 上验证过的结论必须标注 `[legacy-0.153.4]`；契约/类型/CI 期望值一律取 0.164.0。
2. **CI 期望值**：`39 文件 / ClientRequest=106 / ServerNotification=85 / ServerRequest=10`（`bash repro/probe-codex.sh` 断言；旧载荷对照走 `--legacy`）。
3. **会话文件跨版本混写是既成事实**：本机 93 条 rollout 的 `cli_version` = `0.163.0-alpha.11.2`×38 / `0.163.0-alpha.11`×26 / `0.163.0-alpha.10.2`×22 / `0.162.0-alpha.17.2`×5 / `0.153.4`×2 `[实测] §7-6` → 冷恢复必须「先 `thread/read` 再 `thread/resume`」，失败降级为新建线程。

## 2. 证据：协议面真实字段（不是猜测）

全部由 `codex app-server generate-json-schema --out <dir>` 导出后解析 `codex_app_server_protocol.v2.schemas.json`。`[实测]`

```text
基线 0.164.0：ClientRequest = 106 / ServerNotification = 85 / ServerRequest = 10（8 现代 + 2 v1 legacy）/ v2 definitions = 668 / 39 文件
对照 0.153.4（旧载荷）：ClientRequest = 99 / ServerNotification = 81 / ServerRequest = 10 / v2 definitions = 622 / 39 文件
```

- **`thread/*`（客户端方法，基线 0.164.0）**：`thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/loaded/list`、`thread/read`、`thread/items/list`、`thread/turns/list`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/compact/start`、`thread/inject_items`、`thread/metadata/update`、`thread/name/set`、`thread/revert`、`thread/rollback`、`thread/shellCommand`、`thread/unsubscribe`、`thread/approveGuardianDeniedAction`、`thread/section/move`、`thread/goal/{get,set,clear}`、`thread/attachment/{add,list,remove}`、`thread/attachmentOwner/list`（基线新增）；旧载荷另有 `thread/rollback`（基线已删）。`[实测]`
- **`thread/*` 通知**：`thread/started|closed|archived|unarchived|deleted|compacted|reverted|status/changed|name/updated|settings/updated|tokenUsage/updated|queue/changed|project/updated|environment/{connected,disconnected}`。`[实测]`
- **`turn/*`**：方法 `turn/start`、`turn/steer`、`turn/interrupt`；通知 `turn/started`、`turn/completed`、`turn/plan/updated`、`turn/diff/updated`、`turn/moderationMetadata`。`[实测]`
- **`item/*`（14 个流通知）**：`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}`、`item/plan/delta`、`item/commandExecution/{outputDelta,terminalInteraction}`、`item/fileChange/{outputDelta,patchUpdated}`、`item/mcpToolCall/progress`、`item/autoApprovalReview/{started,completed}`。`[实测]`
- **`ThreadItem` 19 变体（基线；变体数未变，字段有增量）**：`userMessage, hookPrompt, agentMessage, functionCallOutput, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction`。`[实测]`
- **`collabAgentToolCall` 真实字段**：`agentsStates`(map→`CollabAgentState{status,message}`)、`id`、`model`、`prompt`、`reasoningEffort`、`receiverThreadIds[]`、`senderThreadId`、`status`(`CollabAgentToolCallStatus`)、`tool`(`CollabAgentTool`)、`type`。required = `agentsStates,id,receiverThreadIds,senderThreadId,status,tool,type`。`[实测]`
- **`CollabAgentTool` 枚举（9 值，基线与旧载荷一致）**：`spawnAgent, sendInput, resumeAgent, wait, closeAgent, sendMessage, followupTask, interruptAgent, listAgents`。`[实测]`
- **`CollabAgentStatus`**：`pendingInit, running, interrupted, completed, errored, shutdown, notFound`；**`CollabAgentToolCallStatus`**：`inProgress, completed, failed, interrupted`。`[实测]`
- **`MultiAgentMode`**：`"explicitRequestOnly" | "proactive" | {"custom": string}`；描述原文 *"Controls the effective multi-agent delegation instructions for a turn"*。`[实测]`
- **`MultiAgentVersion`**：`disabled | v1 | v2`（按模型声明）。`[实测]`
- **`ThreadLoadedListParams`** = `{cursor?, limit?}`；**`ThreadLoadedListResponse`** = `{data: string[] (required), nextCursor?}`，描述 *"Thread ids for sessions currently loaded in memory"*。`[实测]`
- **`ThreadResumeParams`**（13 props，required 仅 `threadId`）：`threadId, approvalPolicy, approvalsReviewer, baseInstructions, config, cwd, developerInstructions, excludeTurns, model, modelProvider, personality, sandbox, serviceTier`。`[实测]`
- **`ThreadResumeResponse`**：`approvalPolicy, approvalsReviewer, cwd, instructionSources, itemsBackwardsCursor, model, modelProvider, reasoningEffort, sandbox, serviceTier, thread, turnsBackwardsCursor`（+host 的 `collaborationMode/disabledPluginIds`）。`[实测]`
- **`ThreadForkParams`**：`threadId` + `lastTurnId`（含描述：*"Optional last turn id to fork through, inclusive"*）+ `ephemeral` + 权限/模型覆盖。**注意 `ephemeral` 只在 fork 与 start 上，resume 没有**。`[实测]`
- **审批/交互 `ServerRequest`（10 个 method，基线与旧载荷一致）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/call`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`applyPatchApproval`（v1 legacy）、`execCommandApproval`（v1 legacy）。`[实测]` → 无人值守必须能对这些**逐条自动应答**，否则会挂起。旧稿把 `mcpServer/elicitation/request` 里的 `mode:"openai/form"` 误计为独立 method 且漏掉两个 legacy 变体，已按导出物订正。`[实测]`
- **`AskForApproval`** = `untrusted | on-request | never | {granular: ...}`；**`ApprovalsReviewer`** = `user | auto_review | guardian_subagent`；**`SandboxMode`** = `read-only | workspace-write | danger-full-access`。`[实测]`

## 3. CLI 面事实

| 能力 | 事实 | 证据 |
|---|---|---|
| headless | `codex exec [PROMPT]`，支持 `--json`（JSONL）、`-o/--output-last-message`、`--output-schema <FILE>`、`--ephemeral`、`-s/--sandbox`、`--skip-git-repo-check`、`--worktree`、`--add-dir` | `codex exec --help` `[实测] §7-4` |
| resume | `codex exec resume [SESSION_ID] [PROMPT]`，`--last` 取最近；也可 `codex resume`（TUI 选择器） | `codex exec resume --help` / `codex resume --help` `[实测]` |
| fork | `codex fork [SESSION_ID] [PROMPT]`、`codex exec fork`；协议层 `thread/fork` + `lastTurnId` | `codex fork --help` `[实测]` |
| queue / steer | `codex queue --thread <THREAD> --message <TEXT>`；协议层 `turn/steer`；桌面配置 `[desktop] followUpQueueMode = "steer"` | `codex queue --help` + config `[实测]` |
| session list | `codex agents --help` = *"Browse all agent sessions on the shared local app-server daemon"*；`codex archive/delete/unarchive`；协议层 `thread/list`、`thread/loaded/list` | `--help` `[实测]`**注：`codex agents` 是 TUI，无 `--json`，脚本化应走 app-server** `[实测]` |
| interrupt | 协议 `turn/interrupt`（DSH 插件已在生产使用） | 插件 `lib/index.js` + schema `[实测]` |
| 子命令面（基线） | `agents exec review login logout mcp plugin app-server remote-control app completion update doctor sandbox debug apply resume queue archive delete migrate-rollouts migrate-nfs-db unarchive fork cloud exec-server features help`；相比旧载荷：**无** `mcp-server`，**新增** `migrate-rollouts`/`migrate-nfs-db`/`apply`/`cloud`/`exec-server` | `codex --help` `[实测] §7-2` |
| app-server | `--listen <URL>` 支持 `stdio://`(默认) / `unix://` / `unix://PATH` / `ws://IP:PORT` / `off`；`app-server daemon {bootstrap,start,restart,update,stop,version,enable-remote-control,disable-remote-control}`；另有 `proxy`、`generate-ts`、`generate-json-schema` | `codex app-server --help` / `app-server daemon --help` `[实测] §7-4` |
| 特性开关 | `codex features list` → host 182 项。相关项：`multi_agent = stable true`、`multi_agent_v2 = stable false`、`multi_agent_mode = removed false`、`daemon_auto_start = stable true`、`collaboration_modes = removed true`、`subagent_thread_environments = under development false` | `codex features list` `[实测] §7-7` |
| 模型目录 | `codex debug models` → 15 个模型，每项含 `multi_agent_version`（本机全部 `v1`）、`multi_agent_reasoning_effort`、`context_window/max_context_window`、`supported_reasoning_levels`、`experimental_supported_tools` | `codex debug models` `[实测]`（零额度、本地 catalog） |

`ultra` 推理档在模型目录里的描述是 *"Maximum reasoning with automatic task delegation"*（`gpt-6.1-sol`/`gpt-6-astra` 的 `multi_agent_reasoning_effort = xhigh`）→ 说明「自动派子代理」是模型档位的一等公民。`[实测]`

`codex exec --json` 的事件名在二进制里可确证存在 `thread.started`、`item.completed`、`turn.completed`、`turn.failed` 四个字节串（`[实测-字节串]`），但**`codex exec --json` 的事件 schema 没有任何离线导出命令**，而 app-server 有完整 schema → 适配器应走 app-server，不要解析 `exec --json`。`[推断-强]`

## 4. 配置面事实（只写键名）

`~/.codex/config.toml` `[实测] §7-5`：

```toml
[agents]
max_concurrent_threads_per_session = 3
max_depth = 2
enabled = true
interrupt_message = false
default_subagent_model = "..."              # 值省略
default_subagent_reasoning_effort = "high"
```

- `[mcp_servers]` 段：`mcp_servers.node_repl`、`mcp_servers.node_repl.env`、`mcp_servers.computer-use`（`computer-use` 的 `enabled = false`）。env 段只有**变量名**（如 `CODEX_HOME`），无凭据值。`[实测]`
- 顶层段（去重）：`[agents] [features] [features.context_management] [memories] [mcp_servers.*] [model_providers.custom] [model_providers.subscription_router] [model_providers.subscription_router.capabilities] [plugins.*] [marketplaces.*] [apps.connector_*] [projects."..."] [desktop] [tui.model_availability_nux]`。`[实测]`

> 说明：以上 `[agents]` 值是**本机当前配置**，不是产品默认值；兼容层并发/深度上限一律**运行时读取**，禁止硬编码（见 adapters/codex.md §9.1）。

**角色模板是既有产品能力**（对 DEC-4 直接相关）：`~/.codex/agents/*.toml` 共 9 个文件，键名集合为
`name, description, model, developer_instructions`（`explorer/reviewer` 额外有 `sandbox_mode`；`kimi_*` 额外有 `apps, plugins, memories, include_instructions`）。`[实测] §7-5`

```toml
name = "explorer"
description = "..."
model = "..."
sandbox_mode = "read-only"
developer_instructions = "..."
```

## 5. 会话持久化（resume/fork 的物理前提）

- `~/.codex/sessions/**/*.jsonl` 共 **93** 条 rollout；`~/.codex/archived_sessions/*.zst` **134** 条。`[实测] §7-6`
- rollout 首行 `session_meta.payload` 键：`session_id, id, parent_thread_id, cwd, runtime_workspace_roots, originator, cli_version, source, thread_source, model_provider, base_instructions, git, history_mode, multi_agent_version, subagent_history_start_ordinal, context_window, timestamp`。`[实测]`
- `cli_version` 分布（93 条）：`0.163.0-alpha.11.2`×38 / `0.163.0-alpha.11`×26 / `0.163.0-alpha.10.2`×22 / `0.162.0-alpha.17.2`×5 / `0.153.4`×2 → **跨版本混写实锤**（§1.3 规则 3）。`[实测]`
- 统计（93 条）：`thread_source` = `guardian_review`×53 / `subagent`×32 / `user`×6 / 缺失×2；`multi_agent_version` = `disabled`×53 / `v1`×32 / 缺失×8；**85 条有非空 `parent_thread_id`**。`[实测]`
- 含义：codex 的**原生子代理是独立持久化线程**，带父子链接，且历史是分页的（与 `thread/items/list`、`thread/turns/list` 的 `*BackwardsCursor` 对应）。`[实测+推断-强]`

## 6. 限制与已知坑

1. **唯一基线 0.164.0，旧载荷 0.153.4 必须升级**（R2 裁定）：两者协议不是同一份导出物（§1.2）。旧载荷未升级前，**不得**用它的导出物生成类型/契约、也不得把它当"支持版本"；升级路径与门禁见 §1.1。基线内仍要钉绝对路径 + 版本断言（`--version`、`init.userAgent`、`thread.cliVersion`），但**不再维护"双基线"**。
2. **会话文件跨版本**：93 条 rollout 的 `cli_version` 混写 0.162/0.163/0.164，另有 2 条 0.153.4（§5）。旧版本读新 rollout 的风险未知 → 冷恢复必须「先 `thread/read` 再 `thread/resume`」，失败要能降级为新建线程；**升级动作本身**也要先过 §1.1 门禁 2。
3. **`ephemeral: true` 是插件写死的**：DSH 现有插件 `thread/start` 固定带 `ephemeral: true`，并且**断言返回必须是 ephemeral**（`if (thread.ephemeral !== true) throw`）。这意味着「续接现有会话」在当前插件里不是"没实现"，而是**被主动拒绝**。任何改造都要先删掉这条断言。
4. **`thread/resume` 没有 `ephemeral`**：要长期存活必须 `thread/start` 不带 `ephemeral`（或 `false`）。协议允许，但**本机未执行过持久 turn（避免消耗额度）**，属 `[推断-强]`，施工阶段 C4 必须用 1 个 turn 实测。
5. **审批会挂起**：10 个 `ServerRequest` method（8 个现代 + 2 个 v1 legacy）都是「服务端问客户端」。无人值守必须**预注册全部 10 个 method 的自动应答**（deny / auto_review / 结构化拒绝），否则 turn 会永远等下去。现有插件只处理了 4 类（`commandExecution/fileChange/permissions/tool requestUserInput` 的 requestApproval 面）。
6. **多代理是 v1 稳定、v2 关着**：`multi_agent = stable true`，`multi_agent_v2 = stable false`。`MultiAgentMode` 与 `collabAgentToolCall` 存在≠v2 已可用；本机模型目录全部声明 `multi_agent_version: v1`。设计里不要把 v2 当默认面。
7. **`codex agents` 不可脚本化**：它是 TUI（无 `--json`），脚本化只能走 app-server 的 `thread/list` / `thread/loaded/list`。
8. **`codex exec --json` 无 schema**：见 §3 末尾。
9. **`CODEX_HOME` 必须已存在**（基线行为变化）：0.164.0 对不存在的 `CODEX_HOME` 直接 fail：`Error: CODEX_HOME points to "…", but that path does not exist`（旧载荷 0.153.4 会自动创建）。测试/隔离环境必须先 `mkdir -p`；适配器**不得**替用户静默创建目录。另外 0.164.0 启动会打一条无害 warning：`could not create PATH aliases`（`[实测]`）。
10. **schema ≠ runtime**：导出物里有、运行时没有的方法会造成"设计依赖不存在的能力"。基线实测：`thread/items/list` 在导出 schema 里但运行时报 `-32601 not supported yet`；`thread/turns/list` 在首个 user message 之前报 `-32600 … not materialized yet`；反向地，`server/diagnostics`、`userVerification/*` 运行时有但**不在**导出 schema。适配器必须在握手期做一次运行时方法集探测（见 `docs/adapters/codex.md` §2.4）。

## 7. 复跑命令块

```bash
# 一键复跑（幂等、只读、零额度）；默认探测基线 0.164.0；退出码 0 = 基线断言通过
cd /Users/lakii2982/项目/多智能体编排
bash repro/probe-codex.sh
# 原始产物落在 ${TMPDIR}/mocl-probe/codex/（可用 MOCL_PROBE_OUT 覆盖）

# 旧载荷 0.153.4 只作迁移对照时才加 --legacy（额外导出旧协议并打差异表）
bash repro/probe-codex.sh --legacy

# --- 单条精查 ---
# 1) 基线版本 + 旧载荷版本一致性（升级验收：两条必须相同）
codex --version
~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --version

# 2) 基线协议导出 + 计数（期望 39 / 106 / 85 / 10）
codex app-server generate-json-schema --out /tmp/cx-base
ls /tmp/cx-base | wc -l
python3 -c "import json;d=json.load(open('/tmp/cx-base/ClientRequest.json'));print(len(d['oneOf']))"
python3 -c "import json;d=json.load(open('/tmp/cx-base/ServerNotification.json'));print(len(d['oneOf']))"
python3 -c "import json;d=json.load(open('/tmp/cx-base/ServerRequest.json'));print(len(d['oneOf']))"

# 3) collab / multi-agent 枚举（基线）
python3 -c "import json;d=json.load(open('/tmp/cx-base/codex_app_server_protocol.v2.schemas.json'))['definitions'];print(d['CollabAgentTool']['enum']);print(json.dumps(d['MultiAgentMode']))"

# 4) CLI 面（基线子命令）
codex --help | sed -n '/^Commands:/,/^Arguments:/p'
for s in "exec" "exec resume" "resume" "queue" "fork" "agents" "app-server daemon"; do codex $s --help | head -8; done

# 5) 配置键名（不外泄值；并发/深度上限是"运行时值"不是默认值）
grep -nE '^\[agents\]$' -A8 ~/.codex/config.toml
grep -oE '^\[mcp_servers[^]]*\]' ~/.codex/config.toml | sort -u

# 6) 会话存储与跨版本混写
find ~/.codex/sessions -name '*.jsonl' | wc -l
python3 -c "
import json,glob,os
from collections import Counter
c=Counter(); n=0
for p in glob.glob(os.path.expanduser('~/.codex/sessions/**/*.jsonl'),recursive=True):
    pl=(json.loads(open(p).readline()) or {}).get('payload') or {}
    c[pl.get('cli_version')]+=1
    if pl.get('parent_thread_id'): n+=1
print('cli_version:',dict(c)); print('with parent_thread_id:',n)"

# 7) 特性开关 / 模型目录（基线）
codex features list | grep -E 'multi_agent|daemon_auto_start'
codex debug models | python3 -c "import json,sys;d=json.load(sys.stdin)['models'];print(len(d));print({m['multi_agent_version'] for m in d})"

# 8) DSH 插件到底读什么 + 它钉的是哪个 codex 版本（升级检查点）
P=~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-codex
grep -oE '"(thread|turn|item)/[a-zA-Z/_]+"' $P/lib/index.js | sort -u
grep -n 'ephemeral' $P/lib/index.js
python3 -c "import json;print(json.load(open('$P/package.json'))['dependencies']['@openai/codex'])"
```

## 8. 15 项能力清单（codex 侧，供 D3 矩阵直接引用）

| # | 能力 | 结论 | 证据（可复跑） |
|---|---|---|---|
| 1 | headless | **支持** | `codex exec --help`（`--json`/`-o`/`--output-schema`/`--ephemeral`）`§7-4` |
| 2 | stream | **支持** | schema 14 个 `item/*` delta 通知 + `thread/tokenUsage/updated` `§7-2` |
| 3 | resume | **支持** | `thread/resume`（`ThreadResumeParams` 13 字段）+ `codex exec resume --help` + 93 份 rollout `§7-2/4/6` |
| 4 | fork | **支持** | `thread/fork`+`lastTurnId` + `codex fork --help` `§7-2/4` |
| 5 | session-list | **支持** | `thread/list`、`thread/loaded/list`（`{cursor,limit}`→`{data,nextCursor}`）+ `codex agents --help` `§7-2/4` |
| 6 | interrupt | **支持** | `turn/interrupt`（schema）+ DSH 插件生产在用 `§7-2/8` |
| 7 | native-subagents | **支持** | `CollabAgentTool` 9 值 + `collabAgentToolCall` 字段 + `[agents] enabled/max_depth` + 32 条 `thread_source=subagent` rollout `§7-2/5/6` |
| 8 | tool-extension | **支持** | `mcpServer/tool/call`、`mcpServerStatus/list`、`item/tool/call`、`plugin/*`、`skills/*`；`[mcp_servers.*]` 3 段 `§7-2/5` |
| 9 | permission-modes | **支持** | `AskForApproval`(untrusted/on-request/never/granular) + `ApprovalsReviewer`(user/auto_review/guardian_subagent) + 插件 3 档映射 `§7-2/8` |
| 10 | sandbox | **支持** | `SandboxMode` 3 值 + `SandboxPolicy`(writableRoots/networkAccess/excludeTmpdirEnvVar) + `-s/--sandbox` + `codex sandbox` `§7-2/4` |
| 11 | auth-model-routing | **支持** | `-m/--model`、`-p/--profile`、`[model_providers.*]`、`thread/start|turn/start` 的 `model/modelProvider/serviceTier`、`[agents] default_subagent_model`、`codex debug models` 15 模型 `§7-5/7` |
| 12 | concurrency | **支持（硬上限，但值是运行时配置）** | `[agents] max_concurrent_threads_per_session` / `max_depth`（本机当前 3 / 2，**非默认值**）+ `multi_agent=stable true` + `thread/loaded/list` `§7-5/7` |
| 13 | usage-observability | **支持** | `thread/tokenUsage/updated`、`account/usage/read`、`account/rateLimits/read`、`turn/diff/updated` `§7-2` |
| 14 | structured-protocol | **支持（最强项）** | JSON-RPC app-server + `generate-json-schema`（39 文件）+ `generate-ts` + `--listen stdio/unix/ws` `§7-2/4` |
| 15 | version-pinning | **支持（基线可钉）** | 唯一基线 0.164.0 可钉（`--version` + `init.userAgent` + `thread.cliVersion`）；旧载荷 0.153.4 必须升级（§1.1）；rollout 跨 0.162/0.163/0.164 混写，冷恢复需先 `thread/read` `§7-1/1.3/6` |

## 9. 未决项（TO-VERIFY）

| ID | 缺什么 | 怎么补（施工阶段） |
|---|---|---|
| V-CX-1 | 基线 0.164.0 上 `thread/start`（非 ephemeral）+ `turn/start` 的**真实往返**未跑（避免额度） | C4：1 个 turn，断言返回 `thread.ephemeral !== true` 且 `~/.codex/sessions` 新增 rollout |
| V-CX-2 | 冷恢复：进程 kill 后 `thread/resume` 能否接上同一 rollout | C2/C4：启动→kill→`thread/resume`→断言 `thread.id` 相同 |
| V-CX-3 | 10 个 `ServerRequest` method 的**自动应答**能否让 turn 不挂起（基线集合与旧载荷相同，但需在 0.164.0 复测） | C4：`approvalPolicy: never` + `sandbox: read-only` 各跑 1 turn，观察是否出现 request |
| V-CX-4 | `codex exec --json` 完整事件枚举 | 不补（不采用该面）；若必须用，抓 1 次真实输出并入库 |
| V-CX-5 | `multi_agent_v2`（及基线新增的 `multi_agent_v2_dynamic_tools`）打开后的行为 | 非一期目标，登记风险即可 |
| V-CX-6 | **升级门禁 2**：0.164.0 读 0.153.4 写的 rollout 是否兼容 | 升级前：用基线二进制 `thread/read` 一个旧会话（只读），比对字段；失败则不升级 |
| V-CX-7 | **升级门禁 3**：插件三方法（`thread/start|turn/start|turn/interrupt`）在 0.164.0 下的载荷兼容性（含 `ephemeral` 断言） | 升级后重启 DSH，跑 1 次 codex 子代理冒烟；失败回滚 profile 依赖 |
| V-CX-8 | 基线新面（account/gatewayOAuth、thread/attachment、thread/prediction、thread/readState）是否需要映射 | 不映射（UI/账户面）；若后续 ABI 需要，走 §7 事件 MINOR 流程 |

