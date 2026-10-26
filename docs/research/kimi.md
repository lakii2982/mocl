# kimi-code 2.3.1 —— 后端调研（MOCL / D2）

> 标记约定：`[实测]` = 本机命令跑出来并贴了输出；`[文档]` = 官方文档/帮助文本原文；`[推断]` = 由字符串/结构推得，未直接验证；`TO-VERIFY` = 缺证据。
> 凭据纪律：本文件只出现配置**键名**，不出现任何 key/token 值。

## 1. 结论摘要（给上层设计的输入事实）

1. **kimi 的原生面就两套**：CLI prompt 模式（`-p` + `--output-format stream-json`，**消息级** JSONL）与 **ACP over stdio**（**token 级**分段增量）。二者事件粒度差一个数量级，适配器必须分开建模。[实测]
2. ACP 是**能力最全**的面：`initialize` / `session/new|load|list|fork|prompt|set_mode|set_config_option|set_model|request_permission` 全可用，且**同一 session 可连续多次 `session/prompt`**——"外部后端一次性"是 DSH 适配层限制，不是 kimi/ACP 的限制。[实测]
3. **唯一硬缺口：没有中断**。ACP `session/cancel` 返回 `-32601 Method not found`；CLI 无 interrupt 子命令。中断只能杀进程。[实测-否定]
4. **最大坑：ACP 客户端必须实现 `fs/read_text_file`**。不实现时 `session/prompt` 会**永久静默挂住**（无错误、无超时）。[实测]
5. **权限语义命名陷阱**：CLI `-y/--yolo` 的实际语义是"Ask When Needed"（≈ ACP `auto`），CLI `--auto` 才是"Never Ask"（≈ ACP `yolo`）。名字与语义错位，按名字映射必错。[实测]

## 2. 版本与安装路径

| 项 | 值 | 证据 |
|---|---|---|
| 版本 | `2.3.1` | `kimi --version` |
| 二进制 | `/Users/lakii2982/.kimi-code/bin/kimi`，189,674,560 B，2026-10-24 00:02 | `ls -l` |
| 用户配置 | `~/.kimi-code/config.toml`（4786 B） | `kimi doctor` → `OK config.toml` |
| TUI 配置 | `~/.kimi-code/tui.toml` | 同上 |
| 会话存储 | `~/.kimi-code/sessions/wd_<workspace>_<hash>/session_<uuid>/` | `kimi session list --json` 的 `sessionDir` |
| 诊断日志 | `~/.kimi-code/logs/kimi-code.log` + 每会话 `logs/kimi-code.log` | 报错信息里的 "See log:" 路径 |
| 凭据 | `~/.kimi-code/credentials/`、`oauth/`、`server.token`（存在性，**未读取内容**） | `ls -la ~/.kimi-code/` |
| 平台 | macOS arm64 | BRIEF §6 |

```
$ ~/.kimi-code/bin/kimi --version
2.3.1
$ ~/.kimi-code/bin/kimi doctor
Kimi doctor
OK config.toml  /Users/lakii2982/.kimi-code/config.toml
OK tui.toml     /Users/lakii2982/.kimi-code/tui.toml
All checked config files are valid.
```

## 3. 证据（命令 + 关键输出摘要）

### 3.1 CLI 子命令面 `[实测]`

```
$ kimi --help
  -S, --session [id]      Resume a session. With ID: resume that session. Without ID: interactively pick.
  -c, --continue          Continue the previous session for the working directory.
  -y, --yolo              Start in Ask When Needed mode: routine edits and commands run automatically; risky actions, questions, and plans still ask.
  --auto                  Start in Never Ask mode: never interrupts you; everything runs and is decided automatically.
  -m, --model <model>     LLM model alias. Defaults to default_model in config.toml.
  -p, --prompt <prompt>   Run one prompt non-interactively and print the response.
  --output-format <format>  choices: "text", "stream-json"
  --skills-dir <dir>      Load skills from this directory instead of auto-discovered dirs.
  --agent <name>          Agent profile ... Cannot be combined with --session/--continue.
  --agent-file <path>     Load an agent definition from a Markdown file ...
  --add-dir <dir>         Add an additional workspace directory for this session.
  --plan                  Start in plan mode.
Commands: export, fork, provider, session, acp, web, server(deprecated), rc|remote, login,
          doctor, vis, install-desktop, app, migrate, upgrade|update
```

```
$ kimi acp --help
Usage: kimi acp [options]
Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
Options:
  --login            Run the device-code login flow then exit (entry point for ACP terminal-auth).
  --region <region>  "mainland-cn" (kimi.com) or "global" (kimi.ai).
```
→ **`kimi acp` 无任何传输/端口参数**，固定 stdio；无 `--cwd`，工作目录继承进程 cwd（`session/new` 的 `cwd` 参数才是权威）。

```
$ kimi session --help     # 子命令只有 list
$ kimi session list --help
  --cwd <path>   List sessions of this working directory. Defaults to current directory.
  --all          List sessions across every workspace.
  --archived     Include archived sessions.
  --limit <n>    Print at most n sessions.
  --json         Emit the session summaries as JSON.
$ kimi fork --help
  Arguments: sessionId   Session id to fork. Defaults to the most recent session.
  --cwd <path>  -y, --yes
$ kimi export --help
  -o, --output <path>   -y, --yes   --no-include-global-log
$ kimi provider --help
  add <url> | remove <providerId> | list | catalog
```

### 3.2 权限模式：CLI 旗标 vs ACP 模式 id `[实测]`（关键）

| CLI 旗标 | 帮助原文语义 | 对应 ACP mode id |
|---|---|---|
| （默认） | Manual approvals | `default` |
| `--plan` | Start in plan mode | `plan`（Read-only planning; no tool execution） |
| `-y, --yolo` | **Ask When Needed**：routine edits 自动跑，risky actions/questions/plans 仍问 | `auto`（Auto-approve safe operations） |
| `--auto` | **Never Ask**：永不打断 | `yolo`（Auto-approve everything） |

`session/new` 返回的 `modes.availableModes`（原文）：

```json
[{"id":"default","name":"Default","description":"Manual approvals; tools execute normally."},
 {"id":"plan","name":"Plan","description":"Read-only planning; no tool execution."},
 {"id":"auto","name":"Auto","description":"Auto-approve safe operations."},
 {"id":"yolo","name":"YOLO","description":"Auto-approve everything."}]
```

**= 名字对不上**：CLI 的 `yolo` → ACP 的 `auto`；CLI 的 `auto` → ACP 的 `yolo`。适配器必须按**语义**映射，不能按名字透传。

**`-p` 与三种模式旗标互斥** `[实测]`：

```
$ kimi -p "只回复 OK" --auto   ; echo $?
error: Cannot combine --prompt with --auto.
1
$ kimi -p "只回复 OK" -y       ; echo $?   # → Cannot combine --prompt with --yolo.
$ kimi -p "只回复 OK" --plan   ; echo $?   # → Cannot combine --prompt with --plan.
```
→ headless 的权限档位**只能由 config.toml 的 `default_permission_mode` 决定**，命令行改不了。本机该键 = `"auto"`（config.toml:2）。

### 3.3 内置 agent profile（原生子代理入口）`[实测]`

用未知 profile 反查可用集（无副作用、零额度）：

```
$ kimi --agent __probe_none__ -p "x" ; echo $?
kimi version 2.3.1
error: failed to run prompt: Unknown agent profile: "nope". Available profiles: plan, agent, coder, explore, tower-worker
1
```
→ 内置 5 个：`plan`（只读规划）、`agent`（中性通用）、`coder`（软件工程，默认）、`explore`（只读探索）、`tower-worker`（与 config.toml:179 `[experimental] tower = true` 对应）。

`--agent-file` 是 **Markdown + YAML frontmatter**，实测可加载 `[实测]`：

```markdown
---
name: ag-test
description: probe agent for MOCL research
model: deepseek/deepseek-flash
tools: Read, Glob
---
You are a probe agent. Reply just OK.
```
```
$ kimi --agent-file /tmp/ag-test.md -p "只回复 OK" --output-format stream-json
{"role":"meta","type":"system.version","version":"2.3.1"}
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_c19e5f2f-...","command":"kimi -r session_c19e5f2f-..."}
```
自定义 agent 的发现目录：`~/.kimi-code/agents/`（二进制字符串 `.kimi-code/agents` 存在；本机该目录**尚未创建**）`[实测-字符串]`。
`--agent-file` 文件不存在 → `Failed to read agent file "...": ENOENT`，退出码 1。`[实测]`

会话落盘的**原生多代理痕迹** `[实测]`：每个会话目录下 `agents/main` 为主代理，子代理是 `agents/agent-0`、`agent-1` …（真实存在的历史会话里最多观察到 `agent-19`）：

```
$ ls -d ~/.kimi-code/sessions/*/*/agents/* | sed 's#.*/agents/#agents/#' | sort | uniq -c | sort -rn | head
  21 agents/agent-0
  18 agents/agent-1
   6 agents/agent-10
   ...
```

### 3.4 config.toml 键名（值全部脱敏）`[实测]`

行号来自本机 `~/.kimi-code/config.toml`（4786 B）：

```
 1: default_model = "kimi-code/k3.1-pro"
 2: default_permission_mode = "auto"
 3: default_plan_mode = true
 5: [providers."managed:kimi-code"]     6: type="kimi"  7: api_key=<REDACTED>  8: base_url=...
10: [providers."managed:kimi-code".oauth]  11: storage="file"  12: key=<REDACTED>
14: [providers.zai]        15: base_url  16: type="openai"       17: api_key=<REDACTED>
19: [providers.deepseek]   20: base_url  21: type="openai_responses"  22: api_key=<REDACTED>
24: [providers."OpenCode Go"]  25: type="openai"  26: api_key=<REDACTED>
28: [models."zai/glm-5.3"]  provider / model / max_context_size / capabilities /
                           display_name / reasoning_key / support_efforts / default_effort
48: [models."kimi-code/kimi-for-coding"]  ... 同样键 + capabilities / support_efforts
91: [models."kimi-code/k3.1-pro"]         ... 同上
117: [thinking]           118: enabled=true      119: effort="max"
121: [services.moonshot_search]  122: base_url  123: api_key  125: [services.moonshot_search.oauth]
129: [services.moonshot_fetch]   ... 同结构
137: [[permission.rules]]  138: decision="allow"  139: scope="user"  140: pattern="Read"
     后续 [[permission.rules]]：allow Grep / allow Glob /
     ask "Bash(rm * *)" / ask "Bash(git push*)" / ask "Edit(*AGENTS.md*)" /
     ask "Edit(*.kimi-code/config.toml*)" / ask "Edit(*.gitignore*)"
177: [experimental]  178: secondary-model=true  179: tower=true  180: notify_user=true
182: [secondary_model]  183: default_effort="max"  184: default_model  185: model
```

**键名小结（适配器配置映射用）**
- provider：`providers.<id>.{type, base_url, api_key, oauth.{storage,key}}`，`type ∈ {kimi, openai, openai_responses}`
- model 别名：`models."<provider>/<model>".{provider, model, max_context_size, capabilities[], display_name, reasoning_key, support_efforts[], default_effort}`
- 全局默认：`default_model`、`default_permission_mode`、`default_plan_mode`
- 推理：`[thinking].{enabled, effort}`；副模型：`[secondary_model]`、`[experimental].secondary-model`
- 权限规则：`[[permission.rules]].{decision ∈ allow|ask|deny, scope, pattern}` —— pattern 形如 `Read`、`Bash(git push*)`、`Edit(*AGENTS.md*)`
- `capabilities` 取值实测见过：`thinking`、`always_thinking`、`image_in`、`video_in`、`tool_use`、`dynamically_...`（截断）

### 3.5 ACP over stdio：`initialize` 握手 `[实测]`

客户端：`protocolVersion: 1`，`clientCapabilities: {fs:{readTextFile,writeTextFile}, terminal:true}`，`clientInfo:{name:"mocl-probe",version:"0.0.1"}`。
服务端响应（原文，一次成型）：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {"image": true, "audio": false, "embeddedContext": true},
    "sessionCapabilities": {"list": {}, "resume": {}, "close": {}, "delete": {},
                            "fork": {}, "additionalDirectories": {}},
    "mcpCapabilities": {"http": true, "sse": true},
    "auth": {"logout": {}}
  },
  "authMethods": [{"id":"login","type":"terminal","name":"Login with Kimi account",
                   "description":"Open the device-code login flow in a terminal.",
                   "args":["--login"], "env": {},
                   "_meta":{"terminal-auth":{"type":"terminal","label":"Login with Kimi account",
                            "command":"/Users/lakii2982/.kimi-code/bin/kimi",
                            "args":["login"],"env":{}}}}],
  "agentInfo": {"name":"Kimi Code CLI","version":"2.3.1"}
}}
```

要点：
- `protocolVersion` 支持值 = **1**（客户端发 1 被接受）。
- `authMethods` 只有 **terminal 设备码登录**（无 API-key 型 auth method）→ 无人值守必须**预先登录**，运行期无法在 ACP 内完成认证。
- `agentCapabilities.auth.logout` 存在 → 支持登出。
- `mcpCapabilities.sse = true`（对比 opencode 为 false）。
- 传输：**newline-delimited JSON-RPC 2.0 over stdin/stdout**，无 Content-Length 头 `[实测]`。

### 3.6 ACP 会话生命周期方法 `[实测]`

| 方法 | 参数 | 结果 | 备注 |
|---|---|---|---|
| `session/new` | `{cwd, mcpServers:[]}` | `{sessionId, configOptions[model,thinking,mode], modes{currentModeId,availableModes}}` | `sessionId` 形如 `session_<uuid>` |
| `session/load` | `{sessionId, cwd, mcpServers}` | `{configOptions}` | 续接既有会话 |
| `session/list` | `{cwd}` | `{sessions:[{sessionId,cwd,title,updatedAt}]}` | 只返回该 cwd 的会话 |
| `session/fork` | `{sessionId, cwd}` | `{sessionId, configOptions}` | 新 id，继承 model |
| `session/set_mode` | `{sessionId, modeId}` | `{}` | 实测 `modeId:"plan"` → `-32603 Internal error {"details":"Already in plan mode"}`（见 §4 坑 3） |
| `session/set_config_option` | `{sessionId, configId, value}` | `{configOptions}` | `configId ∈ model/thinking/mode`；`value:"yolo"` 生效 |
| `session/set_model` | `{sessionId, modelId}` | `{}` | 实测切 `deepseek/deepseek-flash` 后 `currentValue` 随之变化 |
| `session/prompt` | `{sessionId, prompt:[{type:"text",text}]}` | `{stopReason:"end_turn"}` | 可**同 session 连续多次**调用 |
| `session/cancel` | — | `-32601 "Method not found": session/cancel` | **不支持中断** |
| 未知方法 | — | `-32601 "Method not found": <m>` | 错误码规范 |
| 未知 sessionId | — | `-32602 Invalid params: Unknown sessionId: X`（`data.sessionId` 回带） | 错误分类可用 |

**同 session 连续两轮（continuable 的关键证据）**：

```
$ ACP_CWD=/tmp/kt python3 acp_multi.py ~/.kimi-code/bin/kimi acp
sid: session_706c84c0-c281-4930-aec1-5efb6820b0ed
prompt3 -> {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
prompt4 -> {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}
```
→ 一个 ACP 进程内，一个 session 可承载**多轮** prompt/answer，历史自动累积。

### 3.7 ACP `session/update` 通知类型（实测全集）

一次「读取文件并回答」的 turn 中实际收到 `[实测]`：

| `sessionUpdate` | 形状（节选） | 粒度 |
|---|---|---|
| `available_commands_update` | `{availableCommands:[{name,description,input?}]}` | session/new 后一次；实测 13 条 slash command（compact/status/usage/mcp/tasks/help/check-kimi-code-docs/import-from-cc-codex/mcp-config/sub-skill* /update-config …） |
| `session_info_update` | `{"title":"只回复 OK"}` | 每轮一次 |
| `current_mode_update` | `{"currentModeId":"default"}` | 模式变更 |
| `config_option_update` | `{configOptions:[...]}` | set_config_option 后 |
| `agent_thought_chunk` | `{"content":{"type":"text","text":"I"}}` | **逐 fragment**，一句思考拆成 161 条 |
| `agent_message_chunk` | `{"content":{"type":"text","text":"OK"}}` | 逐 fragment |
| `tool_call` | `{toolCallId,title:"Read",kind:"read",status:"pending",content:[{type:"content",content:{type:"text",text:""}}]}` | 工具调用开始 |
| `tool_call_update` | `{toolCallId,status:"in_progress"/"completed",title:"Invoke skill …",kind,rawInput:{...},rawOutput:"...",content:[...]}` | 参数流式回显 + 结果 |
| `usage_update` | `{"used":36996,"size":1000000}` | 每轮末 |

`kind` 实测取值：`read`、`other`（未穷举）。`toolCallId` 形如 `0:tool_<id>` / `0:call_<id>`。

### 3.8 ACP 权限请求 `session/request_permission` `[实测]`

服务端→客户端的反向请求，原文：

```json
{"jsonrpc":"2.0","id":<n>,"method":"session/request_permission","params":{
  "sessionId":"session_8be3d706-...",
  "toolCall":{"toolCallId":"0:call_00_FVDB0IF4I9nJAS0v86Tr9456","title":"Write",
              "content":[{"type":"content","content":{"type":"text",
                          "text":"Requesting approval to Writing perm-probe.txt"}}]},
  "options":[
    {"optionId":"approve_once","name":"Approve once","kind":"allow_once"},
    {"optionId":"approve_always","name":"Approve for this session","kind":"allow_always"},
    {"optionId":"reject","name":"Reject","kind":"reject_once"}
  ]}}
```
客户端回 `{"outcome":"selected","optionId":"reject"}` → turn 继续并 `stopReason:"end_turn"`，**目标文件确实未创建**（`ls perm-probe.txt` 报 no such file）→ 拒绝被真实尊重。`[实测]`

> `session/request_permission` 在 `initialize` 后即出现，无需先声明权限能力；`kind` 只有 `allow_once/allow_always/reject_once` 三种。

### 3.9 **客户端必须实现 `fs/read_text_file`**（最重要的坑）`[实测]`

同一个 prompt（"只回复 OK"）两种情况：

```
# A. 客户端不回应 fs/read_text_file
update kinds: {"available_commands_update":1,"session_info_update":1}
prompt_response: <none / timeout>          ← 静默挂住，无错误、无超时

# B. 客户端实现 fs/read_text_file
client_requests: ["fs/read_text_file"]
update kinds: {"available_commands_update":1,"session_info_update":1,
               "agent_message_chunk":1,"usage_update":1}
prompt_response: {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}
```
→ ACP 客户端必须实现 `fs/read_text_file`（至少读，`writeTextFile` 未触发但已声明），否则任何 prompt 都会挂死。挂死时 kimi 侧**不报错、不超时**，只能由客户端设超时自杀。

### 3.10 `-p --output-format stream-json` 的事件形状 `[实测]`

三种事件，全部单行 JSON，`role` 区分通道：

```json
{"role":"meta","type":"system.version","version":"2.3.1"}
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_69e190c8-...",
 "command":"kimi -r session_69e190c8-...","content":"To resume this session: kimi -r ..."}
```

带工具调用时（`-p "读取 a.txt 并告诉我内容"`）：

```json
{"role":"assistant","tool_calls":[{"type":"function","id":"tool_TYBjxkSqtCaGjxQ3YAb07o5J",
  "function":{"name":"Skill","arguments":"{\"skill\":\"superpowers:using-superpowers\"}"}}]}
{"role":"tool","tool_call_id":"tool_TYBjxkSqtCaGjxQ3YAb07o5J","content":"Skill \"...\" loaded inline. ..."}
{"role":"assistant","tool_calls":[{"type":"function","id":"tool_L14u...",
  "function":{"name":"Read","arguments":"{\"path\":\"a.txt\"}"}}]}
{"role":"tool","tool_call_id":"tool_L14u...","content":"1\thello-marker"}
{"role":"assistant","content":"`a.txt` 的内容是“hello-marker”。"}
```

**粒度结论**：`stream-json` 是**消息级**（一条 assistant 消息一个事件、一个 tool_call 一个事件），**没有 token delta**；token 级增量只在 ACP 面。`arguments` 是**字符串化的 JSON**（需二次解析）。

### 3.11 会话 / fork / export / 续接 实测

```
$ kimi -r session_cd737e9e-... -p "只回复 OK" --output-format stream-json   # -r 可用（resume_hint 里给出的写法）
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_cd737e9e-..."}   # 同一个 id → 真续接
$ kimi -S session_cd737e9e-... -p "只回复 OK"                                # -S 等价，同一 id
$ kimi -c -p "只回复 OK"                                                     # 继续本 cwd 最近会话
$ kimi fork session_cd737e9e-... -y
Forked to session_178985ae-a5b4-4343-b749-4e109aae6775 ("Fork: session_cd737e9e-...") in 321ms
$ kimi export session_cd737e9e-... -o /tmp/kt-export.zip -y
/tmp/kt-export.zip            # 113,023 B
$ kimi session list --json   # id / workDir / sessionDir / createdAt / updatedAt / archived / metadata / lastTurnReason
$ kimi session list --limit 3
2026-10-25 21:34  session_cd737e9e-8861-46de-a6b1-09e58dceca2e
```
`-c` 单轮耗时实测 `elapsed_ms=5324`（`kimi-code/k3.1-pro`，`只回复 OK`，含恢复会话开销）。

### 3.12 工具扩展面 `[实测-文件]`

- **plugin**：`~/.kimi-code/plugins/{installed.json,managed/}`，managed 下 4 个：`kimi-cu`、`kimi-datasource`、`kimi-webbridge`、`superpowers`；每个含 `kimi.plugin.json` + `skills/` + 可选 `bin/`（如 `kimi-cu-mcp`）。
- **skill**：`--skills-dir <dir>` 可重复覆盖自动发现目录；本机 `~/.kimi-code/skills` 为空；实际生效的 skill 来自插件（`superpowers:*` 在每次 prompt 中自动被 `Skill` 工具加载）。
- **MCP**：`~/.kimi-code/mcp.json`（顶层键 `mcpServers`）；ACP 面在 `session/new` 的 `mcpServers` 参数注入，`mcpCapabilities {http:true, sse:true}`。
- **slash command**（ACP `available_commands_update`）：`compact`、`status`、`usage`、`mcp`、`tasks`、`help`、`check-kimi-code-docs`、`import-from-cc-codex`、`mcp-config`、`sub-skill`、`sub-skill.consolidate`、`sub-skill.review`、`update-config`（另可能还有截断项）。

## 4. 能力清单（15 项，与 `tools/check_docs.py` CAPABILITIES 对齐）

| # | 能力 | 结论 | 证据（可复跑命令 / 路径） | 标记 |
|---|---|---|---|---|
| 1 | `headless` | ✅ | `kimi -p "只回复 OK" --output-format stream-json` → 3 行事件、退出码 0；成功 rc=0，参数冲突 rc=1 | [实测] |
| 2 | `stream` | ✅ 两档粒度 | CLI：消息级 JSONL（role=meta/assistant/tool）；ACP：token 级 `agent_thought_chunk`/`agent_message_chunk`（一turn实测 161 条 fragment） | [实测] |
| 3 | `resume` | ✅ | `kimi -S <id>` / `kimi -r <id>` / `-c`；ACP `session/load`；同 session 连续 2 次 prompt 均 `stopReason:end_turn` | [实测] |
| 4 | `fork` | ✅ | `kimi fork <id> -y` → `Forked to session_178985ae-...`；ACP `session/fork` → 新 `sessionId`，继承 model | [实测] |
| 5 | `session-list` | ✅ | `kimi session list [--json|--all|--cwd|--limit|--archived]`；ACP `session/list` → `{sessionId,cwd,title,updatedAt}` | [实测] |
| 6 | `interrupt` | ❌ **无** | ACP `session/cancel` → `-32601 Method not found`；`kimi --help` 无 interrupt；只能 SIGTERM 杀进程（实测 `exit=-15`） | [实测-否定] |
| 7 | `native-subagents` | ✅ | 内置 profile `plan/agent/coder/explore/tower-worker`（`--agent __probe_none__` 报错反查）；磁盘 `sessions/*/*/agents/{main,agent-N}`（观测到 `agent-19`）；`--agent-file` Markdown+frontmatter | [实测] |
| 8 | `tool-extension` | ✅ | `~/.kimi-code/plugins/managed/{kimi-cu,kimi-datasource,kimi-webbridge,superpowers}`；`--skills-dir`；`~/.kimi-code/mcp.json` 键 `mcpServers`；ACP 命令 `mcp-config` | [实测-文件] |
| 9 | `permission-modes` | ✅ 4 档 | ACP `modes.availableModes = default/plan/auto/yolo`；CLI `-y/--yolo`、`--auto`、`--plan`；`session/request_permission` 3 选项；拒绝对文件生效 | [实测] |
| 10 | `sandbox` | ❌ 无 OS 级沙箱 | 二进制中 `sandbox-exec`/`seatbelt`/`landlock`/`bubblewrap` 命中数均为 0；隔离仅靠 `[[permission.rules]]` + plan 只读模式 + `--add-dir` 目录集合 | [实测-否定] |
| 11 | `auth-model-routing` | ✅ | `[providers.<id>]`/`[models."<p>/<m>"]` 键；`kimi provider add/remove/list/catalog`；`-m/--model`；ACP `session/set_model` 实测把 `currentValue` 从 `kimi-code/k3.1-pro` 切到 `deepseek/deepseek-flash` | [实测] |
| 12 | `concurrency` | ⚠️ 未发现硬上限配置 | 单进程可并发多 session；子代理并发由模型决策，`AGENTS.md` 有 `AgentSwarm` 描述（用户配置，非产品契约）；**无** `maxConcurrent*` 类配置键实测到 | [实测-部分] / TO-VERIFY |
| 13 | `usage-observability` | ✅ | ACP `usage_update {"used":36996,"size":1000000}`；slash command `usage`/`status`；每会话 `state.json` + `logs/kimi-code.log`；`kimi session list --json.lastTurnReason` | [实测] |
| 14 | `structured-protocol` | ✅ | ACP（JSON-RPC 2.0 / newline-delimited / protocolVersion=1，能力位见 §3.5）；错误码 `-32601/-32602/-32603` 均实测命中；`--output-format stream-json` | [实测] |
| 15 | `version-pinning` | ⚠️ 只能锁二进制 | `kimi --version` → `2.3.1`；`kimi upgrade [-y]` **只支持升到 latest，无版本参数**；实际锁定手段 = 固定 `~/.kimi-code/bin/kimi` 路径/副本 | [实测] |

## 5. 限制与已知坑

1. **ACP 客户端不实现 `fs/read_text_file` → prompt 静默挂死**（§3.9）。无错误、无超时；必须客户端侧硬超时。
2. **`-p` 与 `--auto`/`-y`/`--plan` 互斥**（rc=1），headless 权限档位只能由 `config.toml: default_permission_mode`（本机 `"auto"`）决定 → 想"无人值守且最严"必须改配置文件，不能只改命令行。
3. **`default_plan_mode = true` 会让 prompt 会话从 plan 模式起步**，且实测 `ExitPlanMode` 被**"auto-approved without user review"**，并在会话目录写 `agents/main/plans/*.md`。headless 下这是"看不见的只读阶段 + 自动越权确认"，必须显式关掉或识别。
4. **`session/new` 返回的 `modes.currentModeId` 不可作为权威快照**：实测返回 `"default"`，紧接着 `session/set_mode("plan")` 却报 `-32603 "Already in plan mode"`。适配器应以 `current_mode_update` 通知为准。TO-VERIFY：关闭 `default_plan_mode` 后的行为。
5. **无中断能力**：`session/cancel` 不存在；唯一停止方式是杀进程，代价是丢失该 turn 状态（且 ACP 进程内其他 session 一并死掉）。
6. **token 级增量会淹没父会话**：一句思考 = 161 条 `agent_thought_chunk`；`tool_call_update` 还会把 `arguments` 逐字符回显（实测 `{"path":"a` → `{"path":"a.txt"`）。必须按 toolCallId 折叠/限流。
7. **每次 prompt 自动加载 superpowers skill**：即使用户只说"只回复 OK"，也会先发 `Skill` 工具调用；headless 计费/时延与"干净基线"不同。
8. **错误路径会写坏 state**：连续在 `/tmp` 跑 `--agent nope` 时有报告 `[unexpected] StorageError: storage append failed: path does not exist`（一次、不可稳定复现）→ 会话目录不存在时状态追加失败。TO-VERIFY。
9. `session/list` 只按传入/继承 cwd 过滤，跨工作区需 `--all`（CLI）或显式传 `cwd`（ACP）。

## 6. ACP 适配器实现要点（给 D4/D5 的直接输入）

1. 传输：spawn `kimi acp`，stdin/stdout 逐行 JSON-RPC2；**不要**等 Content-Length 头。
2. 必须实现的反向方法：`fs/read_text_file`（必需）、`fs/write_text_file`（已声明，建议实现）、`terminal/*`（`clientCapabilities.terminal=true` 时可能被调用，实测未触发）。
3. 必须实现的正向通知：`session/request_permission` → 自动策略（无人值守默认 `reject`）。
4. 超时：`session/prompt` 无内置超时 → 客户端必须自己设（建议 ≥180s，因 `thinking.effort=max` 单轮可达分钟级）。
5. 中断 = `SIGTERM` 整个 ACP 子进程；无法只中止单个 turn → 会话代理需为每个并发任务**独立进程**。
6. 权限模式按**语义**映射：ABI 的 `read-only` → ACP `plan`；`safe-auto` → ACP `auto`；`yolo` → ACP `yolo`；`ask` → ACP `default`。**不要**把 CLI 的 `-y/--yolo` 映射到 ACP `yolo`。
7. 模型/推理切换走 `session/set_config_option`（`configId ∈ model|thinking|mode`），`session/set_model` 也可用但 ACP 标准里不是所有后端都实现（opencode 就缺，见 `docs/research/opencode.md`）。
8. 续接：持久化 `sessionId` + `cwd`，重连后 `session/load` 即可继续；fork 用 `session/fork`。

## 7. 复跑命令块

```bash
# 全量只读探测（约 5s，退出码 0）
bash repro/probe-kimi.sh

# 带 ACP 会话级方法（会写 ~/.kimi-code/sessions）
PROBE_ACP_SESSION=1 bash repro/probe-kimi.sh

# 带真实模型调用（消耗额度）
PROBE_LIVE=1 bash repro/probe-kimi.sh

# 单独跑 ACP 握手
python3 - "$HOME/.kimi-code/bin/kimi" <<'PY'
import json, subprocess, sys, threading, time
p = subprocess.Popen([sys.argv[1], "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
out = []
threading.Thread(target=lambda: [out.append(l) for l in p.stdout if l.strip()], daemon=True).start()
p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {"protocolVersion": 1,
             "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True},
             "clientInfo": {"name": "probe", "version": "0"}}}) + "\n")
p.stdin.flush()
t0 = time.time()
while time.time() - t0 < 15 and not out:
    time.sleep(0.05)
print(out[0] if out else "NO RESPONSE")
p.terminate()
PY

# 权限模式语义（原文）
~/.kimi-code/bin/kimi --help | grep -A3 -E '^\s+(--auto|--plan|-y, --yolo)'

# 内置 agent profile 清单（零额度）
~/.kimi-code/bin/kimi --agent __probe_none__ -p x 2>&1 | head -3

# 原生子代理落盘痕迹
ls -d ~/.kimi-code/sessions/*/*/agents/* | sed 's#.*/agents/#agents/#' | sort | uniq -c | head

# 会话面
~/.kimi-code/bin/kimi session list --limit 3
~/.kimi-code/bin/kimi session list --limit 2 --json

# 无 OS 沙箱的否定证据
grep -a -c -E 'sandbox-exec|seatbelt|landlock|bubblewrap' ~/.kimi-code/bin/kimi   # → 0
```

## 8. 未决项

- **TO-VERIFY（并发上限）**：未找到 kimi 侧"最大并发子代理/会话"的配置键；`[experimental] tower`、`AgentSwarm` 是否有硬上限未知。
- **TO-VERIFY（ACP 子代理扩展）**：二进制含 `session/subagent/spawn|run|config|mirror|flag` 字符串，但 ACP 实测未暴露这些方法 → 语义未知，不可依赖。
- **TO-VERIFY（未登录机器）**：本机已登录；`authMethods` 只有 terminal 设备码，未验证"未登录时 `session/prompt` 的错误码"。
- **TO-VERIFY（`approve_always` 的持久化范围）**：只在 session 内还是写回 `permission.rules`。
- **TO-VERIFY（`StorageError`）**：§5 坑 8 的触发条件。
- **TO-VERIFY（`--output-format text` 混入思考文本）**：实测 `-p` 文本模式输出了思考要点（"• Kimi needs to respond only OK…"），是否属 `thinking.enabled=true` 的可关行为未验证。

## 9. 来源

- 本机二进制帮助文本与 `--version`、`~/.kimi-code/config.toml`（键名）、`~/.kimi-code/sessions/`（目录结构）。
- ACP 协议语义：Zed Agent Client Protocol（`protocolVersion` / `session/*` / `session/request_permission` 命名与 kimi 实测响应一致）——本文件所有协议字段均以**实测响应**为准，未引用未验证的第三方描述。
- 官方文档站（帮助文本末尾给出）：<https://moonshotai.github.io/kimi-code/> ——本次**未**抓取正文，故本文不引用其条文（无 [文档] 级断言依赖它）。
