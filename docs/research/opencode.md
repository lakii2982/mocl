# opencode 2.1.4 —— 后端调研（MOCL / D2）

> 标记约定：`[实测]` = 本机命令跑出来并贴了输出；`[文档]` = 官方文档原文（附 URL）；`[推断]` = 由字符串/结构推得；`TO-VERIFY` = 缺证据。
> 凭据纪律：本文件只出现 provider 名与配置**键名**，不出现任何 key/token/password 值。

## 1. 结论摘要（给上层设计的输入事实）

1. opencode 有两个可编程面：**ACP over stdio**（适合当 DSH 子级）与 **v2 HttpApi（OpenAPI 3.1，124 个端点）+ SSE**（适合当常驻服务/控制面）。**v2 面比 ACP 面强得多**，尤其是有 `interrupt`、`inbox`（运行中追加输入）、`fork`、`permission.reply`、`pty`、`worktree`。[实测]
2. **原生子代理是真的**：内置 `general`/`explore` 两个 subagent + `build`/`plan` 两个 primary + 3 个隐藏 primary；子代理经 `task` 工具与 `permission.task` 调度；ACP 侧还额外声明 `_meta:{"opencode/child-session-updates":true}`，二进制含 `parentSessionID`/`childSessionID`/`childSessionUpdates`。[实测 + 文档]
3. **有中断**（`POST /api/session/{sessionID}/interrupt`，甚至带 `resume=true|false`），这是 kimi 没有的能力。[实测 OpenAPI]
4. **凭据存在，付费套餐 key 过期，免费模型池完全可用（2026-10-26 复测修正）**：`~/.local/share/opencode/auth.json` 有 `opencode-go`（`type=api`，key `oc_s…` 51 字符），`opencode auth list` 显示 `OpenCode Go / API key stored` + `GitHub Copilot / stored`。付费默认模型 `opencode-go/deepseek-v4.1-flash` 仍报 401 `api_key_expired`（**重新登录不续期**，须到 Console 新建 key 后替换）；但内置免费池 `opencode/*-free` 的 CLI `run`、`-s` 续接、HTTP v2 建会话/一轮/中断/权限应答、ACP `initialize→session/new→set_config_option→prompt` **均已本机跑通**（§3.12）。→ 结论：opencode **默认可用（`enabled:true`）**；付费模型需有效 key，缺 key 时降级到免费同模型且必须显式可见（不得静默）。[实测 2026-10-26]
5. **文档与实现脱节**：官方文档描述的是 v1（`/session`、`/event`、`/agent`、`POST /session/:id/abort`），而 2.1.4 实际暴露的是 v2（`/api/...`）。`GET /doc` 返回的是 SPA HTML 而非 OpenAPI；真 spec 在 `GET /openapi.json`。[实测 + 文档]

## 2. 版本与安装路径

| 项 | 值 | 证据 |
|---|---|---|
| 版本 | `opencode v2.1.4` | `opencode --version` |
| 二进制 | `/Users/lakii2982/.opencode/bin/opencode`，214,407,424 B，mtime 显示 `Oct 26 1985`（固定时间戳/可复现构建痕迹） | `ls -l` |
| 全局配置目录 | `/Users/lakii2982/.config/opencode` | `opencode debug paths` |
| 配置文件 | `~/.config/opencode/opencode.jsonc`（本机仅 1 行 `$schema`）、`AGENTS.md`、`agent/*.md`、`service.json` | `debug config` 的 `type:"directory"` 条目 |
| 数据目录 | `/Users/lakii2982/.local/share/opencode`，DB `.../opencode.db`，日志 `.../log` | `opencode debug paths` |
| state / cache / tmp | `~/.local/state/opencode`、`~/.cache/opencode`、`/private/var/folders/.../T/opencode` | 同上 |
| 后台 service | `http://127.0.0.1:49374`（pid 81392，随机端口） | `opencode service status` / `GET /api/info` |
| Server 鉴权 | **HTTP Basic**，user=`opencode`，password 来自 `OPENCODE_SERVER_PASSWORD` 或 `service.json` | 文档 + 实测（见 §3.7） |
| 已存凭据 | `~/.local/share/opencode/auth.json`：`opencode-go`（`type=api`，key 51 字符，`oc_s…`）→ 服务端判 `api_key_expired`（**付费套餐过期，重登不续期**）；`GitHub Copilot` 同存。内置免费池 `opencode/*-free` 无需付费 key | `opencode auth list`（只列 provider 与状态，不打印值）；`python3` 只读 auth.json 的键名/类型/长度 |

```
$ opencode debug paths
home       /Users/lakii2982
data       /Users/lakii2982/.local/share/opencode
cache      /Users/lakii2982/.cache/opencode
config     /Users/lakii2982/.config/opencode
state      /Users/lakii2982/.local/state/opencode
tmp        /private/var/folders/f5/.../T/opencode
bin        /Users/lakii2982/.cache/opencode/bin
log        /Users/lakii2982/.local/share/opencode/log
repos      /Users/lakii2982/.local/share/opencode/repos
db         /Users/lakii2982/.local/share/opencode/opencode.db
$ opencode service status
http://127.0.0.1:49374
$ opencode auth list
OpenCode Go     API key                     stored
GitHub Copilot  GitHub Copilot              stored
```

## 3. 证据（命令 + 关键输出摘要）

### 3.1 CLI 面 `[实测]`

```
$ opencode --help
USAGE: opencode <subcommand> [flags] [<directory>]
FLAGS
  --standalone            Run with a private server instead of the background service
  --server string         Connect to a server URL instead of the background service
  --auto                  Auto-approve permissions that are not explicitly denied
  --continue, -c          Continue the last session
  --session, -s string    Session ID to continue, or to create if it does not exist
  --prompt string         Prompt to use
GLOBAL FLAGS
  --print-logs            Print logs to stderr (server logs require --standalone)
SUBCOMMANDS
  upgrade, update | uninstall | acp | api | debug | auth | mcp | plugin | models | stats |
  mini | run | session | service | reload | pair | serve
```

`[文档/实测 差异]`：官方文档提到 `opencode agent create` / `opencode agent list`，但 **2.1.4 的 `--help` 没有 `agent` 子命令**；等价能力是 `opencode debug agents` 与 `GET /api/agent`。

**`--standalone` / `--server` / 后台 service 三者语义** `[实测-帮助文本]`：
- 默认：连接到**后台常驻 service**（`opencode service start` 拉起；本机已在 `127.0.0.1:49374` 运行）。
- `--standalone`：为本次调用起一个**私有 server**，用完即弃（`--print-logs` 的 server 日志只在此模式可见）。
- `--server <url>`：显式连到指定 server。

```
$ opencode run --help
FLAGS
  --standalone | --server string | --continue,-c | --session,-s string | --fork |
  --model,-m string        Model in the format provider/model#variant
  --agent string           Agent to use
  --format choice          default | json
  --file,-f string | --title string | --thinking | --auto

$ opencode serve --help
  --hostname string   --port integer   --cors string   --service   --stdio
$ opencode api --help
USAGE: opencode api [flags] <operation | method path...>
  --standalone | --server string | --data,-d | --header,-H | --param key=value
$ opencode service --help
  start | restart | status | stop | get | set | unset
$ opencode session --help
  list | delete | export | import
$ opencode debug --help
  agents | config | heap-dump | paths
$ opencode mcp --help
  list | add | auth | logout
$ opencode plugin --help
  list | add | check | update | remove
```

### 3.2 原生 agent 定义（subagent 的实证）`[实测]`

`opencode debug agents`（**注意 location 作用域**：从非项目目录跑会返回 `[]`）

```json
[{"id":"build","name":"Build","mode":"primary","hidden":false,
  "description":"The default agent. Executes tools based on configured permissions.",
  "permissions":[{"action":"*","resource":"*","effect":"allow"},
                 {"action":"read","resource":"*.env","effect":"ask"}, ...]},
 {"id":"general","name":"General","mode":"subagent", ...},
 {"id":"explore","name":"Explore","mode":"subagent", ...},
 {"id":"compaction","mode":"primary","hidden":true},
 {"id":"title","mode":"primary","hidden":true},
 {"id":"summary","mode":"primary","hidden":true},
 {"id":"plan","name":"Plan","mode":"primary","hidden":false,
  "description":"Read-only agent for exploring the codebase and planning work before implementation."},
 {"id":"mm-deep","name":"mm-deep","mode":"subagent",
  "description":"深度子代理：架构设计、疑难 bug、多文件重构、最终复核。用强模型，改动要小且可回滚。",
  "model":{"id":"deepseek-v4.1-flash","providerID":"opencode-go"}},
 {"id":"mm-explore","name":"mm-explore","mode":"subagent",
  "description":"只读侦察子代理：检索代码、定位调用点、枚举文件与事实、做摘要。",
  "model":{"id":"glm-5.3-flash","providerID":"opencode-go"}}]
```

本机自定义 agent（`~/.config/opencode/agent/*.md`，**单数 `agent/`**，YAML frontmatter）：

```markdown
---
description: 只读侦察子代理：检索代码、定位调用点、枚举文件与事实、做摘要。用便宜快的模型，适合一次并行派多个。
mode: subagent
model: opencode-go/glm-5.3-flash
permission:
  edit: deny
  bash: allow
---
你是侦察子代理，只读：不修改、不创建、不删除任何文件。...
```

→ **这些 md agent 确实被 2.1.4 加载**（出现在 `debug agents` 里，含 `mode: subagent` 与 `model` 覆写）。
`[文档/实测 差异]`：官方文档写全局目录是 `~/.config/opencode/agents/`（**复数**），本机实测**单数 `agent/` 生效**。适配器不要在路径上写死一种形式，两种都要探测。

`[文档]` 官方 Agent 文档（<https://opencode.ai/docs/agents/>）关键原文：
- "OpenCode comes with two built-in primary agents, Build and Plan." + "three built-in subagents"（`general`、`explore`、`compaction`）。
- 子代理"can be invoked: Automatically by primary agents for specialized tasks based on their descriptions / Manually by @ mentioning"。
- "When subagents create child sessions, use `session_child_first` … `session_parent`" → **子代理 = 子会话（child session）**。
- 权限键全集：`read, edit, glob, grep, list, bash, task, todowrite, external_directory, webfetch, websearch, lsp, skill, question, doom_loop`；取值 `ask|allow|deny`；"the last matching rule wins"。
- `permission.task`："Control which subagents an agent can invoke via the Task tool with `permission.task`. Uses glob patterns … When set to `deny`, the subagent is removed from the Task tool description entirely"。
- `maxSteps`："maximum number of agentic iterations an agent can perform before being forced to respond with text only"。
- `mode: primary | subagent | all`（默认 `all`）；`hidden: true` 仅影响 @ 自动补全。

二进制字符串佐证（原生父子会话）：`parentSessionID`、`childSessionID`、`childSessionUpdates`、`opencode/child-session-updates`、`subagent_type`、`"task"` `[实测-字符串]`。

### 3.3 ACP over stdio：`initialize` 握手 `[实测]`

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": {"http": true, "sse": false},
    "promptCapabilities": {"embeddedContext": true, "image": true},
    "sessionCapabilities": {"additionalDirectories": {}, "close": {}, "delete": {},
                            "fork": {}, "list": {}, "resume": {}},
    "_meta": {"opencode/child-session-updates": true}
  },
  "authMethods": [{"description":"Run `opencode auth login` in the terminal",
                   "name":"Login with opencode","id":"opencode-login"}],
  "agentInfo": {"name":"OpenCode","version":"2.1.4"}
}}
```

与 kimi 的**差异**（适配器必须分支处理）：

| 项 | kimi 2.3.1 | opencode 2.1.4 |
|---|---|---|
| `mcpCapabilities.sse` | `true` | **`false`** |
| `promptCapabilities.audio` | `false` | 字段缺失 |
| `agentCapabilities.auth` | `{"logout":{}}` | 缺失 |
| `_meta` | 无 | **`{"opencode/child-session-updates": true}`**（子会话更新透传） |
| `authMethods[].type` | `"terminal"` + `_meta.terminal-auth` 完整命令 | 只有 `{id,name,description}`，**无 type**，需调用方硬编码 `opencode auth login` |

### 3.4 ACP 会话生命周期 `[实测]`

| 方法 | 结果 | 备注 |
|---|---|---|
| `session/new {cwd, mcpServers}` | `{sessionId, configOptions[model(66 项), mode(build/plan)]}` | `sessionId` 形如 `ses_e8cc0995fffeXmMe4LT9J30bA7`；**无 `modes` 字段**（`null`） |
| `session/set_mode {modeId:"plan"}` | `{}` | 生效 |
| `session/set_config_option {configId:"mode",value:"plan"}` | `{configOptions}` | 生效 |
| `session/set_model {modelId}` | **`-32601 "Method not found": session/set_model`** | **不支持**；切模型只能走 `set_config_option{configId:"model"}` |
| `session/fork {sessionId,cwd}` | `{sessionId, configOptions}` | 新 id |
| `session/load {sessionId,cwd,mcpServers}` | `{configOptions}` | 续接 |
| `session/list {cwd}` | `{sessions:[{sessionId,cwd,title,updatedAt}]}` | — |
| `session/prompt` | 付费 model：`-32000 Authentication required`（旧结论）；**免费 model：`{"stopReason":"end_turn","usage":{"inputTokens":1623,"outputTokens":2,"totalTokens":5721,"cachedReadTokens":4096}}`（2026-10-26 实测）** | 需先 `set_config_option{configId:"model"}` 切到可用模型（默认落在 opencode-go 池） |

`session/new` 的 `configOptions` 全貌：

```
model : type=select category=model current=opencode-go/iceman-contributor-free n=66
mode  : type=select category=mode  current=build n=2
        [{"value":"build","name":"Build","description":"The default agent. Executes tools based on configured permissions."},
         {"value":"plan","name":"Plan","description":"Read-only agent for exploring the codebase and planning work before implementation."}]
```

→ **ACP 面只暴露 2 个 mode（build/plan）**，没有 `--auto` 对应的 mode；`--auto` 是 CLI/API 层的权限开关，不是 ACP mode。

**native-subagent 在 ACP 面的含义**：`_meta["opencode/child-session-updates"]=true` 表示服务端会把**子会话（subagent）的更新**也推给客户端。适配器若要还原父子进度，必须按 `sessionId` 分组（父/子 id 都会出现在 `session/update.params.sessionId`）。

### 3.5 v2 HttpApi：124 端点（OpenAPI 3.1.0）`[实测]`

```
$ opencode api GET /openapi.json | head
{"openapi":"3.1.0","info":{"title":"opencode HttpApi","version":"0.0.1",
 "description":"Experimental HttpApi surface for selected instance routes.","paths":{...
```
端点总数 **124**，且**所有 operation 的 `security: []`、无 `securitySchemes`** → 鉴权不在 OpenAPI 里声明，而是外层 HTTP Basic 强制。

与编排直接相关的端点（`operationId` 原样）：

| 方法 | 路径 | operationId | 用途 |
|---|---|---|---|
| GET | `/api/event` | `event.subscribe` | **SSE 事件流** |
| GET | `/api/info` | `server.info` | `{version,pid,urls,paths,capabilities}` |
| GET | `/api/agent` | `agent.list` | 全部 agent（含 `mode`、`permissions`、`model`） |
| GET | `/api/session` | `session.list` | `limit/order/search`，返回 `tokens/cost/outcome/fork/location` |
| POST | `/api/session` | `session.create` | body 含 `parentID`、`agent`、`model` → **可直接建子会话** |
| GET | `/api/session/active` | `session.active` | — |
| POST | `/api/session/{id}/prompt` | `session.prompt` | body `{id?, text, files?, agents?}` → 返回 `Session.Inbox.User` |
| GET | `/api/session/{id}/inbox` | `session.inbox.list` | 运行中排队输入（`DELETE .../inbox/{inboxID}` 取消） |
| POST | `/api/session/{id}/interrupt` | `session.interrupt` | query `resume=true\|false` → **中断（可恢复）** |
| POST | `/api/session/{id}/fork` | `session.fork` | 带 `boundary:{type:"through",messageID}` |
| POST | `/api/session/{id}/model` | `session.switchModel` | 运行中切模型 |
| POST | `/api/session/{id}/agent` | `session.switchAgent` | 运行中切 agent |
| POST | `/api/session/{id}/permission` / `GET .../permission` | `session.permission.create/list` | — |
| POST | `/api/session/{id}/permission/{requestID}/reply` | `session.permission.reply` | **权限应答** |
| GET | `/api/permission/request` | `permission.request.list` | 全局待批 |
| POST | `/api/session/{id}/background` | `session.background` | 后台化 |
| GET | `/api/session/{id}/message` · `/diff` · `/context` | `session.message.list` 等 | 读取面 |
| GET | `/api/session/{id}/children`（v1 文档） | — | v2 由 `session.list` 的 `parentID`/`fork` 表达 |
| POST | `/api/session/{id}/compact` · `/command` · `/shell` · `/generate` · `/synthetic` · `/wait` | — | 控制面 |
| POST | `/api/rpc/{rpcID}/{method}` | `rpc.call` | 通用 RPC 逃生口 |
| GET | `/api/pty/{ptyID}/connect` · `/api/pty` | `pty.connect` | PTY（WebSocket 连接） |
| POST/GET/DELETE | `/api/worktree` | `worktree.create/list/remove` | **worktree 隔离** |
| GET | `/api/skill` · `/api/mcp` · `/api/mcp/resource` · `/api/plugin` | — | 扩展面 |
| GET | `/api/provider` · `/api/model` · `/api/model/default` | — | 模型路由 |
| POST | `/api/credential` · `/api/integration/{id}/connect/*` | — | 凭据/OAuth/设备码 |
| GET | `/api/experimental/session/{id}/log` | `session.log` | 会话日志 |

tags 全集：`agent, command, config, credential, debug, event, filesystem, form, generate, integration, location, mcp, migration, model, permission, persistentPty, plugin, project, provider, pty, reference, rpc, server, session, shell, skill, vcs, voice, websearch, worktree`。

`session.list` 单条实测（摘录）：`{id, projectID, agent:"plan", cost:0, tokens:{input,output,reasoning,cache:{read,write}}, outcome:"failed", fork:{sessionID,boundary:{type:"through",messageID}}, time:{created,updated,idle}, location:{directory}}` `[实测]`。

### 3.6 SSE 事件流 `[实测]`

```
$ curl -sN -u "opencode:$PW" http://127.0.0.1:49374/api/event
data: {"id":"evt_1734d337c001F837EXjzUpkczt","type":"server.connected","data":{}}

: heartbeat
```
`[文档]` 佐证（v1 路径 `/event`）："Server-sent events stream. First event is `server.connected`, then bus events"（<https://opencode.ai/docs/server/>）。
→ 事件为 `data: {json}` + `: heartbeat` 注释保活。完整事件类型枚举 **2026-10-26 已实测**（26 类，见 §3.12）。

### 3.7 Server 鉴权：HTTP Basic `[实测 + 文档]`

```
# 用 service.json 里的 password 作 Basic 认证（命令中不回显值）
$ curl -s -o /dev/null -w '%{http_code}\n' -u "opencode:$PW" http://127.0.0.1:49374/api/info
200
$ curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PW" http://127.0.0.1:49374/api/info
401
$ curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencode-password: $PW" http://127.0.0.1:49374/api/info
401
$ curl -s http://127.0.0.1:49374/openapi.json
{"_tag":"UnauthorizedError","message":"Authentication required"}
```
`[文档]`："Set `OPENCODE_SERVER_PASSWORD` to protect the server with HTTP basic auth. The username defaults to `opencode`, or set `OPENCODE_SERVER_USERNAME` to override it. This applies to both `opencode serve` and `opencode web`."（<https://opencode.ai/docs/server/>）
→ 与本机 `service.json` 仅含一个 `password` 字段吻合。

**坑**：`opencode serve` 启动时把 `server password <值>` **明文打到 stdout**（实测）。

### 3.8 `run` 的非交互输出与失败语义 `[实测]`

```
$ opencode run --standalone --format json -m "opencode-go/deepseek-v4.1-flash" "只回复 OK"
{"type":"step_start","timestamp":1792935027315,"sessionID":"ses_e8cbe9e63ffeB4MqDPtHcAqNYo",
 "part":{"id":"prt_173416273001O83YOJG4JFDm14","sessionID":"ses_...","messageID":"msg_...",
         "type":"step-start"}}
{"type":"error","timestamp":1792935030477,"sessionID":"ses_...",
 "error":{"type":"provider.invalid-request","message":"The requested model is not available for integrator \"opencode\". ...",
          "status":400,"response":{"body":"{\"error\":{...}}"}}}
$ echo $?    # → 1
```
- `--format json` = **JSONL 事件流**，字段 `{type, timestamp(ms epoch), sessionID, part|error}`；实测见过的 `type`：`step_start`、`error`。
- 成功 turn 的 `type` 全集：**2026-10-26 实测**（`step_start`/`text`/`step_finish`/`error` 已录；SSE 侧 26 类见 §3.12；`tool` 事件仍需工具调用场景补录）。
- 失败时 `--format json` 仍能结构化报错，**退出码 1**；`--format default`（文本）失败时是带 ANSI 的 `Error: ...` 打到 stderr，退出码同样是 1。
- 付费/无效凭据路径的失败原文（供错误分类表用；免费模型路径见 §3.12）：

| provider | 错误 |
|---|---|
| `opencode-go/*` | `provider.auth` / 401 `api_key_expired`："This API key has expired. Create a new API key in OpenCode Console and replace it…" |
| `github-copilot/gpt-5.4-nano` | `provider.invalid-request` / 400 `model_not_available_for_integrator`："The requested model is not available for integrator \"opencode\"." |
| `github-copilot/claude-haiku-4.5` | `provider.invalid-request` / 400 `model_not_supported`："The requested model is not supported." |

**2026-10-26 复测：免费模型成功基线（与上表的失败语义并列）**

```bash
$ opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free
{"type":"text","timestamp":1792944956438,"sessionID":"ses_e8c27271…",
 "part":{"id":"prt_…_text-0","sessionID":"ses_e8c27271…","messageID":"msg_…",
         "type":"text","text":"OK","time":{"start":1792944953617,"end":1792944956438}}}
$ echo $?   # → 0
```

→ 同一 `--format json` 面：成功 turn 的 `type` 至少含 `text`（后续实测还看到 `step_start`/`error`）；失败 turn 的 `type:"error"` 带 `error{type,status,message,response.body}`。完整事件全集与三通道复测见 §3.12。

### 3.9 配置面 `[实测]`

- `opencode.jsonc`（本机）：`{"$schema": "https://opencode.ai/config.json"}` —— **只有 schema，全部用默认值**。
- `opencode debug config` 的"配置源"概念：`[{type:"document",path:".../opencode.jsonc",info:{...}},{type:"directory",path:".../opencode"}]` → 配置 = 单个文档 + 一个目录（目录里放 `agent/*.md`、`AGENTS.md`、插件等）。
- `~/.config/opencode/AGENTS.md`（1335 B，用户全局指令，**未贴内容**）；`~/.config/opencode/package.json` + `node_modules/`（插件依赖）。
- `service.json` 只有 `{password}` 一个键（**值不落盘到任何文档**）。
- `models` 输出 39 个 `provider/model` 别名，其中 10 条含 `free`（2026-10-26 复测；ACP `configOptions.model` 为 66 项，两者口径不同）`[实测]`。
- `mcp list` → `No MCP servers configured` `[实测]`。


### 3.12 免费模型池与三通道端到端复测（2026-10-26，本机实测）`[实测]`

> 起因：上一版误把“付费套餐 key 过期”当成“未登录”。本节为修正后的复测证据（凭据存在、付费 key 过期、免费池可用），**命令可复跑**；sessionID 已脱敏（保留前缀），全部来自本机实测。

**凭据面（只读元信息，不打印值）**

```bash
$ opencode auth list
OpenCode Go     API key                     stored
GitHub Copilot  GitHub Copilot              stored
$ python3 - <<'PY'
import json, os
d = json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json')))
print({k: {kk: ('<len=%d>' % len(str(vv))) if kk == 'key' else vv for kk, vv in v.items()} for k, v in d.items()})
PY
{'opencode-go': {'type': 'api', 'key': '<len=51>'}}   # key 形如 oc_s…，51 字符
```

**通道 1：CLI `run` + 免费模型（rc=0）→ 续接（`-s`，同一 sessionID，正确复述）**

```bash
$ opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free
{"type":"text",…,"sessionID":"ses_e8c27271…","part":{…,"type":"text","text":"OK",…}}    # rc=0
$ opencode run -s ses_e8c27271… "上一条你回复了什么原文？只回复那两个字符" \
      --format json -m opencode/deepseek-v4.1-flash-free
{"type":"text",…,"sessionID":"ses_e8c27271…","part":{…,"type":"text","text":"OK",…}}    # 同 id → 真续接
```

**通道 2：HTTP v2（free 模型，端到端）**

| 步骤 | 请求 | 实测结果 |
|---|---|---|
| 建会话 | `POST /api/session` body `{"agent":"plan","model":{"id":"deepseek-v4.1-flash-free","providerID":"opencode"},"location":{"directory":"/tmp"}}` | `200 {"data":{"id":"ses_e8c264ec…","agent":"plan","model":{…}}}` |
| 一轮 | `POST /api/session/{id}/prompt {"text":"只回复两个字符：OK"}` | `200 {"data":{"id":"msg_…","type":"user","delivery":"steer","payload":{"text":…}}}` |
| 查询 | `GET /api/session/{id}` | `outcome:"succeeded"`、`tokens{input:5401,output:33,reasoning:41,cache{read:6272,write:0}}`、`cost:0` |
| 续接 | 对同一 `sessionID` 再 `POST .../prompt` | `succeeded`，assistant 文本正确复述 `OK`（HTTP 续接成立） |
| 中断 | 长任务 + `POST .../interrupt?resume=true` | `200 {"interrupted":true}`；SSE `session.execution.interrupted{reason:"user"}` + `session.step.failed{error:{type:"aborted",message:"Step interrupted"}}`；`outcome:"interrupted"`；**中断后再 prompt 成功** |
| 中断幂等 | 已结束会话 `POST .../interrupt?resume=false` | `200 {"interrupted":false}`（不报错） |
| 权限 | `build` agent 读 `/tmp/.env`（触发 ask）→ `GET /api/permission/request` → `POST .../permission/{requestID}/reply {"decision":"once"}` | `permission.asked` 事件 + reply `204`（OpenAPI 枚举 `once\|always\|reject`） |
| 付费模型 | `POST /api/session` with `model:{id:"deepseek-v4.1-flash",providerID:"opencode-go"}` + prompt | `outcome:"failed"`；SSE `session.step.failed` + `session.execution.failed{error:{type:"provider.auth",status:401,…api_key_expired…}}` |

**SSE 事件全集（成功轮 + 中断/权限/失败轮实测，2026-10-26）**

```text
server.connected
session.created
session.inbox.enqueued / session.inbox.delivered
session.execution.started / session.execution.succeeded / session.execution.failed / session.execution.interrupted
session.instructions.updated
session.step.started / session.step.streamed / session.step.ended / session.step.failed
session.text.started / session.text.delta / session.text.ended
session.reasoning.started / session.reasoning.delta / session.reasoning.ended
session.usage.updated
permission.asked
（catalog 噪声，必须丢弃计数：integration.updated / provider.updated / model.updated / agent.updated /
 command.updated / skill.updated / websearch.updated / reference.updated / plugin.updated）
```

帧形状：`{id:"evt_…",created:<ms epoch>,type,location:{directory},data:{…},durable?:{aggregateID,seq,version}}`；`data` 行格式 `data: {json}` + `: heartbeat`。

`data` 关键形状（实测）：

- `session.text.delta`：`{sessionID,assistantMessageID,ordinal,delta:"…"}`
- `session.text.ended`：`{sessionID,assistantMessageID,ordinal,text:"全文"}`
- `session.reasoning.*`：同上（`delta`/`text`）
- `session.step.started`：`{sessionID,agent,model{…}}`；`session.step.ended`：`{sessionID,finish,rawFinish,cost,tokens{…}}`
- `session.usage.updated`：`{sessionID,cost,tokens{input,output,reasoning,cache{read,write}}}`
- `session.execution.*`：`{sessionID}`（`interrupted` 额外带 `reason`；`failed` 带 `error{…}`）
- `permission.asked`：`{id:"per_…",sessionID,action:"read",resources:[".env"],save:["*"],source:{type:"tool",messageID,id:"call_…"}}`
- `session.inbox.enqueued`：`{inboxID,sessionID,item{type:"user",payload{text}}}`；`session.inbox.delivered`：`{sessionID,inboxID}`

**delta 粒度实测**：`从1数到40`（输出 149 字符）→ `session.text.delta` 仅 3 条（≈50 字/chunk）→ **chunk 级，不是 token 级**；`session.text.ended` 1 条含全文。

**通道 3：ACP over stdio（free 模型，端到端跑通）**

- `initialize` → `protocolVersion:1`、`agentInfo.version:"2.1.4"`；
- `session/new {cwd:"/tmp",mcpServers:[]}` → `configOptions`：`model=opencode-go/iceman-contributor-free`、`mode=build`（**默认 model 落在 opencode-go 池；付费 key 无效时直接 prompt 会认证失败 → 必须先切模型**）；
- `session/set_config_option {sessionId,configId:"model",value:"opencode/deepseek-v4.1-flash-free"}` → 生效（`currentValue` 变更，并回 `config_option_update`）；
- `session/prompt` → `{"stopReason":"end_turn","usage":{"inputTokens":1623,"outputTokens":2,"totalTokens":5721,"cachedReadTokens":4096},"_meta":{}}`；
- `session/update` 实测：`available_commands_update`、`config_option_update`、`agent_message_chunk{messageId:"msg_…",content:{type:"text",text:"OK"}}`、`usage_update{used:5721,size:200000,cost:{amount:0,currency:"USD"}}`。

**免费模型池**（`opencode models` 复测：39 条，其中 10 条含 `free`）：`opencode/deepseek-v4.1-flash-free`、`opencode/glm-5.3-flash-free`、`opencode/big-pickle`、`opencode/beam-free`、`opencode/flint-40b-free`、`opencode/mimo-v2.6-flash-free`、`opencode/nemotron-3-ultra-free`、`opencode/nemotron-3.5-lightning-free`、`opencode/nemotron-3.5-super-vl-free`、`opencode-go/beam-free`、`opencode-go/iceman-contributor-free`。
> `opencode/*-free` 属内置免费池；`opencode-go/*`（含名字带 `-free` 者）走 OpenCode Go provider，仍需有效 key。

**结论（D-019）**：opencode **默认可用（`enabled:true`）**；生产默认模型 `opencode-go/deepseek-v4.1-flash`（用户口径）在付费 key 过期时按 `auth.credential-expired` 降级到 `opencode/deepseek-v4.1-flash-free`，降级必须显式可见（事件 + 结果字段 `model=free-fallback`），不得静默。

## 4. 能力清单（15 项，与 `tools/check_docs.py` CAPABILITIES 对齐）

| # | 能力 | 结论 | 证据（可复跑命令 / 路径） | 标记 |
|---|---|---|---|---|
| 1 | `headless` | ✅ | `opencode run [--format default\|json] [-m p/m] [--agent] [--thinking] [-f] "msg"`；**免费模型 rc=0**，付费 key 失效 rc=1 | `[实测 2026-10-26]` §3.12 |
| 2 | `stream` | ✅ | **免费模型端到端实测**：HTTP SSE 26 类事件（`session.text/reasoning/step/usage/execution.*` + `permission.asked`）；`--format json` 输出 `{"type":"text",…}`；delta 粒度实测 ≈50 字/chunk（**chunk 级**，非 token） | `[实测 2026-10-26]` §3.12 |
| 3 | `resume` | ✅ | CLI `-s <id>` 同 sessionID 正确复述上一轮；HTTP 同一 `sessionID` 再 `POST prompt` 成功；ACP `session/load` | `[实测 2026-10-26]` §3.12、§3.4 |
| 4 | `fork` | ✅ | `run --fork`；`POST /api/session/{id}/fork`（`boundary:{type:"through",messageID}`）；ACP `session/fork` → 新 `ses_...`；`session.list` 条目带 `fork` 字段 | [实测] |
| 5 | `session-list` | ✅（作用域坑） | `session list [-n][--format table\|json]`（**project 作用域**，非 git 目录实测返回 `[]`）；`api GET /api/session --param limit=3` 跨项目且含 cost/tokens/outcome；ACP `session/list`；`session delete` 连带删子会话 | [实测] |
| 6 | `interrupt` | ✅ | HTTP `POST /api/session/{id}/interrupt?resume=true` → `{"interrupted":true}`、SSE `session.execution.interrupted{reason:"user"}`、`outcome:"interrupted"`，中断后可续；`resume=false` 对已结束轮返回 `{"interrupted":false}`（幂等）；ACP `session/cancel` 仍未验证 | `[实测 2026-10-26]` §3.12 / ACP TO-VERIFY |
| 7 | `native-subagents` | ✅ | `debug agents` → `general`/`explore`(subagent)、`build`/`plan`(primary)、`compaction`/`title`/`summary`(hidden)；`~/.config/opencode/agent/*.md` 自定义生效；ACP `_meta:{"opencode/child-session-updates":true}`；二进制 `parentSessionID`/`childSessionID`；`POST /api/session` 支持 `parentID` | [实测] + [文档] |
| 8 | `tool-extension` | ✅ | `mcp list/add/auth/logout`、`plugin list/add/check/update/remove`、`GET /api/skill`、`GET /api/mcp{,/resource}`、`~/.config/opencode/agent/`、`opencode.jsonc` + `node_modules` 插件依赖 | [实测] |
| 9 | `permission-modes` | ✅ | HTTP `permission.asked`（`action/resources/save/source`）+ `reply {"decision":"once\|always\|reject"}`→204；ACP `configOptions.mode=build\|plan`；CLI `--auto` 不在 ACP mode | `[实测 2026-10-26]` §3.12、§3.4 |
| 10 | `sandbox` | ❌ 无 OS 级沙箱 | 二进制 `sandbox-exec`/`seatbelt`/`landlock`/`bubblewrap` 命中 0；隔离手段 = 权限规则 + `external_directory` 权限键 + `POST /api/worktree` + `--standalone` 进程隔离 | [实测-否定] |
| 11 | `auth-model-routing` | ✅ | `auth list/login/logout/switch/export/import`；`models`（39 条，10 条含 free）；`-m provider/model#variant`；`POST /api/session/{id}/model`、`/agent`；ACP `set_config_option{configId:"model"}`（66 项）；付费 key 过期须降级 free | `[实测 2026-10-26]` §3.12、§3.5 |
| 12 | `concurrency` | ⚠️ 无全局上限键 | 后台 service 多客户端共享；`maxSteps` 只限单 agent 迭代；**未发现**全局并发上限配置键 → 由兼容层从运行时 `maxActiveSubagents` 派生，不写死数字 | `[实测]` §3.9；派生规则见 §6 |
| 13 | `usage-observability` | ✅ | HTTP SSE `session.usage.updated{cost,tokens{…}}` + `session.step.ended` 带 tokens + `session.list` 聚合；ACP `session/prompt` 返回 `usage{inputTokens,outputTokens,totalTokens,cachedReadTokens}`、`usage_update{used,size,cost}`；`opencode stats` | `[实测 2026-10-26]` §3.12 |
| 14 | `structured-protocol` | ✅ 双协议（均实测） | ACP stdio（protocolVersion 1，prompt 端到端）；v2 HttpApi OpenAPI 3.1.0/124 paths + SSE（26 类事件）；错误 `_tag` JSON；`opencode api` 按 operationId 调用 | `[实测 2026-10-26]` §3.12、§3.5 |
| 15 | `version-pinning` | ✅ 可指定版本 | `--version` → `opencode v2.1.4`；`opencode upgrade [target] --method curl\|npm\|pnpm\|bun\|yarn\|vp\|brew\|winget`（**支持指定版本**）；`uninstall` 保留 session data/config/state | [实测] |

> **2026-10-26 复测后口径**：第 1/2/3/6/9/11/13/14 行的 ✅ 均已有**免费模型端到端实测**（§3.12）；付费 `opencode-go/*` 模型的可用性取决于 key 是否有效，不影响上述通道能力。

## 5. 限制与已知坑

1. **凭据存在，付费套餐 key 过期，免费模型池可用**（2026-10-26 修正）：`~/.local/share/opencode/auth.json` 有 `opencode-go`（`type=api`，`oc_s…` 51 字符）；付费默认模型 `opencode-go/deepseek-v4.1-flash` 报 401 `api_key_expired`，**重新登录不会续期**，必须到 Console 新建 key 后替换（`opencode auth login` 或改 auth.json）；免费池 `opencode/*-free` 的 CLI/HTTP/ACP 三通道均实测跑通。→ 适配器默认 `enabled:true`；付费模型缺 key 时降级免费同模型（显式可见）。
2. **`opencode serve` 把 server password 明文打印到 stdout**。任何"启动 serve 并收集日志"的实现都会把凭据写进日志 → 必须过滤或改从 `OPENCODE_SERVER_PASSWORD` 注入。
3. **`session list` 是 project 作用域**：本机工作目录不是 git 仓库时返回 `[]`，容易被误判为"没有会话"。跨项目/全量请用 `api GET /api/session`。
4. **`debug agents` / `agent.list` 是 location 作用域**：从 `/tmp` 跑返回 `[]`，从项目目录跑才返回完整列表。适配器必须显式传 directory 或在目标 cwd 下调用。
5. **文档是 v1，实现是 v2**：`/session`、`/event`、`/agent`、`/doc` 全部回落到 SPA HTML（HTTP 200 但内容是 `<html>`）；真 OpenAPI 在 `GET /openapi.json`（需 Basic auth）。按文档写的客户端在 2.1.4 上会静默拿到 HTML。
6. **ACP 少了 `session/set_model`**（kimi 有），切模型只能 `session/set_config_option{configId:"model"}`；`configOptions` 里 `model` 有 66 个选项，逐次下发成本高（约 8KB/次），适配器应缓存。
7. **ACP 只暴露 `build`/`plan` 两个 mode**，`--auto` 不体现在 ACP mode 里 → "自动批准"必须另走权限应答通道（ACP `session/request_permission` 或 API `permission.reply`），二者本机均未验证。
8. **自定义 agent 目录单复数不一致**：实测单数 `~/.config/opencode/agent/` 生效，文档写复数 `agents/`。两种都要探测，别只认一种。
9. `opencode.jsonc` 本机几乎为空（仅 `$schema`）→ **不存在任何项目级/用户级权限收窄**，默认 `build` agent 的 `{"action":"*","resource":"*","effect":"allow"}` 意味着默认全放行（除 `*.env*` 为 `ask`）。安全默认必须由调用方显式下 `--agent plan` 或自定义 deny agent。
10. 二进制 mtime = `Oct 26 1985`（时间戳被固定），任何"按 mtime 判断版本/新鲜度"的逻辑都不可用。

11. **ACP `session/new` 默认 model 落在 `opencode-go/*`**：实测 `configOptions.model.currentValue = opencode-go/iceman-contributor-free`；付费 key 无效时直接 `session/prompt` 会认证失败 → 适配器**必须**先 `set_config_option{configId:"model"}` 切到已验证模型。`[实测]` §3.12
12. **HTTP 返回统一包 `{"data":…}`**：会话/列表等裸取字段会拿到 `None`；列表页还带 `cursor`；SSE 帧则是裸事件对象。`[实测]` §3.12
13. **SSE 里一半是 catalog 噪声**：`integration.updated`/`provider.updated`/`model.updated`/`agent.updated`/`command.updated`/`skill.updated`/`websearch.updated`/`reference.updated`/`plugin.updated` 与任务无关，必须丢弃计数，不得当业务事件。`[实测]` §3.12
14. **`GET /api/permission/request` 是 location 作用域**：query `location[directory]`（deepObject）；不传时按服务端 cwd 返回空数组，容易误判“没有待批”。`[实测]` §3.12
15. **`opencode-go/*-free` ≠ 免费池**：`opencode/*` 是内置免费池；`opencode-go/*`（哪怕名字带 `-free`）走付费 provider，仍需有效 key。`[实测]` §3.12

## 6. 适配器实现要点（给 D4/D5 的直接输入，2026-10-26 修正）

1. **通道优先级**：**v2 HttpApi 主通道（端到端实测）**；**ACP over stdio 兜底（端到端实测，与 kimi 复用同一 ACP 客户端）**；`opencode run + -s` 作最后兜底（一次性、消息级、无中断/权限面，适合诊断与降级）。
2. **默认启用**：`enabled:true`。模型分级：内置免费池 `opencode/*-free`（默认可用，实测 rc=0）→ 生产默认 `opencode-go/deepseek-v4.1-flash`（用户口径，需有效 key）。付费 key 过期 → `auth.credential-expired` + **降级到 `opencode/deepseek-v4.1-flash-free`**，降级必须发 degraded 事件并在结果写 `model=free-fallback`，禁止静默。
3. **建会话**：`POST /api/session` body `{agent, model:{id,providerID}, location:{directory}}`；`agent` 必须显式（默认 `build` 是全放行）。
4. **ACP 切模型**：`session/new` 的默认 model 实测落在 `opencode-go/*`；付费 key 无效时直接 prompt 会认证失败 → **先 `set_config_option{configId:"model"}` 到已验证模型再 prompt**。
5. **权限**：HTTP `permission.asked` → `POST .../permission/{requestID}/reply {decision: once|always|reject}`（204）；`GET /api/permission/request` 是 location 作用域；ACP 权限请求形状仍未验证（fail-closed）。
6. **中断**：HTTP `POST .../interrupt?resume=true|false`（实测；`resume=true` 后会话可续）；ACP 无 cancel → 进程 kill。
7. **并发**：后端无全局上限配置键 → 兼容层从运行时 `maxActiveSubagents` 派生并发上限，不写死数字。
8. **事件**：SSE 26 类已实测（§3.12）；catalog 噪声丢弃计数；delta 是 chunk 级（≈50 字/条），不是 token。
9. **服务发现/鉴权**：默认连后台 service；`--standalone` 隔离；不收集 `serve` stdout（password 明文）；HTTP Basic，password 只从 `OPENCODE_SERVER_PASSWORD` 注入；禁止 `auth export`。
10. **作用域坑**：`debug agents` / `agent.list` / `GET /api/permission/request` 都是 location 作用域 → 必须带目标 directory。

## 7. 复跑命令块

```bash
# 全量只读探测（约 3s，退出码 0）
bash repro/probe-opencode.sh

# 带 ACP 会话级方法（会写 session 库）
PROBE_ACP_SESSION=1 bash repro/probe-opencode.sh

# 带真实 run（消耗额度；本机凭据失效，预期 provider 错误 + 退出码 1）
PROBE_LIVE=1 bash repro/probe-opencode.sh

# ACP 握手
python3 - "$HOME/.opencode/bin/opencode" <<'PY'
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

# v2 HttpApi 端点清单（经 CLI 自鉴权，无需密码）
opencode api GET /openapi.json | head -c 300

# 原生 agent（必须在项目 cwd 下；在 /tmp 下会得到 []）
cd /Users/lakii2982/项目/多智能体编排 && opencode debug agents | head -40

# 自定义 agent 定义
sed -n '1,9p' ~/.config/opencode/agent/mm-explore.md

# 会话（project 作用域 vs 全量）
opencode session list --max-count 3
opencode api GET /api/session --param limit=3

# SSE（用后台 service 的 password 做 Basic）
PW=$(python3 -c "import json;print(json.load(open('$HOME/.config/opencode/service.json'))['password'])")
curl -sN -u "opencode:$PW" http://127.0.0.1:49374/api/event | head -3

# 失败语义（退出码 1）
opencode run --standalone --format json "只回复 OK"; echo "rc=$?"

# 无 OS 沙箱的否定证据
grep -a -c -E 'sandbox-exec|seatbelt|landlock|bubblewrap' ~/.opencode/bin/opencode   # → 0
```

### 7b. 免费模型实跑（2026-10-26，零费用；`PROBE_LIVE=1` 时脚本会跑）

```bash
# 免费模型一轮 + 续接（实测 rc=0）
~/.opencode/bin/opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free
SID=$(~/.opencode/bin/opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionID"])')
~/.opencode/bin/opencode run -s "$SID" "上一条你回复了什么原文？只回复那两个字符" \
      --format json -m opencode/deepseek-v4.1-flash-free

# 付费模型（预期 rc=1/401 api_key_expired，除非用户已换新 key）
~/.opencode/bin/opencode run "只回复两个字符：OK" --format json -m opencode-go/deepseek-v4.1-flash

# 模型池（免费/付费分级）
~/.opencode/bin/opencode models | grep -E 'free|big-pickle' | head

# 脚本内 live 段（free 模型，rc=0）
PROBE_LIVE=1 bash repro/probe-opencode.sh; echo "rc=$?"
```


## 8. 未决项

> 2026-10-26 复测后，原「成功 turn 事件全集」「HTTP 中断/续接」「凭据不可用」均已转为实测（§3.12），从本节移除。

- **TO-VERIFY（ACP 权限请求形状）**：本次 ACP 只跑纯文本 turn，未触发 `session/request_permission`；需构造 ask 场景（如 `build` + 读 `.env`）在 ACP 侧抓一次，确认 `options`/`kind` 与 kimi 是否同构。
- **TO-VERIFY（ACP `session/cancel`）**：仍未发现/未验证；中断只能进程 kill。
- **TO-VERIFY（工具事件形状）**：成功轮未触发工具调用（纯文本/只读），`session.tool.*`（或等价）事件名与字段未录；需构造一次工具调用录制。
- **TO-VERIFY（子会话事件）**：`POST /api/session{parentID}` 与 ACP `_meta:opencode/child-session-updates` 的子会话事件形状未实测。
- **TO-VERIFY（免费池配额/速率）**：免费模型是否有 429/额度上限未测（ABI AB-V4 的 opencode 证据仍缺）。
- **TO-VERIFY（token 级增量）**：实测 delta 为 ≈50 字/chunk（chunk 级）；更长输出是否更细未验证。
- **TO-VERIFY（付费 key 替换后的 opencode-go 回归）**：需用户到 Console 新建 key 后复跑 paid 用例。
- **TO-VERIFY（`serve --stdio` 语义）**：帮助有 `--stdio`/`--service` 但无描述。
- **TO-VERIFY（`--print-logs` 非 standalone 行为）**：帮助限定 server logs 需 `--standalone`，具体缺哪些日志未测。
- **TO-VERIFY（agent 目录单复数）**：文档写 `agents/`，实测 `agent/` 生效；是否两者都支持未知。

## 9. 来源

- 官方文档（本次抓取）：
  - Agents：<https://opencode.ai/docs/agents/> —— 内置 primary/subagent 清单、`permission.task`、权限键全集、`maxSteps`、`mode: primary|subagent|all`、markdown agent 目录。
  - Server：<https://opencode.ai/docs/server/> —— `serve` 旗标、`OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`、`/event` SSE "first event is server.connected"、`/session/:id/abort`、`/session/:id/children`、OpenAPI 3.1 spec 位置。
  - **注意**：该文档描述的是 v1 路径；本机 2.1.4 实际暴露 v2 `/api/*`（124 端点），以本文件 §3.5 实测为准。
- 本机：`opencode --version`、各子命令 `--help`、`opencode debug {paths,config,agents}`、`opencode api GET /openapi.json`、ACP 实测握手、`~/.config/opencode/agent/*.md`、二进制字符串。

## 10. 复测记录（2026-10-26）

- 凭据：`opencode auth list`；`~/.local/share/opencode/auth.json`（只读键名/类型/长度，不打印值）。
- 模型池：`opencode models` → 39 条（10 条含 `free`）。
- CLI：`opencode run --format json -m opencode/deepseek-v4.1-flash-free`（rc=0）；`-s <sessionID>` 续接成功；付费 `-m opencode-go/deepseek-v4.1-flash` → rc=1/401 `api_key_expired`。
- HTTP v2：`POST /api/session` → `POST .../prompt` → `GET .../session/{id}` → 续接 → `interrupt?resume=true|false` → `permission.asked` + `reply`；SSE 事件全集 26 类。
- ACP：`initialize → session/new → set_config_option{model} → session/prompt` → `stopReason:end_turn` + `usage`。
- 命令原文与脱敏 sessionID 见 §3.12；可复跑入口见 §7 / §7b。
