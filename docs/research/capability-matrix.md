# 能力矩阵（D3）—— 4 后端 × 15 能力 + 对策 + 能力位建议

> 本文件是 D3 交付物：把 D1/D2 的调研事实压成**可施工的矩阵**。写域仅本文件；不改任何调研文档。
> 证据约定：每格格式为 `状态 简述（→ [证据] 文档:行号、repro/脚本 §段号、或可直接复跑的命令）`。
> 状态定义：✅ = 本机实测可用且通道已确认；🟡 = 可用但有前提/仅部分通道/证据不完整；❌ = 本机实测否定或产品面不存在。
> 后端列顺序：codex / kimi / claude-code / opencode（与 `tools/check_docs.py` 的 `BACKENDS` 一致）。
> 统计：✅ 47 / 🟡 10 / ❌ 3（共 60 格）；按后端：codex 14✅-1🟡-0❌、kimi 10-3-2、claude-code 11-4-0、opencode 12-2-1。
>
> **裁定回指（R2 需求变更，生效于本文件）**：
> - **D-015** codex 基线统一为**最新 0.164.0**（`ClientRequest=106 / ServerNotification=85 / ServerRequest=10`，39 个 schema 文件）；0.153.4 是**待升级旧载荷**，不再作为并行基线。
> - **claude 基线（C5 实测）**：适配器基线 = **Agent SDK 0.3.263 + SDK 内置 CLI 2.1.263**（`init.claude_code_version` 实测）；宿主 nvm `claude` 2.1.310 属**另一条升级线**、默认不使用；SDK 与内置 CLI 无握手校验 → 首轮 `init` 断言（与 D-015 的「单点基线」口径同构）。
> - **D-016** 并发上限一律取**运行时** `subagent.maxActiveSubagents`（DSH seam 设置；本机 `~/.dsh/profiles/desktop/cordis.patch.yml:97` = 20）；**文档禁止硬编码 8 或任何固定数字**；后端自身上限另计。
> - **D-017** B0（上游提案「可续接外部子代理」）**并行推进**，不再标注「不排期」；兼容层旁路自管会话仍是一期实现路径，二者不互斥。
> - **D-018** opencode 凭据**存在**：`~/.local/share/opencode/auth.json` 含 `opencode-go`；`opencode auth list` = OpenCode Go + GitHub Copilot（均 stored）。付费 key 已过期（401 `api_key_expired`），**免费模型可正常跑**。
> - **D-019** opencode 生产默认模型锁 `opencode-go/deepseek-v4.1-flash`（key 过期，需在 OpenCode Console 新建 key；重新登录不会续期）；free 兜底 = `opencode/deepseek-v4.1-flash-free`（实测 rc=0，且 `-s` 续接成功）。

## 1. 主矩阵（4 后端 × 15 能力 + 兼容层对策）

| 能力 | codex | kimi | claude-code | opencode | 兼容层对策（缺失/部分时怎么兜） |
|---|---|---|---|---|---|
| `headless` | ✅ `codex exec` + `--json/--output-schema/--ephemeral/--worktree`（→ [证据] `docs/research/codex.md:91`、`repro/probe-codex.sh` §3） | ✅ `-p` + `--output-format text\|stream-json`，实测 rc=0（→ [证据] `docs/research/kimi.md:363`、`repro/probe-kimi.sh` §2） | ✅ `claude -p --output-format json\|stream-json`，`--input-format stream-json` 双向（→ [证据] `docs/research/claude-code.md:186`、`repro/probe-claude.sh` §2） | ✅ `opencode run [--format json] [--agent] [--thinking]`；免费模型实测 rc=0：`opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free` → `text=OK`、`sessionID=ses_e8c27271…`（→ [证据] Lead 实测 2026-10-26、`docs/research/opencode.md:416`、`repro/probe-opencode.sh` §2） | 四后端均可用 → 列为**准入前提**：启动握手时探测不到非交互入口即拒绝注册该后端，不做半可用降级 |
| `stream` | ✅ app-server 14 个 `item/*` delta + `turn/plan/updated` + `thread/tokenUsage/updated`（→ [证据] `docs/research/codex.md:219`、`repro/probe-codex.sh` §4） | ✅ ACP token 级 `agent_message_chunk`（1 turn 实测 161 条 fragment）；CLI `stream-json` 仅消息级（→ [证据] `docs/research/kimi.md:364`、`docs/research/kimi.md:332`、`repro/probe-kimi.sh` §5） | ✅ `--include-partial-messages` + `SDKPartialAssistantMessage`，**仅** `--print` + `stream-json` 生效（→ [证据] `docs/research/claude-code.md:187`、`repro/probe-claude.sh` §2/§3） | ✅ **SSE 26 类事件全集已实测回填**（`session.text/reasoning/step/usage/execution.*`、`permission.asked`、inbox 等；delta 为 chunk 级 ≈50 字，非 token）+ CLI `--format json` JSONL + ACP token/chunk 级（→ [证据] `docs/research/opencode.md:417`（§3.12）、`docs/adapters/opencode.md:443`（§5.2 逐条映射）、`docs/adapters/opencode.md:837`（§12.4 已验证）） | 统一为「可选增量」：粒度不足时按消息级推送并降采样；父会话只收折叠后的里程碑（禁止逐 token 通知） |
| `resume` | ✅ `thread/resume`（13 字段，required 仅 `threadId`）+ `codex exec resume`，87 份 rollout 为物理前提（→ [证据] `docs/research/codex.md:220`、`repro/probe-codex.sh` §6） | ✅ ACP `session/load`、CLI `-S`/`-r`/`-c`；同 session 连续两轮均 `stopReason:end_turn`（→ [证据] `docs/research/kimi.md:365`、`docs/research/kimi.md:244`、`repro/probe-kimi.sh` §5） | ✅ CLI `-r/--resume`(210)、`--continue`(67)；SDK `resume?:string`(1925)+`resumeSessionAt`(1939)；前提 `persistSession:true`（DSH 插件设 false 才失效）（→ [证据] `docs/research/claude-code.md:188`、`docs/research/claude-code.md:66`、`repro/probe-claude.sh` §3） | ✅ **续接双通道实测**：CLI `-s <id>` 同 sessionID 正确复述 `OK`；HTTP v2 对同一 `sessionID` 再 `POST /api/session/{id}/prompt` → `outcome:"succeeded"`；ACP `session/load`（→ [证据] `docs/research/opencode.md:418`、`docs/research/opencode.md:349`、`docs/research/opencode.md:361`、`docs/adapters/opencode.md:824`（OC-3）） | 持久化 `(backend, sessionId, cwd)` 三元组；后端无续接时降级为「新会话 + 摘要重放」，并在事件里标 `resumed:false`，上层可感知 |
| `fork` | ✅ `thread/fork` + `lastTurnId`（含描述：fork through inclusive）（→ [证据] `docs/research/codex.md:221`、`docs/research/codex.md:83`、`repro/probe-codex.sh` §4） | ✅ `kimi fork <id>` → 新 session，实测 321ms；ACP `session/fork` 继承 model（→ [证据] `docs/research/kimi.md:366`、`docs/research/kimi.md:343`、`repro/probe-kimi.sh` §5） | ✅ CLI `--fork-session`(104)；SDK `forkSession?:boolean`(1574)、`forkSession()`(738)（→ [证据] `docs/research/claude-code.md:189`、`repro/probe-claude.sh` §2/§3） | ✅ `run --fork`、`POST /api/session/{id}/fork`（`boundary:{type:"through"}`）、ACP `session/fork`（→ [证据] `docs/research/opencode.md:419`、`docs/research/opencode.md:230`、`repro/probe-opencode.sh` §7） | 用于「并行试错」；无原语时用「复制工作树 + 新会话」模拟，并把复制成本与脏文件风险写进适配器约束 |
| `session-list` | ✅ `thread/list` + `thread/loaded/list`（`{cursor,limit}`→`{data,nextCursor}`）；`codex agents` 是 TUI 不可脚本（→ [证据] `docs/research/codex.md:222`、`docs/research/codex.md:95`、`repro/probe-codex.sh` §4/§8） | ✅ `session list --json`；ACP `session/list` 只返回传入/继承 cwd 的会话（→ [证据] `docs/research/kimi.md:367`、`docs/research/kimi.md:234`、`repro/probe-kimi.sh` §7） | ✅ `listSessions({limit:5})` 实跑 5 行 + `claude agents --json`（无 TTY 需求）（→ [证据] `docs/research/claude-code.md:190`、`repro/probe-claude.sh` §5/§5b） | ✅ **HTTP v2 建会话→prompt→续接全链路实测**：`GET /api/session` 跨项目、含 `cost/tokens/outcome/fork/time`；`GET /api/session/{id}` 返回 `outcome:"succeeded"` + `tokens{input,output,reasoning,cache}`；CLI `session list` 仍是 **project 作用域**（非 git 目录返回 `[]`），跨项目走 v2 API（→ [证据] `docs/research/opencode.md:420`、`docs/research/opencode.md:360`、`docs/adapters/opencode.md:476`） | 兼容层自建会话索引为权威账本，后端列举只作校准；作用域差异由适配器补 `cwd`/全量参数，禁止把 CLI 面的 `[]` 当"无会话" |
| `interrupt` | ✅ `turn/interrupt`（DSH 现有插件生产在用）（→ [证据] `docs/research/codex.md:223`、`repro/probe-codex.sh` §4/§8） | ❌ ACP `session/cancel` → `-32601 Method not found`；`--help` 无中断入口，只能 SIGTERM 杀进程（实测 `exit=-15`）（→ [证据] `docs/research/kimi.md:368`、`docs/research/kimi.md:240`、`repro/probe-kimi.sh` §5） | ✅ `Query.interrupt()`(2615)、`stopTask()`(2926) + `SDKControlInterruptResponse`（→ [证据] `docs/research/claude-code.md:191`、`repro/probe-claude.sh` §3） | ✅ **HTTP v2 中断实测**：`POST /api/session/{id}/interrupt?resume=true` → `{"interrupted":true}` + SSE `session.execution.interrupted{reason:"user"}` + `outcome:"interrupted"`，**中断后可再 prompt 成功**；`resume=false` 对已结束轮返回 `{"interrupted":false}`（幂等）；ACP `session/cancel` 仍未验证（归 ACP-only 面，见 U8）（→ [证据] `docs/research/opencode.md:421`、`docs/research/opencode.md:362`、`docs/adapters/opencode.md:826`（OC-5）） | 定义为「尽力而为 + 会话脏标记」：无单 turn 中断者升级为进程级 kill，强制该 turn 作废且**不重放**；kimi 必须每任务独立进程（否则连带杀同进程其他 session） |
| `native-subagents` | ✅ `CollabAgentTool` 9 值 + `collabAgentToolCall` 真字段 + 31 条 `thread_source=subagent` rollout；仅 `multi_agent v1` 稳定、v2 关闭（→ [证据] `docs/research/codex.md:224`、`docs/research/codex.md:76`、`repro/probe-codex.sh` §4/§6） | ✅ 5 个内置 profile（plan/agent/coder/explore/tower-worker）+ 落盘 `agents/agent-N`；ACP 未暴露 subagent 方法（→ [证据] `docs/research/kimi.md:369`、`docs/research/kimi.md:453`、`repro/probe-kimi.sh` §3） | ✅ `Agent/ListAgents/SendMessage/Workflow/TaskStop` 二进制证据 + `agent-*.meta.json.spawnDepth`；`SendMessage` 入参无 typing（→ [证据] `docs/research/claude-code.md:192`、`docs/research/claude-code.md:114`、`repro/probe-claude.sh` §4/§5c） | ✅ `debug agents`（general/explore 为 subagent）+ `parentSessionID`/`childSessionID` + ACP `_meta["opencode/child-session-updates"]`（→ [证据] `docs/research/opencode.md:422`、`docs/research/opencode.md:164`、`repro/probe-opencode.sh` §4） | 只透传不统一编排语义；深度上限取后端原生字段（codex `[agents].max_depth`、claude `spawnDepth`），取不到则强制 depth=1 并拒绝更深请求 |
| `tool-extension` | ✅ MCP（`mcpServer/tool/call`、`mcpServerStatus/list`）+ `plugin/*` + `skills/*` + `item/tool/call`（→ [证据] `docs/research/codex.md:225`、`docs/research/codex.md:75`、`repro/probe-codex.sh` §4/§5） | ✅ 4 个 managed 插件、`--skills-dir`、`~/.kimi-code/mcp.json`、ACP `session/new` 注入 `mcpServers`（→ [证据] `docs/research/kimi.md:370`、`docs/research/kimi.md:356`、`repro/probe-kimi.sh` §8） | ✅ `--mcp-config/--strict-mcp-config`、`agents`(1441)、`hooks`(33 事件)、`--plugin-dir`、`createSdkMcpServer`(511)（→ [证据] `docs/research/claude-code.md:193`、`repro/probe-claude.sh` §2/§3） | ✅ `mcp list/add/auth/logout`、`plugin *`、`GET /api/skill`、`~/.config/opencode/agent/*.md`（→ [证据] `docs/research/opencode.md:423`、`repro/probe-opencode.sh` §10） | 只注入**白名单** MCP/插件，禁用用户全局配置继承；扩展失败按「能力位缺失」处理而非报错退出 |
| `permission-modes` | ✅ `AskForApproval`(4) × `ApprovalsReviewer`(3) × `SandboxMode`(3) 三维；10 个 method 的 `ServerRequest` 需逐条自动应答（→ [证据] `docs/research/codex.md:226`、`docs/research/codex.md:85`、`repro/probe-codex.sh` §4） | 🟡 4 档存在（ACP `default/plan/auto/yolo`），但 `-p` 与 `--auto/-y/--plan` **互斥** → headless 档位只能由 `config.toml:default_permission_mode` 决定（本机 `auto`）（→ [证据] `docs/research/kimi.md:371`、`docs/research/kimi.md:106`、`docs/research/kimi.md:382`） | ✅ 6 档 + `--permission-prompts host\|none` + `canUseTool`；CLI `manual` 与 SDK `default` **不同名**，透传会报错（→ [证据] `docs/research/claude-code.md:194`、`docs/research/claude-code.md:76`、`repro/probe-claude.sh` §2） | ✅ **权限应答实测**：`build` 读 `.env` 触发 → SSE `permission.asked{id:"per_…",action,resources}` → `POST /api/session/{id}/permission/{requestID}/reply {"decision":"once"}` → **204**（枚举 `once\|always\|reject`）；`--auto` = 自动批准未被显式拒绝者（≈safe-auto 上限），三档映射已可定：read-only→`plan`、safe-auto→`plan`+白名单、yolo→v2 应答 `allow-always`（ACP 无对应 mode）；ACP 只有 `build/plan` 且 `request_permission` 形状未验证（见 U8）（→ [证据] `docs/research/opencode.md:424`、`docs/research/opencode.md:364`、`docs/adapters/opencode.md:555`（§7.2）、`docs/adapters/opencode.md:827`（OC-6）） | ABI 只认三档**语义**（read-only / safe-auto / yolo），逐后端映射；映射不到时收窄到 read-only 并告警，**默认绝不放行** |
| `sandbox` | ✅ OS 级 `SandboxMode` 3 值 + `SandboxPolicy`(writableRoots/networkAccess) + `codex sandbox`（→ [证据] `docs/research/codex.md:227`、`docs/research/codex.md:85`、`repro/probe-codex.sh` §4） | ❌ 二进制中 `sandbox-exec/seatbelt/landlock/bubblewrap` 命中 0；隔离仅靠 `[[permission.rules]]` + plan 只读 + `--add-dir`（→ [证据] `docs/research/kimi.md:372`、`docs/research/kimi.md:447`、`repro/probe-kimi.sh` §2） | 🟡 无 CLI 沙箱旗标；`Settings.sandbox`(2032) 可注入 + `--restricted`/`--tools` 工具级收窄（→ [证据] `docs/research/claude-code.md:195`、`docs/research/claude-code.md:38`、`repro/probe-claude.sh` §2/§3） | ❌ 命中 0；且默认 `{"action":"*","resource":"*","effect":"allow"}`（仅 `*.env*` 为 ask）→ **默认全放行**（→ [证据] `docs/research/opencode.md:425`、`docs/research/opencode.md:444`、`repro/probe-opencode.sh` §7） | OS 级隔离不外包给后端：强制 worktree + 目录白名单 + 事后 diff 审计；无 OS 沙箱的后端在 yolo 档**拒绝启动**，只允许 read-only/safe-auto |
| `auth-model-routing` | ✅ `-m/-p`、`[model_providers.*]`、turn 级 `model/modelProvider/serviceTier`、`codex debug models` 15 模型（→ [证据] `docs/research/codex.md:228`、`repro/probe-codex.sh` §7） | ✅ `providers.<id>` / `models."<p>/<m>"`、`-m`；ACP `session/set_model` 实测切到 `deepseek/deepseek-flash`（→ [证据] `docs/research/kimi.md:373`、`docs/research/kimi.md:238`、`repro/probe-kimi.sh` §4） | ✅ `--model/--fallback-model`、`AgentDefinition.model`(`inherit`)、`Query.setModel()`(2649)（→ [证据] `docs/research/claude-code.md:196`、`repro/probe-claude.sh` §2/§3） | 🟡 凭据存在但 key 过期：`opencode run -m opencode-go/deepseek-v4.1-flash` → 401 `api_key_expired`（renew 需在 OpenCode Console 新建 key）；可降级免费同模型；路由原语齐全（`auth list/login/switch`、`-m provider/model#variant`、`models` 39 条（10 条 free）、`POST /api/session/{id}/model`）（→ [证据] Lead 复测 2026-10-26、`docs/research/opencode.md:300`、`docs/research/opencode.md:426`、`repro/probe-opencode.sh` §5） | 模型路由由兼容层策略下发、后端只执行；opencode 无 `set_model` → 走 `set_config_option{configId:"model"}` 并缓存 66 项选项（约 8KB/次） |
| `concurrency` | ✅ 后端自身有原生上限 `[agents] max_concurrent_threads_per_session` / `max_depth`，`thread/loaded/list` 可观测；**编排并发由兼容层从运行时 `subagent.maxActiveSubagents` 派生**（D-016，本机 `cordis.patch.yml:97`=20）（→ [证据] `docs/research/codex.md:229`、`docs/research/codex.md:112`、`repro/probe-codex.sh` §5/§7） | 🟡 单进程可并发多 session，但**未发现**后端 `maxConcurrent*` 类配置键；**编排并发由运行时 `subagent.maxActiveSubagents` 派生**（D-016）（→ [证据] `docs/research/kimi.md:374`、`docs/research/kimi.md:452`、`repro/probe-kimi.sh` §4） | 🟡 后台会话可管理（`--bg`/`attach/logs/stop`）、`Agent.run_in_background`，但未发现后端全局并发上限键；**编排并发由运行时 `subagent.maxActiveSubagents` 派生**（D-016）（→ [证据] `docs/research/claude-code.md:197`、`docs/research/claude-code.md:209`、`repro/probe-claude.sh` §2） | 🟡 后端**无全局上限键**（`maxSteps` 只限单 agent 迭代，→ `concurrencyControl=unavailable`）；**并发配额由兼容层从运行时 `subagent.maxActiveSubagents` 派生，不写死数字**（D-016），后端原生限制（若将来发现）只作下限修正（→ [证据] `docs/research/opencode.md:427`、`docs/adapters/opencode.md:632`（§9.1）、`docs/adapters/opencode.md:636`（§9.2）） | 兼容层**不写死并发数**：启动时读运行时 `subagent.maxActiveSubagents` 派生信号量与每后端队列，超限返回 `ACTIVATION_LIMIT_REACHED` 式拒绝；后端原生上限只作**下限修正**（取更小者），不作依赖 |
| `usage-observability` | ✅ `thread/tokenUsage/updated`、`account/usage\|rateLimits/read`、`turn/diff/updated`（→ [证据] `docs/research/codex.md:230`、`docs/research/codex.md:72`、`repro/probe-codex.sh` §4） | ✅ ACP `usage_update{used,size}`（实测 36996/1000000）、slash `usage/status`、每会话 `state.json`（→ [证据] `docs/research/kimi.md:375`、`docs/research/kimi.md:268`、`repro/probe-kimi.sh` §5） | ✅ `total_cost_usd`(4968)、`usage`(4972)、`modelUsage`(4976)、`SDKRateLimitEvent`（→ [证据] `docs/research/claude-code.md:198`、`repro/probe-claude.sh` §3） | ✅ **用量三通道实测**：SSE `session.usage.updated{cost,tokens}` + `session.step.ended` 带 tokens；HTTP `GET /api/session/{id}` → `outcome:"succeeded"` + `tokens{input:5401,output:33,reasoning:41,cache{read:6272}}` + `cost:0`；ACP `session/prompt` 返回 `usage{inputTokens,outputTokens,totalTokens,cachedReadTokens}`；另有 `session.list` 聚合与 `opencode stats`（→ [证据] `docs/research/opencode.md:428`、`docs/research/opencode.md:360`、`docs/adapters/opencode.md:465`（§5.2 #19）） | 归一为可关闭的 usage 采样事件；只给单值者标 `precision:"coarse"`，禁止用于计费对账；父会话只收周期汇总 |
| `structured-protocol` | ✅ JSON-RPC app-server + 离线 `generate-json-schema`（39 文件）+ `--listen stdio/unix/ws` → 可导出真契约（→ [证据] `docs/research/codex.md:231`、`docs/research/codex.md:98`、`repro/probe-codex.sh` §4） | ✅ ACP（JSON-RPC 2.0 / newline-delimited / protocolVersion=1）；错误码 `-32601/-32602/-32603` 均实测命中（→ [证据] `docs/research/kimi.md:376`、`docs/research/kimi.md:241`、`repro/probe-kimi.sh` §5） | 🟡 `stream-json` 双向流 + control protocol（`SDKControlInitializeRequest`:3971）+ 39 种 `SDKMessage`，但**无离线 schema 导出**（→ [证据] `docs/research/claude-code.md:199`、`docs/research/claude-code.md:80`、`repro/probe-claude.sh` §3） | ✅ 双协议：ACP stdio + v2 HttpApi（OpenAPI 3.1.0 / 124 paths）+ SSE；错误为 `_tag` 标记 JSON（→ [证据] `docs/research/opencode.md:429`、`docs/research/opencode.md:215`、`repro/probe-opencode.sh` §7） | 这是 ABI 的传输地基；无离线 schema 者（claude）用**录制回放**做契约回归，禁止手写字段猜测；协议版本进握手断言 |
| `version-pinning` | 🟡 **基线 = 0.164.0（最新，D-015）**：适配器显式钉 PATH 上的 0.164.0（schema `ClientRequest=106 / ServerNotification=85 / ServerRequest=10`，39 文件）；bundle 内 0.153.4 为**待升级旧载荷**，不再作并行基线；残留：历史 rollout 混写 `cli_version` 0.162/0.163/0.164，需迁移后再读（→ [证据] `docs/research/codex.md:232`、`docs/research/codex.md:9`、`repro/probe-codex.sh` §1/§6、Lead 实测 2026-10-26） | 🟡 `kimi upgrade [-y]` **只升 latest、无版本参数** → 只能固定二进制路径/副本（→ [证据] `docs/research/kimi.md:377`、`repro/probe-kimi.sh` §1） | 🟡 **基线 = SDK 0.3.263 + 内置 CLI 2.1.263**（C5 实测；宿主 CLI 2.1.310 属另一条升级线，不做并行基线）、**无握手校验**；靠 SDK/平台包版本静态断言 + 首轮 `init.claude_code_version`(5157) 运行时断言（→ [证据] `docs/research/claude-code.md:200`、`docs/research/claude-code.md:129`、`repro/probe-claude.sh` §1） | ✅ `upgrade [target] --method …` 支持指定版本；`--version` 可断言（→ [证据] `docs/research/opencode.md:430`、`repro/probe-opencode.sh` §0） | 注册表记录 `(binaryPath, 实测 version, protocolVersion)` 并在启动断言；不匹配 → 只告警 + 收窄能力位（禁用未验证方法），不静默继续 |

> 读表补充：单格证据只给「最强一条 + 复跑入口」，完整证据链在各 `docs/research/<backend>.md`。
> `❌` 仅代表**该能力在对应后端产品面上不存在或实测被否定**，不代表该后端不可用（见否证命令，如 `repro/probe-kimi.sh` §2 的 sandbox 字符串命中 0）。
> **opencode 模型口径（D-019）**：生产默认 = `opencode-go/deepseek-v4.1-flash`；free 兜底 = `opencode/deepseek-v4.1-flash-free`（实测 rc=0、`-s` 可续接）。付费 key 过期（401 `api_key_expired`）时兼容层自动切 free 并在事件里标 `degraded:"free-model"`；恢复需用户在 OpenCode Console 新建 key。
> **并发口径（D-016）**：本表所有并发相关表述都不写死数字，统一由运行时 `subagent.maxActiveSubagents` 派生（本机 desktop patch = 20）。

## 2. 派生表 A：传输通道选型（**按后端选型**；opencode 按 LEDGER **D-007** = v2 HttpApi 优先 + ACP 兜底）

| 后端 | 首选通道 | 备选通道 | 不选/放弃的通道与原因 | 切换成本（同 ABI 下） |
|---|---|---|---|---|
| codex | **app-server JSON-RPC**（默认 `stdio://`，可 `unix://`/`ws://`；`thread/*`+`turn/*`+`item/*` 全量，可离线导 schema）（→ [证据] `docs/research/codex.md:98`、`docs/research/codex.md:231`、`repro/probe-codex.sh` §4） | `codex exec --json`（JSONL，仅救急）（→ [证据] `docs/research/codex.md:104`、`repro/probe-codex.sh` §3） | **不选 ACP**：codex 无 `acp` 子命令，产品面没有该传输（`repro/probe-codex.sh` §2 子命令面可复核）；也**不解析** `exec --json` 作主通道（无 schema 导出，字段不可契约化）；`codex agents` 是 TUI 无 `--json`，不可脚本化（→ [证据] `docs/research/codex.md:95`） | 低：ABI 不变，只换适配器内部实现；需保留 schema 版本断言（基线 0.164.0；旧 0.153.4 待升级，D-015） |
| kimi | **ACP over stdio**（newline-delimited JSON-RPC 2.0，`protocolVersion=1`；`session/new\|load\|fork\|list\|prompt` 全实测）（→ [证据] `docs/research/kimi.md:195`、`docs/research/kimi.md:228`、`repro/probe-kimi.sh` §5） | `kimi -p --output-format stream-json` + `-S/-r` 续接（消息级事件，无 ACP 客户端负担）（→ [证据] `docs/research/kimi.md:309`、`docs/research/kimi.md:337`、`repro/probe-kimi.sh` §2） | 不选 CLI 作主通道：无中断、事件仅消息级、权限档受 `config.toml` 约束（`-p` 与模式旗标互斥）；kimi 无 HTTP server 面可作备选（→ [证据] `docs/research/kimi.md:106`、`docs/research/kimi.md:382`） | 中：ACP 缺 interrupt，降级 CLI 意味着重做事件映射并放弃 token 级增量 |
| claude-code | **Agent SDK（TypeScript，0.3.263）**：进程内控制面 `Query.interrupt/setModel/setPermissionMode`、程序化 `listSessions/forkSession`（→ [证据] `docs/research/claude-code.md:81`、`docs/research/claude-code.md:85`、`repro/probe-claude.sh` §3/§5b） | CLI `--print --output-format stream-json --include-partial-messages`（SDK 底层即拉起该 CLI，`pathToClaudeCodeExecutable`:1824）（→ [证据] `docs/research/claude-code.md:17`、`docs/research/claude-code.md:131`、`repro/probe-claude.sh` §2） | **不选 ACP**：claude 无 ACP 面（产品无该传输）；不选交互 TUI：无增量流（`--include-partial-messages` 仅 `--print` 生效）（→ [证据] `docs/research/claude-code.md:131`） | 低：同一 CLI 二进制，SDK 只是控制面；退回裸 CLI 会丢 `interrupt/setModel` 等控制方法 |
| opencode | **v2 HttpApi（优先；D-007 裁定）**（`POST /api/session`、`/prompt`、`/interrupt`、`permission/{requestID}/reply`、`/inbox`、`/model`、`/worktree`、`/api/event` SSE；124 端点/OpenAPI 3.1.0；**建会话→一轮→续接→中断→权限应答全链路已实测**，SSE 26 类事件）（→ [证据] `docs/adapters/opencode.md:30`（§0.2 选型）、`docs/adapters/opencode.md:279`（§3.4 最小可运行示例）、`docs/research/opencode.md:326`（§3.12）） | **ACP over stdio（兜底）**（与 kimi 同构，可复用同一 ACP 客户端；`session/new\|load\|fork\|list\|prompt` 已实测；缺 `set_model`/中断/自动批准）（→ [证据] `docs/research/opencode.md:399`、`docs/adapters/opencode.md:184`（§2.3）） | 不选 v1 文档路径（`/session`、`/event` 在 2.1.4 回落 SPA HTML）；不选 ACP 作唯一通道（缺中断/自动批准/`set_model`，`session/cancel` 未验证）；不启动独立 `serve` 收日志（会把 server password 打到 stdout）（→ [证据] `docs/research/opencode.md:440`、`docs/research/opencode.md:437`） | 低-中：**唯一必须双通道**的后端 —— v2 HTTP 承载控制面/事件主干（已实测），ACP 只作 stdio 生命周期兜底；跨通道控制动作禁止（`docs/adapters/opencode.md` §10.3） |

**选型结论**：内部 ABI 自研（与 DEC-1 推荐一致），传输层**按后端取原生最强面**：codex=app-server JSON-RPC、claude-code=Agent SDK、kimi=ACP over stdio、**opencode=v2 HttpApi 优先 + ACP 兜底（D-007）**；opencode 必须双通道，kimi 因无中断需进程级隔离。

> **与适配器文档的口径对齐（2026-10-26）**：本节 opencode 行已统一为「**v2 HttpApi 优先 + ACP 兜底**」，与 `docs/adapters/opencode.md` §0.2（选型结论）/§0.3（原「与矩阵 §2『ACP 首选』的差异说明」）**不再有差异**——§0.3 所述差异已消除，适配器文档可将其降级为历史注记。

> **D-017 影响面（B0 并行推进）**：矩阵把「外部子代理可续接/可被父会话再驱动」视为**将被 B0 消除的过渡缺口**，因此不据此收窄任何能力位；一期仍按旁路自管会话实现（`resume`/`fork`/`session-list` 走各后端原生面），B0 落地后由 seam 复用同一 ABI，不要求适配器重写。

## 3. 派生表 B：ABI 能力位建议（12 个布尔位）

> 位名统一小写驼峰；本表只是**给 D4 ABI 文档的输入建议**，最终定义权与 JSON Schema 在 D4（不属本文件写域）。
> 取值列给出「四后端初始值」，顺序 = codex / kimi / claude-code / opencode。

| # | 能力位 | 覆盖的能力行 | 四后端初值 | 为 `false` 时上层如何降级 |
|---|---|---|---|---|
| 1 | `canStream` | `stream` | T / T / T / T | 只返回终态结果；进度面退化为「开始/结束」两事件，禁用增量面板，超时改为整体超时 |
| 2 | `canResume` | `resume` | T / T / T / T | 每次派发新建会话；兼容层以摘要 + 关键产物重放上下文，并标 `resumed:false` 供上层判断 |
| 3 | `canFork` | `fork` | T / T / T / T | 用「复制工作树/快照 + 新会话」模拟试错分支；禁止声称是会话级分叉，成本计入任务账本 |
| 4 | `canListSessions` | `session-list` | T / T / T / T | 只用兼容层自建索引；后端列举不可用时不报错，仅标 `source:"broker"` |
| 5 | `canInterrupt` | `interrupt` | T / F / T / T | 升级为进程级 kill 并把该 turn 标记为脏（作废、不重放、不重试）；上层只收到「已放弃」终态 |
| 6 | `hasNativeSubagents` | `native-subagents` | T / T / T / T | 禁用嵌套（`maxDepth=1`），由兼容层用多实例 + 工具级派发模拟；拒绝更深请求而非静默截断 |
| 7 | `canExtendTools` | `tool-extension` | T / T / T / T | 只给内置工具白名单；MCP/插件/skill 注入一律跳过并记 warning，不影响主流程 |
| 8 | `hasPermissionModes` | `permission-modes` | T / T / T / T | 固定最严档（read-only）+ 客户端侧自动拒绝所有审批请求；yolo 请求直接拒绝派发 |
| 9 | `hasOsSandbox` | `sandbox` | T / F / F / F | 兼容层兜底：强制 worktree + 目录白名单 + 事后 diff 审计；yolo 档拒绝启动 |
| 10 | `canRouteModel` | `auth-model-routing` | T / T / T / T | 固定后端默认模型/推理档；忽略上层的模型覆盖请求并记 warning |
| 11 | `hasHardConcurrencyCap` | `concurrency` | T / F / F / F | 并发槽位由运行时 `subagent.maxActiveSubagents` 派生（D-016，禁止写死数字）+ 排队；以兼容层计数为准，后端原生上限只作下限修正 |
| 12 | `hasUsageMetrics` | `usage-observability` | T / T / T / T | 关闭 usage 面板；预算控制退化为「按调用次数/超时」硬限，并标 `precision:"none"` |

> 取值规则：位 = 「能力存在 **且** 至少一条已实测通道可用」。矩阵里的 🟡 不改变位取值，但**适配器必须走已实测通道**
> （例：opencode 的 `interruptTurn`/`permissionAutoReply`/`modelRouting` 位必须标注 `constraint:"http-api"`，**不能**由 ACP 兜底通道提供；依据 **D-007** 与 `docs/adapters/opencode.md` §10.3）；这三项现均已有 v2 实测（§3.12：中断/权限应答/SSE 26 类事件），opencode 的 `modelRouting` 另受凭据状态影响（**D-019**：付费 key 过期 → 降级 free 模型，事件标 `degraded:"free-model"`）；🟡 对应的剩余风险只落在未决项 U8（ACP-only 面）/U14（付费 key），而非位定义本身。
> 这是「能力位」与「矩阵状态」的有意分工：位回答「能不能做」，矩阵回答「从哪条通道做、证据够不够」。

**未进位、但必须表达的 3 项**（避免把「准入」伪装成「能力」）：

| 能力行 | 表达方式 | 理由 |
|---|---|---|
| `headless` | **准入前提**，不设位：握手探测失败即拒绝注册该后端 | 四后端全 ✅，为 false 等于该后端不可编排，不是降级场景 |
| `structured-protocol` | 传输选型 + 元数据 `protocolSchema: "exportable" \| "recorded"`，不设布尔位 | 四后端都有机器可读通道；真差异是「能否离线导 schema」，用元数据比布尔位更精确（claude 为 `recorded`） |
| `version-pinning` | 注册表字段 `pinnedVersion: string` + 启动断言 `versionAssert: true\|false` | 差异是「能否钉住」，属实例属性而非能力位；断言失败时收窄能力位而不是整体拒绝 |

## 4. 一致性校验（四份调研互相矛盾或口径不同的地方 + 以谁为准）

| # | 分歧点 | 各文档口径 | 判定（以谁为准） |
|---|---|---|---|
| C1 | 权限档位命名 | claude：CLI `manual` vs SDK `default` 不同名、透传报错（`claude-code.md:76`、`:132`）；kimi：CLI `yolo`→ACP `auto`、CLI `auto`→ACP `yolo` **正好对调**（`kimi.md:104`）；opencode：ACP 只有 `build/plan`、`--auto` 不在 ACP mode（`opencode.md:204`、`:442`），但 **v2 权限应答已实测**（`permission.asked`→`reply{"decision":"once\|always\|reject"}`→204，`opencode.md §3.12`）；codex：三分量 `AskForApproval`×`ApprovalsReviewer`×`SandboxMode`（`codex.md:85`） | **以语义为准**：ABI 只定义三档语义（read-only / safe-auto / yolo），各适配器按实测原文映射；**禁止按名字透传**。命名冲突的仲裁依据 = 各文档里的实测原文（`claude --help` 行号、kimi `availableModes` 原文、opencode `configOptions` 原文） |
| C2 | 中断是否存在 | kimi ❌（`session/cancel` → `-32601`，`kimi.md:240`）；opencode **v2 已实测 ✅**（`opencode.md:421`、`§3.12`：`{"interrupted":true}` + `session.execution.interrupted`，中断后可续），但 ACP `session/cancel` 仍未验证 | **以「通道 + 实测」为准**：opencode 按主通道 v2 判 ✅，ACP 面差异单独记入 U8（不降级主判定）；不得把 v2 的 ✅ 推广到 ACP 面。kimi 无任何通道可中断 → ❌ 保持。**LEDGER D-007 裁定 opencode 主通道 = v2 HttpApi**，ACP 仅兜底 |
| C3 | 「沙箱」口径 | codex 有 OS 级 `SandboxMode`；kimi/opencode 用二进制字符串命中 0 证明**无 OS 级沙箱**；claude 只有 `Settings.sandbox` 注入 + 工具级收窄 | **以「OS 级 vs 策略级」二分口径为准**：policy 级（权限规则/工具白名单）不算 `hasOsSandbox`；否证以「二进制命中 0」+「无对应 flag」双证据为准（`kimi.md:447`、`opencode.md:518`） |
| C4 | 并发上限 | codex 有后端自身硬上限配置键（`codex.md:229`）；其余三份写「未发现 `maxConcurrent*` 键」（`kimi.md:374`、`claude-code.md:197`、`opencode.md:427`） | **以「未发现」措辞 + D-016 运行时口径为准**：矩阵这一行只判「后端自身有没有上限」（有=✅，未发现=🟡 证据缺口而非否定）；**编排并发一律取运行时 `subagent.maxActiveSubagents`**（本机 desktop patch=20），文档不得固化任何并发数字 |
| C5 | 版本锁定能力 | kimi `upgrade` 只能升 latest（`kimi.md:377`）；opencode `upgrade [target]` 支持指定版本（`opencode.md:430`）；codex 物理上仍有 0.153.4（bundle）与 0.164.0（PATH），但调研 §8 第 15 行已按 D-015 改写为「唯一基线 0.164.0 可钉」（`codex.md:232`），口径已一致；claude 基线 = SDK 0.3.263 + 内置 CLI 2.1.263（宿主 2.1.310 另线），无握手 | **以 D-015 基线为准**：codex 基线单点 0.164.0，0.153.4 只作待升级载荷（不再双基线）；矩阵按「能否钉住 + 是否已钉」判（kimi 🟡 / opencode ✅ / codex 🟡 残留历史 rollout 迁移），四后端一律要求注册表记录实测版本并断言 |
| C6 | 流式粒度 | 同一后端不同面粒度不同：kimi CLI `stream-json` 消息级、ACP token 级（`kimi.md:332`）；claude 增量仅 `--print`+`stream-json` 生效（`claude-code.md:131`）；opencode v2 SSE **26 类事件已实测回填**，但 delta 是 chunk 级（≈50 字/条，非 token），CLI/ACP 为消息/chunk 级 | **以「主通道 + 实测粒度」为准**：opencode 取 v2 SSE ✅（D-007+D-018，`opencode.md §3.12`），并显式标注 `tokenLevelStream=unavailable`（chunk 级）；不把「有流」当成「token 级流」，也不把某面粒度当成全通道粒度 |
| C7 | 会话列举作用域 | opencode CLI 是 project 作用域（非 git 目录返回 `[]`，`opencode.md:438`）；kimi `session/list` 只按 cwd 过滤（`kimi.md:389`、`:234`）；claude `listSessions` 可跨目录；codex `thread/list` 分页 | **以协议/API 面为准**，CLI 面的空结果不作判据；兼容层自建索引为权威（见对策列） |
| C8 | 原生子代理证据强度 | codex：协议一等字段 `collabAgentToolCall`（强）；claude：二进制字符串 + `meta.json`，`SendMessage/ListAgents` **无公开 typing**（`claude-code.md:110`）；kimi：profile + 落盘，ACP 未暴露方法（`kimi.md:453`）；opencode：agent 定义 + 子会话 id | 一律记 ✅，但**按证据强度分级**并写入未决项：codex 可直接编排；claude 的地址面（SendMessage 入参）未定型，施工须先补 schema 再依赖 |
| C9 | 「支持」的判定口径 | 调研文档里存在待验证标记（如 `V-CC-1`、`V-CX-1`）；有的能力行按「产品面存在」记支持，有的按「通道实测」记支持 | **本矩阵统一口径**：状态 = 本机实测 + 通道已确认；产品面存在但未实测者一律 🟡 并进未决项。调研文档中的待验证标记不改原文，只在本文件转写为未决项 |
| C10 | headless 的附加限制 | 需求基线 §3 只列 flag 存在；调研补充「`--include-partial-messages`/`--forward-subagent-text` 仅 `--print`+`stream-json`」（`claude-code.md:131`）、kimi「`-p` 与模式旗标互斥」（`kimi.md:106`） | **以调研的限制条件为准**（更细、可复跑）；需求基线 的 flag 清单只作能力存在性，不作为组合可用性 |
| C11 | opencode 凭据与模型口径 | 旧稿曾写「本机凭据不可用 → 端到端结论不能声称」；现行 `opencode.md:436`（§5 坑 1）已修正为「凭据存在、付费 key 过期、免费池可用」；调研 §4 第 11 行把路由判 ✅（原语齐全），矩阵按 D-019 判 🟡（生产默认模型当前不可用） | **口径分层、二者都对**：**能力存在性**以调研 ✅ 为准（路由原语齐全：`auth`/`-m`/`/api/session/{id}/model`/`set_config_option`）；**生产可用性**按 D-019 判 🟡（`opencode-go/deepseek-v4.1-flash` 401，需 Console 新建 key）；免费别名 `opencode/*-free` 按可用处理。禁止把「付费 key 过期」推广为「opencode 不可用」 |

## 5. 未决项（缺什么 / 谁补 / 施工阶段怎么补）

> 本节是唯一允许出现「尚未验证结论」的地方。**已从主矩阵全部剥离**，主矩阵不接受无证据结论。

| ID | 缺什么 | 谁补 | 施工阶段怎么补 | 矩阵当前处理 |
|---|---|---|---|---|
| U1 | `thread/start`（非 `ephemeral`）+ `turn/start` 的真实往返；冷恢复 kill→`thread/resume` 是否接同一 rollout | 适配器 codex 规格作者 + C4 | C4：1 个 turn，断言 `thread.ephemeral !== true` 且 `~/.codex/sessions` 新增 rollout；再 kill 进程后 `thread/resume` 断言 `thread.id` 不变（0.164.0 协议面已实测：`ClientRequest=106/ServerNotification=85/ServerRequest=10`，`thread/resume`、`turn/steer`、`thread/loaded/list`、`collabAgentToolCall` 均在） | 记 ✅（协议面已实测存在），风险入风险登记册 |
| U2 | codex 10 个 method 的 `ServerRequest` 自动应答能否让 turn 不挂起 | C4 | C4：`approvalPolicy: never` + `sandbox: read-only` 各跑 1 turn，观察是否仍出现 `ServerRequest` | 记 ✅ + 对策列已含「逐条自动应答」要求 |
| U3 | ~~codex 双基线兼容~~ **已关闭（D-015）**：基线统一 0.164.0，0.153.4 降为待升级旧载荷；残留仅「历史 rollout（`cli_version` 0.162/0.163/0.164 混写）迁移读取」 | 风险登记册 owner（施工阶段） | 升级前用旧二进制归档/导出会话；升级后用 0.164.0 `thread/read` 抽检样本会话，失败即标记「该会话不可恢复」 | 不再影响矩阵判定；`version-pinning` 只保留迁移残留标注 |
| U4 | `SendMessage` / `ListAgents` 的输入 schema（typings 无公开定义） | 适配器 claude-code 规格作者 + C5 | C5：跑 1 turn 读 `init.tools[]` 与 `tool_use` 入参；或抓二进制里的工具 JSON schema 串 | 记 ✅（存在性已实证），地址面依赖放 U4 之后 |
| U5 | `resume` + `forkSession:true` 的真实往返（会写盘，D1 按只读纪律未跑） | C5 | C5：新建 session → resume 1 turn → fork → 断言新 `sessionId` 且旧会话仍可读 | 记 ✅（API 已实跑），端到端待补 |
| U6 | claude 全局并发上限配置键是否存在 | C5 | 在 `resolveSettings()/Settings` 里 grep `agents\|concurren\|parallel`；或读 `--settings` schema | 记 🟡（`concurrency` 行） |
| U7 | ~~opencode 事件全集未回填~~ **已关闭（2026-10-26 深测）**：SSE 26 类事件已实测回填（`opencode.md:417`；逐条映射见 `docs/adapters/opencode.md:443` §5.2），CLI `--format json` 与 ACP chunk 级亦实测；**残留子项** = 工具事件 / 子会话事件 / 免费池 429 形态 | C7 | C7：按适配器 `§12.4` V-3/V-4/V-5 补测（HTTP build 读文件录 SSE、建父子会话、连续多轮记 `Retry-After`） | 记 ✅（`stream` 行）；残留三类属增量回填，不改主判定 |
| U8 | **ACP-only 面**：`session/request_permission` 形状（`options`/`kind`）与 `session/cancel` 是否存在（v2 主通道的对应能力已实测 ✅，见 `interrupt`/`permission-modes` 行） | C7 | ACP + build + 读 `.env` 触发审批抓请求；对 `cancel` 发未知方法观察 `-32601`（适配器 `§12.4` V-1/V-2） | 不再影响 `interrupt`/`permission-modes` 的主判定（v2 已 ✅）；仅补齐 ACP 兜底通道 |
| U9 | kimi 并发硬上限（`[experimental] tower`、`AgentSwarm` 是否有限制）；ACP 子代理扩展方法语义 | 适配器 kimi 规格作者 + C6 | 二进制 grep + 开关实验（tower 开/关各跑 2 并发），结果回写风险登记册 | 记 🟡（`concurrency` 行）；编排一律用兼容层闸门 |
| U10 | kimi `default_plan_mode = true` 下「headless 自动进入只读阶段且 `ExitPlanMode` 被自动批准」的行为边界 | C6 | C6：关掉该键各跑 1 turn 对比，断言无静默越权确认 | 记 🟡（`permission-modes` 行） |
| U11 | claude `permissionMode:'auto'` 分类器是否可离线/可控；`canUseTool.updatedPermissions` 回填语义 | C5 | C5：读 `auto-mode` 子命令 + 1 次 allow 后不再询问的实测 | 记 ✅（档位存在），策略可控性待补 |
| U12 | 四后端 CLI 与协议面的版本一致断言点（claude SDK+内置 CLI 无握手、codex 基线 0.164.0（D-015）、kimi 只能锁路径） | 集成方案作者 + C8 | C8：启动时收集 `--version` + 协议 `protocolVersion`/`claude_code_version` + codex schema 计数（106/85/10）写入注册表并断言 | 见派生表 B「未进位」三项 |
| U13 | `repro/run_all.sh` 全量复跑一致性（A11）：本文件引用的段号需随脚本演进同步 | 测试/验收作者 + D8 | D8：把矩阵里的 `repro/*.sh §N` 引用做成清单，由 `run_all.sh` 回归校验 | 本文件已按当前脚本段号引用（codex §1–§8、claude §1–§5c/§7、kimi §0–§8、opencode §0–§11） |
| U14 | opencode 付费 key 恢复：`opencode-go/deepseek-v4.1-flash` 当前 401 `api_key_expired`，重新登录不续期，需在 **OpenCode Console 新建 key**（D-019） | **用户**（阻塞项，非施工可代劳） | 用户新建 key → 重新 `opencode auth login` → `opencode run -m opencode-go/deepseek-v4.1-flash "只回复 OK"` 断言 rc=0；在此之前生产默认走 free 兜底并标 `degraded:"free-model"` | `auth-model-routing` 记 🟡（凭据存在但过期）；headless/stream/resume/session-list 已按免费模型实测记 ✅ |

## 6. 本机复核记录（本轮，可复跑）

```bash
# 1) 四后端版本（与调研文档一致）
codex --version                                                        # codex-cli 0.164.0（PATH）
~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --version  # 0.153.4（bundle）
~/.kimi-code/bin/kimi --version                                        # 2.3.1
claude --version                                                       # 2.1.310 (Claude Code) = 宿主线（另一条升级线；适配器基线用 SDK 内置 CLI 2.1.263）
~/.opencode/bin/opencode --version                                     # opencode v2.1.4

# 2) 「能力关在插件门内」的两条硬事实（对应 需求基线 §3）
grep -c 'ephemeral' ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js        # 7
grep -c -E 'persistSession|canUseTool' ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-claude-code/lib/index.js  # 2
python3 -c "import json,os;print(sorted(json.load(open(os.path.expanduser('~/.config/opencode/service.json'))).keys()))"  # ['password']：只列键名，不打印值

# 3) R2 复核（本轮新增；D-015 / D-016 / D-018 / D-019）
codex --version                                                        # 0.164.0 = 唯一基线（D-015）；bundle 内 0.153.4 = 待升级载荷
codex app-server generate-json-schema --out /tmp/cx-164                # 39 文件；ClientRequest=106 / ServerNotification=85 / ServerRequest=10
grep -n 'maxActiveSubagents' ~/.dsh/profiles/desktop/cordis.patch.yml  # 命中行 97 = 20（运行时来源；文档不写死，D-016）
~/.opencode/bin/opencode auth list                                     # OpenCode Go / GitHub Copilot 均 stored（D-018）
python3 -c "import json,os;print(sorted(json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json'))).keys()))"  # ['opencode-go']
~/.opencode/bin/opencode models | grep -E '^opencode/.*' | head        # 含 deepseek-v4.1-flash-free / glm-5.3-flash-free / big-pickle / beam-free

# 4) Lead 实测（2026-10-26，opencode 免费模型端到端；复跑会新建 session，属可接受副作用）
opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free   # rc=0；text=OK；sessionID=ses_e8c27271…（前缀脱敏）
opencode run -s <同一 sessionID> "上一条你回复了什么原文？"                              # 同 sessionID，正确复述 OK（D-018 续接证据）
opencode run -m opencode-go/deepseek-v4.1-flash "只回复 OK"                            # 401 api_key_expired（D-019，付费 key 过期）

# 5) R3 复核：opencode 三通道深测（适配器 owner，2026-10-26；免费模型零费用；证据源 = docs/research/opencode.md §3.12）
opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free     # rc=0；{"type":"text",…,"text":"OK"}
opencode run -s <同一 sessionID> "上一条你回复了什么原文？只回复那两个字符" \
        --format json -m opencode/deepseek-v4.1-flash-free                              # 同 sessionID → 真续接
# v2 HTTP（需 Basic：user=opencode，password 由 OPENCODE_SERVER_PASSWORD 注入；不读 service.json 明文）
#   POST /api/session                        建会话（model=opencode/deepseek-v4.1-flash-free）
#   POST /api/session/{id}/prompt            一轮 → 200
#   GET  /api/session/{id}                   outcome:"succeeded"、tokens{input,output,reasoning,cache}、cost:0
#   POST /api/session/{id}/interrupt?resume=true → {"interrupted":true} + SSE session.execution.interrupted{reason:"user"}（中断后再 prompt 成功）
#   POST /api/session/{id}/permission/{requestID}/reply {"decision":"once"} → 204（此前 GET /api/permission/request 可见 permission.asked）
#   GET  /api/event                          SSE 26 类事件全集（session.text/reasoning/step/usage/execution.* + permission.asked + inbox）
# ACP（兜底，已跑通 turn）：initialize → session/new → set_config_option{configId:"model"} → prompt → stopReason:"end_turn" + usage{…}
```

> 除上表外，本文件的全部结论以 `docs/research/{codex,claude-code,kimi,opencode}.md` 的可复跑证据为准，统一由
> `repro/probe-{codex,claude,kimi,opencode}.sh` 复现（只读/幂等/零额度；`PROBE_LIVE=1` 才消耗额度）。
> 结论与实测冲突时以实测为准，并在本文件与本行标注冲突点。
