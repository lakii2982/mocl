# opencode 适配器规格（D5b / opencode）

> **后端**：opencode `v2.1.4`（`.astra/BRIEF.md:52` 版本基线）。
> **ABI 目标**：`abiVersion = "0.1"`（`docs/abi/abi-v0.md`）。本文件**不定义**任何 ABI 类型；事件名/错误码/能力位/方法名一律引用 `docs/abi/abi-v0.md`（§3 能力位、§6 方法、§7 事件、§8 错误码），本文只给**原生字段 → ABI 字段的映射**与**后端特化行为**。
> **证据状态（2026-10-26 复测修正，D-019）**：凭据**存在**（`~/.local/share/opencode/auth.json` 的 `opencode-go`，key `oc_s…` 51 字符）；**付费套餐 key 已过期**（401 `api_key_expired`，重登不续期），但**内置免费模型池实测完全可用**。因此 opencode **默认 `enabled:true`**；生产默认模型 `opencode-go/deepseek-v4.1-flash`，key 失效时按 `auth.credential-expired` **降级到 `opencode/deepseek-v4.1-flash-free`**，降级必须显式可见（事件 + 结果 `model=free-fallback`），不得静默。
> **三通道均已本机实测**（`docs/research/opencode.md §3.12`，命令与脱敏 sessionID 见该节）：v2 HttpApi（主通道）、ACP over stdio（兜底）、CLI `run + -s`（最后兜底）。
> **引用约定**：证据写 `docs/research/opencode.md:<行号>` 或 `§小节` / `repro/probe-opencode.sh §段号`；未验证写 `TO-VERIFY` 并给补测命令，不臆测。
> **写域**：仅本文件（配套 `docs/research/opencode.md`）。DSH 接入属 `docs/integration/*`，不在此展开。

---

## 0. 决策摘要与传输通道选型

### 0.1 三个可用面（全部本机实测）

| 维度 | A（主通道）v2 HttpApi + SSE | B（兜底）ACP over stdio | C（最后兜底）CLI `run` + `-s` |
|---|---|---|---|
| 协议 | OpenAPI 3.1.0 / **124 paths** / SSE `/api/event`（`opencode.md:212-215`、`:221`） | newline JSON-RPC 2.0，`protocolVersion=1`（`opencode.md:153-169`） | stdout JSONL，`{type,timestamp,sessionID,part\|error}`（`opencode.md:281-295`） |
| 鉴权 | HTTP Basic，user=`opencode`（`opencode.md:263-276`） | 进程继承 CLI 凭据 | 进程继承 CLI 凭据 |
| 控制面 | create/prompt/inbox/**interrupt**/fork/permission.reply/model/agent/worktree/background（`opencode.md:219-246`） | new/load/fork/list/set_mode/set_config_option（`opencode.md:182-204`） | 无控制面（一次性）；续接只能 `-s` |
| 事件 | **26 类 SSE 事件已实测**（text/reasoning/step/usage/execution/inbox/permission + catalog 噪声；`opencode.md §3.12`、`:367`） | `agent_message_chunk`/`usage_update`/`config_option_update` 等已实测（`opencode.md §3.12`、`:399`） | `type:"text"` / `type:"error"` / `step_start`（`opencode.md:285-295`） |
| 续接 | 同一 `sessionID` 再 prompt **实测成立**（`opencode.md §3.12`） | `session/load`（`opencode.md:191`） | `run -s <id>` **实测同 sessionID 正确复述**（`opencode.md §3.12`） |
| 中断 | `POST .../interrupt?resume=true\|false` **实测**，`resume=true` 后会话可续（`opencode.md:229`、`§3.12`） | `session/cancel` 未验证/未见实现（`opencode.md:416`、`:460`） | 无（杀进程） |
| 权限 | `permission.asked` + `reply{decision:once\|always\|reject}` **实测**（`opencode.md §3.12`、`:234`） | 形状未验证（`opencode.md:415`） | 无 |
| 模型基线 | 免费池 `opencode/*-free` 实测 rc=0；付费 `opencode-go/*` 需有效 key（`opencode.md §3.12`） | 默认 model 落在 `opencode-go/*`，须先 `set_config_option` 切免费池 | `-m` 显式指定 |
| 证据 | **端到端实测（2026-10-26）** | **端到端实测（2026-10-26）** | **端到端实测（2026-10-26）** |

> **路径参数命名**：本文件为可读性把路径参数简写为 `{id}`；`/openapi.json` 实测为 `{sessionID}`（`repro/probe-opencode.sh §7`）。实现以 spec 为准。

### 0.2 选型结论：**v2 HttpApi 优先 + ACP 兜底 + CLI 最后兜底；默认 `enabled:true`**

- **主通道 = v2 HttpApi**，理由（均有端到端/端点证据）：
  1. **中断只有这条面有且已实测**：`session.interrupt?resume=` 返回 `{"interrupted":true}`、SSE `session.execution.interrupted{reason:"user"}`、中断后会话可继续（`opencode.md:229`、`§3.12`）；ACP 的 `session/cancel` 未验证（`opencode.md:416`）；
  2. **运行中追加输入/队列**：`/inbox` 列/删 + prompt body `delivery ∈ {steer,queue}`（OpenAPI `Session.Inbox.Delivery`；`opencode.md:227-228`）；
  3. **权限应答闭环已实测**：`permission.asked` → `POST .../permission/{requestID}/reply {decision:once|always|reject}` → `204`（`opencode.md §3.12`、`:234-235`）；
  4. **fork / 运行中切模型/切 agent / worktree / 后台化** 都在 v2（`opencode.md:230-236`、`:242`）；
  5. **事件总线已实测 26 类**：text/reasoning/step/usage/execution/inbox/permission（`opencode.md §3.12`、`:367`）。
- **兜底 = ACP over stdio**（已实测跑通 turn），触发条件（握手期一次性决定，运行期禁止临时切换，ABI §3.5 硬规则 2）：
  1. 后台 service 不可用且不允许起私有 server（`opencode service status` 无 URL → `opencode.md:40-41`）；
  2. 需要“一任务一进程”的 stdio 生命周期（与 kimi 复用同一 ACP 客户端）；
  3. 调用方要求不经 HTTP 控制面（无 localhost 网络等）。
- **最后兜底 = CLI `run` + `-s`**（D-019）：无控制面、只有消息级事件、无中断/权限应答，但**一次进程一轮、`-s` 可续接**，适合 v2/ACP 同时不可用时的最小可执行路径（`opencode.md §3.12`）。
- **模型分级（D-019）**：
  - 内置免费池 `opencode/*-free`（如 `opencode/deepseek-v4.1-flash-free`）→ 默认可用，无需有效付费 key；
  - 生产默认模型 `opencode-go/deepseek-v4.1-flash`（用户口径）→ 需有效 `opencode-go` key；本机 key 过期 → `auth.credential-expired` → **降级免费同模型**并显式记录 `model=free-fallback`；
  - 启动预检用 `opencode models`（39 条 / 10 条含 `free`，`opencode.md §3.12`）+ 一次轻量 probe 做分级：free=可用 / paid=需凭据。
- **兜底后的能力收缩**（写进 `degradeWarnings[]`）：ACP 兜底时 `interruptTurn → emulated（进程级 kill + 会话续接）`、`permissionAutoReply/permissionRequestBridge → unavailable（静态裁剪，ABI R-6/R-7）`、`modelRouting → emulated（仅 `set_config_option`，66 项缓存）`、`usageReporting → emulated（无 session.list 聚合）`；CLI 兜底时再加 `streaming → emulated（消息级）`、`multiTurn → unavailable（每轮新进程）`。

### 0.3 与 D3 矩阵 §2「ACP 首选」的口径差异（透明说明）

- `docs/research/capability-matrix.md:39` 把 opencode 的「首选通道」写成 **ACP over stdio**、v2 作备选；`docs/research/opencode.md` 早期实现要点也是「主通道 ACP + 备通道 v2」。
- **本规格按 D5b 契约取「v2 优先 + ACP 兜底」**，依据是 0.1/0.2 的实测：ACP 面缺中断、权限应答、运行中切模型，且默认 model 落在付费池；v2 面这些能力全部实测。若以 ACP 为主，四类控制动作仍要旁路 v2，等于“主通道更弱 + 双通道照旧”。
- 差异点保留待评审裁定；**不影响“双通道都要实现”的结论**。若回退为 ACP 主通道：中断降为进程 kill（丢当轮）、权限只能静态裁剪、模型切换走 `set_config_option` 缓存、事件映射改按 §5.3。

### 0.4 不选其他面的原因

- **不选 v1 文档路径**：`/session`、`/event`、`/agent`、`/doc` 在 2.1.4 回落到 SPA HTML（HTTP 200 但内容是 HTML）→ 按官方文档写的客户端会静默拿到 HTML（`opencode.md:339`、`:12`）。**只认 `GET /openapi.json`**（`opencode.md:212`）。
- **不选 `run --format json` 作主通道**：无控制面、无多路复用、事件仅消息级（`opencode.md:281-295`）→ 仅最后兜底/诊断。
- **不选 `opencode serve` 起服务并收集 stdout**：启动会把 **server password 明文打到 stdout**（`opencode.md:279`、`:336`；`repro/probe-opencode.sh` 头部纪律）→ 适配器不拥有 server、不收集其日志；鉴权只从 `OPENCODE_SERVER_PASSWORD` 注入。
- **不读 `~/.config/opencode/service.json` 明文**（`repro/probe-opencode.sh:5-11`）；不调用 `opencode auth export`（打印明文密钥）。

### 0.5 切换成本（v2 ⇄ ACP ⇄ CLI，同一 ABI 下）

| 成本项 | v2 → ACP（兜底） | ACP → v2（恢复） | v2 → CLI（最后兜底） |
|---|---|---|---|
| 连接 | ACP 客户端四件套（行协议/反向 handler/超时/会话缓存） | Basic auth + 服务发现 + SSE 重连 | 无需连接，spawn 子进程 |
| 控制面 | 丢失 interrupt/inbox/permission.reply/运行中切模型/agent/worktree | 恢复全部 | 全部丢失（无中断/权限/模型切换） |
| 事件 | ACP `session/update`（已实测 text/usage 子集，仍有权限/工具形状 TO-VERIFY） | SSE 26 类（已实测） | JSONL 消息级（text/error/step_start） |
| 模型 | 必须先 `set_config_option`（默认落付费池） | create 时直接下发 model | `-m` 显式 |
| 会话 | `session/load` | 同一 `sessionID` 再 prompt | `-s <id>` 续接 |
| 风险 | ACP 权限/cancel 未验证 | 共享 service 需按 sessionID 过滤事件 | 无中断；上下文靠会话 id |

---

## 1. 身份与版本

### 1.1 身份与版本断言

| 项 | 值 | 证据 |
|---|---|---|
| `backendId` | `opencode` | `docs/abi/schema/session.json` 的 `backendRef.id` 枚举 |
| 二进制 | `~/.opencode/bin/opencode`（214,407,424 B，mtime `Oct 26 1985`） | `opencode.md:19`、`:344` |
| 版本 | `opencode v2.1.4` | `opencode.md:18`；`repro/probe-opencode.sh §0` |
| `/api/info` | `{version:"2.1.4",pid,urls,paths,capabilities}` **实测** | `opencode.md §3.12` |
| ACP 协议版本 | `protocolVersion = 1`，`agentInfo.version = "2.1.4"` | `opencode.md:157`、`:168` |
| v2 HttpApi 指纹 | `openapi: 3.1.0`、`info.version: 0.0.1`、**124 paths**（必需 operationId 见 §12.3 OC-1） | `opencode.md:212-215` |
| 模型池 | `opencode models` → 39 条，10 条含 `free` | `opencode.md:322`、`§3.12` |
| 凭据 | `~/.local/share/opencode/auth.json` → `opencode-go`（`type:api`，key 51 字符 `oc_s…`）；`auth list` 显示 OpenCode Go + GitHub Copilot 均 stored | `opencode.md:11`、`:26`、`§3.12` |
| 数据/配置 | `~/.local/share/opencode`（DB）、`~/.config/opencode`、日志 | `opencode.md:20-23` |
| 后台 service | 随机端口（本机 `http://127.0.0.1:49374`） | `opencode.md:24`、`:40-41` |

握手期必须断言（失败 → `protocol.version-mismatch`，ABI §2.3）：

1. `opencode --version == "opencode v2.1.4"`（`opencode.md:18`、`:430`）；
2. `GET /api/info` 的 `version` 与二进制一致、`pid` 记录（**实测 `2.1.4`**，`opencode.md §3.12`）；
3. `GET /openapi.json`：`openapi=="3.1.0"`、`info.title=="opencode HttpApi"`、`paths` 数 == 124（基线）、**必需 operationId 全部存在**（§12.3 OC-1）；
4. ACP 兜底时：`initialize.protocolVersion==1`、`agentInfo.version=="2.1.4"`（`opencode.md:157`、`:168`）。

> **禁止**用二进制 mtime 判断版本（固定为 `Oct 26 1985`，`opencode.md:19`、`:344`）。版本钉住以 `upgrade [target]` 为前提（`opencode.md:430`），注册表仍记 `(binaryPath, sha256[:16], 实测 version, openapi path 数)`。

### 1.2 CapabilityDeclaration（A 组 15 位 + B 组相关位）

> **取值规则（2026-10-26 复测后）**：免费模型池下三通道均已端到端实测（`opencode.md §3.12`），因此状态位按“实测成立的语义”填；仅剩少数**未触发场景**（工具事件、子会话、ACP 权限/cancel、付费 key 回归）标约束/TO-VERIFY。`warnings[]` 必含：`paidKeyExpired`（`auth.credential-expired`，详见 §8.2）、`freeFallback`（`model=free-fallback`）、`sandboxModes=unavailable`、`concurrencyControl=unavailable（本地上限）`、`acpPermissionUnverified`。

| 能力位 | state | detail / constraint | 证据 |
|---|---|---|---|
| `headless` | native | `opencode run [--format json] [-m] [-s]`；**免费模型 rc=0**，付费 key 失效 rc=1 | `opencode.md:416`、`§3.12` |
| `streaming` | native | SSE 26 类过程事件实测（text/reasoning/step/usage/execution/inbox/permission）；**delta 为 chunk 级（≈50 字/条）** | `opencode.md §3.12`、`:367`、`:397` |
| `resumeSession` | native | `-s <id>` 实测同 sessionID 正确复述；HTTP 同一 `sessionID` 再 prompt 实测；ACP `session/load` | `opencode.md §3.12`、`:191` |
| `forkSession` | native | `POST .../fork{boundary}`；ACP `session/fork`；`run --fork`（端点/CLI 面已实测，端到端分叉未跑 → TO-VERIFY） | `opencode.md:230`、`:190`、`:320` |
| `listSessions` | native | `GET /api/session?limit/order/search`（跨项目 + 用量）；CLI `session list` 是 project 作用域，不用 | `opencode.md:224`、`:337` |
| `interruptTurn` | native | `POST .../interrupt?resume=true` → `{"interrupted":true}`、`session.execution.interrupted`、中断后可续；`resume=false` 对已结束轮 → `{"interrupted":false}`（幂等） | `opencode.md:229`、`§3.12` |
| `nativeSubagents` | native | `general`/`explore` 为 subagent；`POST /api/session{parentID}`；ACP `_meta` 子会话更新（父子事件未实测 → TO-VERIFY） | `opencode.md:323`、`:225`、`:164` |
| `toolExtension` | native | `mcp list/add`、`plugin *`、`GET /api/skill`、`~/.config/opencode/agent/*.md` | `opencode.md:423` |
| `permissionModes` | native | HTTP `permission.asked` + `reply{decision:once\|always\|reject}` 实测；ACP 只有 `build/plan`，`--auto` 不在 ACP mode | `opencode.md §3.12`、`:204`、`:341` |
| `sandboxModes` | **unavailable** | 二进制 `sandbox-exec/seatbelt/landlock/bubblewrap` 命中 0 | `opencode.md:326`、`:518` |
| `modelRouting` | native | 39 条别名（10 free）；`-m provider/model#variant`；`POST .../model`（运行中）；ACP `set_config_option`（66 项缓存） | `opencode.md:322`、`:231`、`:340`、`§3.12` |
| `concurrencyControl` | **unavailable**（证据缺口） | 未发现全局并发上限键；**由兼容层从运行时 `maxActiveSubagents` 派生，不写死数字** | `opencode.md:328`、`:417`；§9 |
| `usageReporting` | native | SSE `session.usage.updated{cost,tokens{input,output,reasoning,cache}}` + `session.step.ended` + `session.list`；ACP prompt 返回 `usage{…}` | `opencode.md §3.12`、`:250`、`:428` |
| `structuredProtocol` | native | v2 OpenAPI 3.1.0 + SSE；ACP JSON-RPC；错误 `_tag` JSON | `opencode.md:330`、`:212`、`§3.12` |
| `versionPinning` | native | `opencode upgrade [target] --method …` 支持指定版本 | `opencode.md:430` |
| `multiTurn` | native | HTTP 同会话多轮实测（续接成功）；ACP 同会话多轮（已实测 1 轮，重复轮次同构） | `opencode.md §3.12` |
| `steerTurn` | native | prompt body `delivery ∈ {steer,queue}`（OpenAPI）；实测默认 `delivery:"steer"` | `opencode.md §3.12`、`:227` |
| `inputInbox` | native | `GET/DELETE .../inbox`；`session.inbox.enqueued/delivered` 事件实测 | `opencode.md §3.12`、`:228` |
| `tokenLevelStream` | **unavailable** | delta 实测 chunk 级（149 字符/3 条 ≈50 字），非 token 级 | `opencode.md §3.12`、`:397` |
| `planUpdates` | unavailable | 无计划事件证据 | `opencode.md §8` |
| `diffUpdates` | emulated | 只有读面 `GET .../diff` 快照，无推送事件证据 | `opencode.md:237` |
| `tokenUsage` | native | 轮级 `session.usage.updated` / `session.step.ended` 实测 | `opencode.md §3.12` |
| `permissionAutoReply` | native | `reply{decision}` 实测 204；无人值守由策略自动答 | `opencode.md §3.12`、`:234` |
| `permissionRequestBridge` | native | `permission.asked` SSE + `GET /api/permission/request` + reply 实测 | `opencode.md §3.12`、`:235` |
| `childSessionUpdates` | native（ACP）/ emulated（v2） | ACP `_meta` 推送子会话更新；v2 只能 `session.list{parentID}` 轮询（均未端到端实测 → TO-VERIFY） | `opencode.md:164`、`:206`、`:238` |
| `sessionArchive` | unavailable | 无归档动作 | — |
| `sessionUnarchive` | unavailable | 无 | — |
| `sessionDelete` | native | `opencode session delete`；`DELETE /api/session/{id}` | `opencode.md:321`；OpenAPI |
| `sessionExport` | native | `opencode session export` | `opencode.md:321`、`:92` |
| `sessionReseed` | emulated | `POST /api/session` + 适配器注入交接摘要（ABI `seedSummary`） | `opencode.md:225` |
| `worktreeIsolation` | native | `POST/GET/DELETE /api/worktree` | `opencode.md:242` |
| `backgroundRuns` | native | 后台 service 常驻；`POST .../background` | `opencode.md:24`、`:236` |
| `processKillInterrupt` | native | 会话落库（DB），杀进程/重连后可续 | `opencode.md:22`、`:319` |
| `handshakeVersion` | native | `initialize.agentInfo.version` + `/api/info.version`（实测 2.1.4） | `opencode.md:168`、`§3.12` |

### 1.3 版本钉住与升级

- `upgrade [target]` 支持指定版本（`opencode.md:430`、`:64`）→ `versionPinning=native`；但**不自动升级**，只断言 + 告警。
- 升级可能改 `/api/*` 路径 → 以 OpenAPI 指纹（版本 + 124 path 基线 + 必需 operationId）断言；缺项 → `protocol.version-mismatch`（禁止降级猜测，v1 文档路径会回 HTML）。

---

## 2. 启动与握手

### 2.1 进程/服务模型

| 通道 | 模型 | 生命周期归属 |
|---|---|---|
| v2（默认） | 连接**已在运行的后台 service**（`opencode service status` → URL，`opencode.md:24`、`:40-41`；`repro/probe-opencode.sh §9`）；需要隔离时用 `--standalone` 起私有 server（`opencode.md:72`） | 适配器**不杀**共享 service；私有 server 由适配器作为子进程组管理（M9/中断时回收） |
| ACP（兜底） | `spawn opencode acp`，**一任务一进程**（stdio 生命周期，`opencode.md:84-85`） | 适配器拥有 pgid；M9 时 `killpg(SIGTERM)`，5s 后 SIGKILL |
| CLI（最后兜底） | `run` 一次性进程；`-s` 续接时起新进程 | 进程退出即结束；无常驻资源 |
| 禁止 | 启动 `opencode serve` 并收集 stdout（password 明文，`opencode.md:279`、`:336`） | 永不 |

- **共享 service 事件过滤**：SSE 会推送该 service 上**所有**会话的事件（`opencode.md:252-261`、`§3.12`）→ 适配器只处理自己持有的 `sessionID` 集合，其余丢弃并计数。
- **不拥有 server 的后果**：适配器崩溃后 server 里的会话可能继续跑 → 恢复必须先**对账**（§4.4），不能假设“适配器死 = 轮死”。

### 2.2 v2 握手序列（主通道，全部已实测）

```text
1) spawn ["opencode","service","status"] → http://127.0.0.1:<port>（`opencode.md:24`、`:40-41`）
2) → GET /api/info {version:"2.1.4",pid,urls,paths,capabilities}；记录 pid/urls
3) → GET /openapi.json（Basic auth）
   断言 openapi=="3.1.0"、paths==124、必需 operationId 齐全（§12.3 OC-1）
   失败 → protocol.version-mismatch（禁止按 v1 文档猜路径，`opencode.md:339`）
4) → opencode models（或 GET /api/model）：登记可用模型；免费池 = provider "opencode" 且 id 含 -free
   → 生产默认模型 providerID="opencode-go" → 走 §8.2 的凭据分级（free=可用 / paid=需有效 key）
5) → GET /api/agent（在目标 cwd/项目内调用；location 作用域，`opencode.md:338`）
   建立 agent 白名单（默认只允许 plan/只读自定义 agent，§7.3）
6) → GET /api/event（SSE，Basic auth）首事件 server.connected（`opencode.md:256`、`§3.12`）
   启动事件读线程 + 重连退避（1s/2s/4s…上限 30s）
7) → 产出 CapabilityDeclaration（§1.2），开始接 turn
```

- 鉴权：`Authorization: Basic base64("opencode:"+password)`；**只**从 `OPENCODE_SERVER_PASSWORD` 读（`opencode.md:276`、`:463`）。`Bearer`/`x-opencode-password` 均 401（`opencode.md:269-271`）；401 体 `{"_tag":"UnauthorizedError"}`（`opencode.md:274`）。
- **响应包络**：v2 多数端点返回 `{"data":…}`（列表另带 `cursor`），SSE 帧是裸事件对象（`opencode.md §3.12`、`§5` item 12）。
- 端口/URL 可能变化（`service restart`）→ 每次启动重新发现，不跨进程缓存。

### 2.3 ACP 握手序列（兜底，已实测跑通 turn）

```text
1) spawn ["opencode","acp"]，cwd=<worktree>，new process group
2) 注册反向 handler（fs/read_text_file、fs/write_text_file、terminal/*、session/request_permission）一律 fail-closed
3) → initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},
                 clientInfo:{name:"mocl",version:"0.1"}}
   ← {protocolVersion:1, agentCapabilities{loadSession, sessionCapabilities{list,resume,close,delete,fork,additionalDirectories},
       mcpCapabilities{http:true,sse:false}, _meta:{"opencode/child-session-updates":true}},
      authMethods[{id:"opencode-login",…}], agentInfo{version:"2.1.4"}}
   断言：protocolVersion==1；agentInfo.version=="2.1.4"；记录 _meta 子会话开关
4) → session/new {cwd:<abs>, mcpServers:<白名单>} → {sessionId:"ses_…", configOptions[model(66),mode(build/plan)]}
   ⚠ 实测默认 model 落在 opencode-go 池（opencode-go/iceman-contributor-free）→ 必须先 set_config_option 切可用模型
5) → session/set_config_option {sessionId, configId:"model", value:"opencode/deepseek-v4.1-flash-free"}
   ← configOptions 更新 + session/update:config_option_update
6) → session/prompt；结果含 stopReason:"end_turn" 与 usage（实测）
```

- `authMethods` 无 `type` 字段、描述是“Run `opencode auth login` in the terminal”（`opencode.md:166-167`）→ 无人值守**必须预先登录**，运行期不代答。
- 反向 handler 的 fail-closed 策略与 kimi 同构（`fs/read_text_file` 必须实现，否则可能静默挂起；ABI §4 要求 1）；opencode 是否真的调用该 handler 仍 **TO-VERIFY**（本机纯文本 turn 未触发）。

### 2.4 反向请求处理（ACP 兜底）

| 反向方法 | 策略 | 依据 |
|---|---|---|
| `fs/read_text_file` | **必须实现**：只读、`realpath` ⊆ allowed roots、≤1 MiB；越界 → error + `policy.sandbox-violation`，不挂起 | ABI §4 要求 1；（kimi 同类病理教训见 `docs/research/kimi.md:292-307`） |
| `fs/write_text_file` | 默认 deny；仅 `yolo` + worktree 放行 | ABI §10 SEC-3 |
| `terminal/*` | fail-closed error | 同上 |
| `session/request_permission` | 形状未验证（`opencode.md:415`）→ 一律 deny；总超时兜底 | ABI §10 SEC-3 |

### 2.5 预检（零额度；凭据分级，D-019）

1. `opencode --version`（`opencode.md:430`）；
2. `opencode service status` → URL（`opencode.md:40-41`）；无服务且不允许 standalone → `transport.connect-failed`；
3. `GET /api/info` + `GET /openapi.json`（可经 `opencode api GET /openapi.json` 自鉴权，`repro/probe-opencode.sh §7`）；
4. `opencode models` → **模型分级**：`opencode/*-free` 可用；`opencode-go/*` 需有效 key（`opencode.md:322`、`§3.12`）；
5. `opencode auth list`（只列 provider，不打值，`opencode.md:42-44`）；轻量 probe（可选）：用生产默认模型发一次 1 token 请求，401 即标记 `paidKeyExpired`（失败快、不计费）；
6. `opencode debug paths`（路径自检，`opencode.md:29-39`）；
7. ACP 兜底时：spawn + `initialize` + `session/new`（§2.3）。

**禁止**：`opencode auth export`；读 `service.json` 明文并打印；收集 `serve` stdout（`repro/probe-opencode.sh:5-11`）。

---

## 3. 会话生命周期

### 3.1 ABI 方法 → 三通道映射

| ABI 方法（`docs/abi/abi-v0.md` §6） | v2 主通道（实测） | ACP 兜底 | CLI 最后兜底 | 备注 |
|---|---|---|---|---|
| M2 `session.create` | `POST /api/session` body `{agent, model:{id,providerID}, location:{directory}, parentID?}` → `{"data":{id,…}}` | `session/new{cwd,mcpServers}` | `run`（隐含建会话） | `location` 作用域必须显式（`opencode.md:225`、`:338`） |
| M3 `session.send` | `POST /api/session/{id}/prompt {"text":…,"delivery"?}` → `{"data":{"id":"msg_…","delivery":"steer"…}}` | `session/prompt` | `run -s <id> "..."` | 运行中再发 → inbox（`turn.queued`）；`delivery ∈ {steer,queue}` |
| M4 `session.resume` | 同一 `sessionID` 再 `POST prompt`（实测） | `session/load` | `run -s <id>`（实测同 id） | §4 |
| M5 `session.interrupt` | `POST .../interrupt?resume=<bool>` → `{"interrupted":true\|false}`（实测） | 进程 kill（无 cancel） | 进程 kill | `interruptMethod`: v2=`native`，ACP/CLI=`process-kill` |
| M6 `session.query` | `GET /api/session/{id}` → `{data:{outcome,tokens,cost,time,…}}`（实测） | 本地账本 + `session/list` | 本地账本 | `outcome ∈ {succeeded,failed,interrupted}` |
| M7 `session.list` | `GET /api/session?limit/order/search` → `{data:[…],cursor}` | `session/list{cwd}` | `session list`（project 作用域） | Broker 注册表权威（`opencode.md:321`、`:337`） |
| M8 `session.recover` | 探测 + `GET /api/session/{id}` 对账 + 续 prompt | `session/load` + 对账 | `run -s` + 对账 | §4 |
| M9 `session.close` | 释放本地 + 取消 SSE 订阅；后端会话保留（显式删除走 `DELETE /api/session/{id}`，默认禁止） | `session/close` + 杀进程组 | 进程自然退出 | 删除是破坏性操作（BRIEF 安全默认） |
| M10 `session.fork` | `POST .../fork{boundary:{type:"through",messageID}}` | `session/fork` | `run --fork` | 保留原会话与分叉点（`opencode.md:230`） |
| M11 `session.archive` | 无动作（tombstone） | 无动作 | 无动作 | `sessionArchive=unavailable`（ABI R-10） |
| M12 `session.respond` | `POST .../permission/{requestID}/reply {"decision":"once\|always\|reject"}` → `204`（实测） | 反向应答（形状 TO-VERIFY） | 无 | 见 §7.2 |
| M13 `session.steer` | 运行中 `POST .../prompt`（`delivery:"steer"`） | 不可用 | 不可用 | `steerTurn=native`（v2） |
| M14 `session.setMode` | 无 mode 端点 → 用 agent 切换 `POST .../agent` | `session/set_mode` / `set_config_option{mode}` | `--agent` | ACP 只有 build/plan（`opencode.md:204`） |
| M15 `session.setModel` | `POST .../model`（运行中） | `set_config_option{configId:"model"}`（**无 set_model**，`-32601`） | `-m` | 付费/免费分级见 §8.2 |
| M16/M17 订阅/重放 | SSE（`evt_…`/`durable.seq`）+ 本地 journal | ACP `session/update` + journal | 本地 journal + `-s` 对账 | §5 |

### 3.2 权限模式映射（三档 × 通道；**不按名字透传**）

| ABI `permissionProfile` | v2 主通道 | ACP 兜底 | 依据 |
|---|---|---|---|
| `read-only` | `agent:"plan"`（只读 agent，`opencode.md:115-116`）+ 拒绝一切需写的 permission reply | `session/set_mode{plan}` + 白名单 | 实测 `plan` 模式只讨论不改文件（`opencode.md §3.12`） |
| `safe-auto` | `agent:"build"` + 权限应答策略：只读操作 `allow-once`，写/执行按规则；**不持久放行** | `plan` + 显式允许白名单（没有 auto mode） | ABI 三档语义；`--auto` 不在 ACP mode（`opencode.md:341`） |
| `yolo` | `--auto` 语义（“Auto-approve permissions that are not explicitly denied”，`opencode.md:57`）+ worktree + 显式开启 | 不可用 | ABI SEC-4 |
| 人工审批 | 默认 `build` + reply `ask`（无人值守 → deny） | `build` + 反向请求 deny | ABI R-6/R-7 |

- `--auto` 只能经 CLI/API 层（`opencode.md:57`、`:341`）；ACP 无对应 mode。
- 权限变更后校验：ACP 读 `configOptions.mode`；v2 读 `session.list.agent`。
- **默认 agent 全放行**：`build` 的默认规则 `{"action":"*","resource":"*","effect":"allow"}`，仅 `*.env*` 为 `ask`（`opencode.md:108-109`、`:444`）→ 不显式指定 agent 等于 yolo，必须拒绝创建。

### 3.3 状态机映射（ABI `state` 枚举见 `session.json`）

| 阶段 | 触发 | ABI `state` | 事件 |
|---|---|---|---|
| 建会话 | `POST /api/session` 成功 | `created` → `running`（首轮） | `session.created` → `session.state-changed` |
| 轮进行中 | prompt 接受（返回 `Session.Inbox.User`） | `running` | `turn.started`（`acceptedAtSeq` 用 inbox 接受点） |
| 运行中追加 | 再发 prompt / inbox | `running` | `turn.queued` → 轮次开始后 `turn.started` |
| 轮结束 | SSE `session.execution.succeeded` / `GET session.outcome=succeeded` | `completed` | `turn.completed` |
| 轮失败 | SSE `session.execution.failed` / `outcome=failed` | `blocked`（可重试）/`completed` | `turn.failed` |
| 中断 | interrupt 端点 + `session.execution.interrupted` / `outcome=interrupted` | `aborted`（当轮）；`resume=true` 时会话仍可用 | `turn.aborted{interruptMethod:"native"}` |
| 失联 | SSE 断开 / 适配器崩溃 | `lost` | `session.lost` → 冷恢复 |
| 恢复中 | 对账 + 续 prompt/load | `recovering` → `running/completed` | `session.recovered` |
| 关闭 | M9 | `archived`（Broker 侧） | `session.closed`（ABI §7.1） |

> 对账权威字段：`GET /api/session/{id}` 的 `outcome ∈ {succeeded,failed,interrupted}`、`time{created,updated,idle}`、`tokens/cost`、`fork`、`location`（`opencode.md:250`、`§3.12`）。

### 3.4 最小可运行示例（建会话 → 一轮 → 续接，**本机已验证**，24 行）

> **状态**：**本机已验证（2026-10-26）**——免费模型 `opencode/deepseek-v4.1-flash-free`，HTTP v2 建会话/一轮/续接全部成功，`outcome:"succeeded"`，续接后正确复述（`docs/research/opencode.md §3.12`）。生产默认 `opencode-go/deepseek-v4.1-flash` 在 key 过期时走 §8.2 降级。
> 运行前提：后台 service 在跑、`OPENCODE_SERVER_PASSWORD` 已注入（不读 `service.json` 明文）。

```python
# opencode_v2_min.py —— v2 HttpApi：建会话 → 一轮 → 续接（2026-10-26 本机实测通过）
import base64, json, os, urllib.request
URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:49374")
PW = os.environ["OPENCODE_SERVER_PASSWORD"]               # 只从环境注入
AUTH = "Basic " + base64.b64encode(f"opencode:{PW}".encode()).decode()

def api(method, path, body=None, timeout=180):
    req = urllib.request.Request(URL + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")

info = api("GET", "/api/info")                            # 实测 version=2.1.4
print("server", info.get("version"), "pid", info.get("pid"))
ses = api("POST", "/api/session", {                       # 建会话；子会话加 parentID
    "agent": "plan",
    "model": {"id": "deepseek-v4.1-flash-free", "providerID": "opencode"},
    "location": {"directory": "/tmp"}})
sid = ses["data"]["id"]; print("session", sid)
for text in ("只回复两个字符：OK", "上一条你回复了什么原文？只回复那两个字符"):
    acc = api("POST", f"/api/session/{sid}/prompt", {"text": text})
    print("accepted:", acc["data"]["id"], acc["data"]["delivery"])   # 第 2 轮=同会话续接
    for _ in range(60):
        cur = api("GET", f"/api/session/{sid}")["data"]
        if cur.get("outcome") in ("succeeded", "failed", "interrupted"):
            print("outcome:", cur["outcome"], "tokens:", cur.get("tokens"))
            break
```

**实测预期**：`server 2.1.4 pid <n>` → `session ses_…` → 两轮 `accepted: msg_… steer` + `outcome: succeeded`，第二轮复述 `OK`。
**生产实现还需**：`/openapi.json` 断言、SSE 读线程 + 重连、权限应答策略、超时/中断、模型降级（§8.2）——示例为突出最小路径而省略。

### 3.5 模型降级时序（D-019）

```text
create(session):
  model = 调用方指定 or 生产默认 opencode-go/deepseek-v4.1-flash
  if providerID == "opencode-go":
      if 预检 paidKeyExpired:
          choose model = opencode/deepseek-v4.1-flash-free        # 同系列免费模型
          degradeWarnings += {code:"auth.credential-expired", model:"free-fallback"}
      else: 使用 paid model
  send(turn):
      SSE session.execution.failed{error.type=="provider.auth", status:401}
        → 标记 auth.credential-expired；**不重试同一轮**
        → 若会话模型是 paid：切换 model=opencode/deepseek-v4.1-flash-free
        → 发 session.warning{code:"model.free-fallback", degrade:true} + 结果字段 model=free-fallback
        → 由调用方决定是否重发该轮（ABI M8/上层策略），适配器不静默重试
```

---

## 4. 续接与恢复（含幂等/去重、恢复判定）

### 4.1 持久化映射记录（Broker 侧）

```json
{
  "sessionId": "sess_01J9...",
  "backendId": "opencode",
  "backendSessionId": "ses_e8c264ec2ffe...",
  "channel": "http-v2",              // http-v2 | acp | cli-run
  "serverUrl": "http://127.0.0.1:49374",
  "serverPid": 81392,
  "location": "/abs/worktree",
  "agent": "plan",
  "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode" },
  "modelFallback": false,            // D-019：true=free-fallback
  "epoch": 3, "lastSeq": 96, "lastTurnId": "turn_01J9...",
  "lastInboxId": "msg_...",          // prompt 幂等锚
  "lastDurableSeq": 19,              // SSE durable.seq（会话内后端顺序）
  "openapiPaths": 124,
  "journalChecksum": "…"
}
```

Broker 注册表为权威；`GET /api/session` 只作校准（`opencode.md:224`、`:250`）；CLI `session list` 因 project 作用域不作判据（`opencode.md:337`）。

### 4.2 续接判定算法（确定性、可单测）

```text
R0. 载入映射；校验 journal 校验和与字段完整性
    ├─ 失败/歧义 → session.mapping-corrupt：orphan 隔离，不自动重绑；
    │   后端会话可能仍存在（DB 持久，opencode.md:22）→ M8 strategy=manual 人工候选
    └─ 通过 → R1
R1. 按 channel 探测：
    ├─ http-v2：GET /api/session/{id}（实测）
    │   ├─ 404/无 data → 再试 ACP session/load → 仍无 → session.invalidated → R-1（reseed 或 aborted）
    │   ├─ outcome ∈ {succeeded,failed,interrupted} → 补终态事件 + 状态对齐
    │   └─ outcome 为空/仍在跑（time.updated 推进）→ 重连 SSE 观察，**不重发 prompt**
    ├─ acp：session/load{sessionId,cwd}（opencode.md:191）
    └─ cli-run：`run -s <id> "ping"` 轻量探测（同一 sessionID 能续 = 有效）
R2. 续接：HTTP 同一 sessionID 再 prompt（实测）／ACP load 后 prompt／CLI -s
    epoch+1 → session.replay(fromSeq) → session.recovered
R3. 首轮若命中 auth.* → 会话 blocked，按 §8.2 降级/告警，不循环重试
```

- **核心不变量**：适配器崩溃/重启**不等于**轮次失败——server 可能继续跑（共享 service，`opencode.md:24`、`:328`）。恢复先对账（outcome/time/tokens），再决定“补终态 / 重连观察 / 新开轮”。
- **R-1 必测**（ABI §3.5）：会话失效时 `session.recover` 必须“reseed 或 aborted”二选一且两次调用同结果（幂等），不得抛裸异常。
- SSE 断点续传（`Last-Event-ID`）未验证（`opencode.md §8`）→ 只允许用 journal + 读面对账补齐，**不伪造**后端事件；补发事件保留原 `eventId/seq/ts`（ABI §7.9）。

### 4.3 幂等与去重（三条硬规则）

1. **写操作幂等键**：`clientRequestId` 作用域 `(sessionId, method)`；`session.create` 作用域 `(backendId, clientRequestId)`（ABI §9.1）。同键不同载荷 → `session.conflict`。
2. **prompt 的幂等锚 = 返回的 `Session.Inbox.User.id`（`msg_…`）**（`opencode.md:227`、`§3.12`）：
   - 发出前写 `intent`（载荷 SHA-256）；收到 `{"data":{"id":…}}` 写 `committed`；
   - 超时/断线**禁止盲目重发**：先 `GET .../inbox` / `GET .../message` 对账；已入队未开始可 `DELETE .../inbox/{inboxID}` 撤销；已开始/完成 → 不重发，重放同 `clientRequestId` 返回同一 `turnId` + `deduplicated:true`；
   - prompt body 支持 `resume` 字段（OpenAPI `Session.Inbox` 面），但语义未逐项验证 → 仅作续接提示，不作为幂等依据。
3. **事件去重**：SSE 帧带 `id:"evt_…"`（`opencode.md:256`、`§3.12`）→ 按该 id 去重；ABI `seq` 严格 +1（EV-1），旧 `epoch` 事件丢弃（EV-3）；`durable.seq` 记录后端顺序用于对账（不作为 ABI `seq`）。

### 4.4 恢复判定矩阵（故障 × 处置）

| 故障 | 判定依据 | 处置 | ABI 事件/错误码 |
|---|---|---|---|
| SSE 断开 | 读线程 EOF/异常 | 重连（退避）；期间 `lost` | `transport.state-changed`(degraded) → `session.lost` → `session.recovered` |
| 适配器崩溃（server 存活） | 重启后 `GET /api/session` 有会话 | 对账：完成→补终态；运行→重连 SSE；空闲→`lost` | `session.recovered`（`replayedEvents` 如实计数） |
| 服务端重启/端口变化 | `/api/info` 不可达或 pid 变化 | 重新发现 URL；会话在 DB 则续接 | `transport.connect-failed` → `session.resume-failed` |
| 会话不存在 | 404/无 data；ACP load 报错 | R-1：reseed 或 aborted | `session.invalidated` / `session.not-found` |
| 映射损坏 | journal 校验失败/歧义 | orphan 隔离，人工 rebind | `session.mapping-corrupt` |
| 中断（M5） | `POST interrupt` 返回 `{"interrupted":true}` | 当轮 `aborted`；`resume=true` 会话可续（实测） | `turn.aborted{interruptMethod:"native"}` |
| 中断幂等 | 已结束会话 `resume=false` | 返回 `{"interrupted":false}`，不报错 | M5 `deduplicated:true` |
| 权限无人应答 | reply 超时 | 默认 deny + 继续/终止（按策略） | `permission.resolved{decision:"deny",by:"policy"}` |
| 付费 key 过期 | `provider.auth` 401 `api_key_expired` | 不重试；降级 free + 显式告警（D-019） | `auth.credential-expired` → `session.warning{model.free-fallback}` |
| 限流 | 429（形态 TO-VERIFY） | 退避 ≤5，尊重 Retry-After | `quota.rate-limited`（ABI AB-V4） |
| 轮超时 | `maxTurnMs` | 优先 HTTP interrupt；不可用则进程 kill | `limit.turn-timeout` → `turn.aborted{timeout}` |

### 4.5 CLI `run` + `-s` 兜底通道（D-019，**本机已验证**）

> 当 v2 与 ACP 同时不可用（或调用方只要一次性执行）时启用。**能力边界**：每轮一个进程、消息级事件、无中断/权限/运行中模型切换；续接靠 `-s <sessionID>`。

```bash
# 一轮（本机实测 rc=0，免费模型）
~/.opencode/bin/opencode run "只回复两个字符：OK" --format json -m opencode/deepseek-v4.1-flash-free
# → {"type":"text",…,"sessionID":"ses_e8c27271…","part":{…,"text":"OK"}}

# 续接（同一 sessionID；本机实测正确复述）
~/.opencode/bin/opencode run -s ses_e8c27271… "上一条你回复了什么原文？只回复那两个字符" \
      --format json -m opencode/deepseek-v4.1-flash-free
```

适配器侧规则：
- `backendSessionId` 从 JSONL 的 `sessionID` 提取（与 ABI 的 `sess_` 分开记账）；
- 每轮新进程 → ABI `multiTurn` 在 CLI 通道降级为 `emulated`（每轮 session.create + 续接同 id）；
- 进程退出码非 0 且有 `type:"error"` → `turn.failed`（映射见 §10.2）；
- 无中断 → M5 为 `process-kill`（ABI R-3），杀后 `-s` 续接。

---

## 5. 流事件映射

### 5.1 原则与现状

- 事件名唯一权威 = `docs/abi/abi-v0.md` §7；原生名只出现在本文左列（ABI §0 规则 2）。
- **v2 SSE 事件全集已实测**（26 类，`opencode.md §3.12`）；仍未知的只有：工具调用事件（未触发工具）、子会话事件、免费池 429 形态。
- SSE 帧：`{id:"evt_…",created:<ms>,type,location:{directory},data:{…},durable?:{aggregateID,seq,version}}`；`data` 行 + `: heartbeat`。
- 无法映射的 type → 丢弃 + 计数（`abi.warning` 级），不伪造 ABI 事件（ABI §7 前言、§13.2）。

### 5.2 v2 HttpApi / SSE → ABI（逐条，含丢弃项；2026-10-26 实测）

| # | 原生来源 | 关键字段 | ABI 事件 / 处置 | 说明与证据 |
|---|---|---|---|---|
| 1 | `GET /api/info` | `{version,pid,urls,paths,capabilities}` | **无事件**（握手断言） | 实测 version=2.1.4（`§3.12`） |
| 2 | `POST /api/session` | `{"data":{id,agent,model,location,…}}` | `session.created{state,cwd,label}` | `backendSessionId` 回填；`§3.12` |
| 3 | `POST .../prompt` 响应 | `{"data":{id:"msg_…",type:"user",delivery,time,…}}` | `turn.started{model,delivery,inputDigest}` | `acceptedAtSeq`=接受点；delivery=steer\|queue（`§3.12`） |
| 4 | SSE `session.created` | `{sessionID,slug,version,projectID,location}` | `session.created`（与 #2 去重，只发一次） | `§3.12` |
| 5 | SSE `session.inbox.enqueued` | `{inboxID,sessionID,item{type:"user",payload{text}}}` | `turn.queued{turnId,queuePosition}` | queuePosition=inbox 长度；`§3.12` |
| 6 | SSE `session.inbox.delivered` | `{sessionID,inboxID}` | **丢弃**（内部投递确认） | 计数；`§3.12` |
| 7 | SSE `session.execution.started` | `{sessionID}` | `turn.started`（若 #3 已发则内部标记） | `§3.12` |
| 8 | SSE `session.execution.succeeded` | `{sessionID}` | `turn.completed{stopReason:"end-turn",usage}` | 一轮唯一终态；`§3.12` |
| 9 | SSE `session.execution.interrupted` | `{sessionID,reason:"user"}` | `turn.aborted{interruptMethod:"native",partial:true}` | 实测（`§3.12`） |
| 10 | SSE `session.execution.failed` | `{sessionID,error:{type,message,status,…}}` | `turn.failed{error,partial:false}` | 错误码映射 §10.2；实测 401 场景（`§3.12`） |
| 11 | SSE `session.step.started` | `{sessionID,agent,model{…}}` | **无 ABI 事件**（内部步标记） | 计数；`§3.12` |
| 12 | SSE `session.step.streamed` | `{sessionID,assistantMessageID}` | **丢弃**（内部流标记） | 计数；`§3.12` |
| 13 | SSE `session.step.ended` | `{sessionID,finish,rawFinish,cost,tokens{…}}` | `usage.updated{usage{…},estimated:false,scope:"turn"}` | 轮级用量；`§3.12` |
| 14 | SSE `session.step.failed` | `{sessionID,assistantMessageID,error:{type:"aborted"/…,message}}` | `tool.failed`（`type:"aborted"` 时改发 `turn.aborted`，不重复终态） | 中断路径实测；`§3.12` |
| 15 | SSE `session.text.started` | `{sessionID,assistantMessageID,ordinal}` | `message.started{channel:"assistant",messageId}` | messageId=assistantMessageID；`§3.12` |
| 16 | SSE `session.text.delta` | `{sessionID,assistantMessageID,ordinal,delta}` | `message.delta{channel:"assistant",text:delta,granularity:"message",messageId}` | **chunk 级（≈50 字）**，非 token；`§3.12` |
| 17 | SSE `session.text.ended` | `{sessionID,assistantMessageID,ordinal,text:"全文"}` | `message.completed{channel:"assistant",text,messageId}` | 权威全文；`§3.12` |
| 18 | SSE `session.reasoning.started/delta/ended` | 同上（`delta`/`text`） | `reasoning.delta{granularity:"message"}` / `reasoning.summary{text}` | 默认不进父会话（ABI §11.2）；`§3.12` |
| 19 | SSE `session.usage.updated` | `{sessionID,cost,tokens{input,output,reasoning,cache{read,write}}}` | `usage.updated{usage{inputTokens,outputTokens,reasoningTokens,costUsd,durationMs},estimated:false,scope:"turn"}` | 实测；`§3.12` |
| 20 | SSE `permission.asked` | `{id:"per_…",sessionID,action,resources,save,source{type:"tool",messageID,id}}` | `permission.requested{requestId:per_,tool,risk,options,summary}` | risk 由 action 推（read→read、edit/write→write、bash→execute）；`§3.12` |
| 21 | `POST .../permission/{id}/reply` | `{"decision":"once\|always\|reject"}` → `204` | `permission.resolved{requestId,decision,by:"policy"}` | once→allow-once、always→allow-always、reject→deny；`§3.12` |
| 22 | SSE `session.instructions.updated` | `{sessionID,delta}` | **丢弃**（系统提示注入，非业务） | 计数；`§3.12` |
| 23 | SSE `server.connected` | `{}` | **丢弃**（等价信号 → `transport.state-changed{state:"ready"}`） | 首事件；`opencode.md:256` |
| 24 | SSE `: heartbeat` | 注释行 | **丢弃**（仅续 idle） | `opencode.md:258` |
| 25 | SSE 重复 `data.id` | 同 `evt_…` | **丢弃**（去重） | `§3.12` |
| 26 | 其他会话的 SSE 事件 | `sessionID` ∉ 持有集合 | **丢弃 + 计数**（共享 service 必须过滤） | `opencode.md:24`、`:328` |
| 27 | SSE catalog 噪声（9 类） | `integration/provider/model/agent/command/skill/websearch/reference/plugin.updated` | **丢弃 + 计数** | 实测必须过滤；`§3.12` |
| 28 | `GET /api/session/{id}/message` | `{data:[{type:"assistant",content:[…],finish,tokens,cost}],cursor}` | 恢复期对账补发 `message.completed`/`turn.completed`（`usage.estimated:true`） | 仅恢复期；`§3.12` |
| 29 | `GET .../diff` | 文件改动快照 | `diff.updated{files[],patch?}`（快照，非增量） | `opencode.md:237`；无推送事件（`diffUpdates=emulated`） |
| 30 | `GET /api/session` 条目 | `tokens{cost,outcome,time,fork,location}` | `usage.updated{scope:"session"}` + 终态对账 | `opencode.md:250`、`§3.12` |
| 31 | `POST .../interrupt?resume=` | `{"interrupted":true\|false}` | `turn.aborted`（true）；false 时幂等响应不产事件 | `§3.12` |
| 32 | `POST .../fork` | `{"data":{…}}` | `session.created`（新 sessionId）+ fork 关系 | `opencode.md:230` |
| 33 | `POST /api/worktree` | `worktree.create` | **无事件**（隔离准备，写会话元数据） | `opencode.md:242` |
| 34 | HTTP 401 `_tag:UnauthorizedError` / provider 4xx | 见 §10.2 | `turn.failed` / `auth.*` | `§3.12`、`opencode.md:274` |

### 5.3 ACP 兜底 `session/update` → ABI（已实测子集）

| # | 原生（ACP） | ABI 事件 | 状态 |
|---|---|---|---|
| 35 | `session/prompt` 结果 `{stopReason:"end_turn",usage{inputTokens,outputTokens,totalTokens,cachedReadTokens}}` | `turn.completed{stopReason:"end-turn",usage}` | **已实测**（`§3.12`、`opencode.md:193`） |
| 36 | `agent_message_chunk{messageId,content:{type:"text",text}}` | `message.delta{granularity:"message",messageId}`；轮末补 `message.completed` | **已实测**（`§3.12`） |
| 37 | `usage_update{used,size,cost{amount,currency}}` | `usage.updated{usage{…},estimated:true,scope:"turn"}` | **已实测**（`§3.12`）；`cost` 可映射 costUsd |
| 38 | `config_option_update{configOptions}` | 内部配置缓存；模式漂移 → `session.warning` | **已实测**（`§3.12`） |
| 39 | `available_commands_update` | **丢弃 + 计数** | **已实测**（`§3.12`） |
| 40 | `tool_call` / `tool_call_update` | `tool.started/progress/completed/failed` | **TO-VERIFY**（纯文本轮未触发工具） |
| 41 | `session/request_permission` | `permission.requested` + 本地应答 | **TO-VERIFY**（未触发；形状未知，`opencode.md:415`） |
| 42 | 子会话 `session/update`（`sessionId` 可能为子会话 id，`_meta` 已开） | `child.*`（按 sessionId 分组） | **TO-VERIFY**（`opencode.md:164`、`:206`） |
| 43 | `session/set_model` → `-32601` | **不调用**（改 `set_config_option`） | 已确证（`opencode.md:189`） |
| 44 | `session/cancel` | 不调用（未验证） | TO-VERIFY（`opencode.md:416`） |

### 5.4 CLI `run --format json` → ABI（最后兜底）

| # | 原生（JSONL） | ABI 事件 / 处置 | 状态 |
|---|---|---|---|
| 45 | `{"type":"text","part":{id,sessionID,messageID,type:"text",text,time}}` | `message.completed{channel:"assistant",text,messageId}`（一次成文，无 delta） | **已实测**（`§3.12`） |
| 46 | `{"type":"step_start","part":{…}}` | `turn.started`（首条；`messageId` 取 part） | 已实测（`opencode.md:285-287`） |
| 47 | `{"type":"error","error":{type,message,status,response.body}}` | `turn.failed{error}`（映射 §10.2） | **已实测**（付费 key 401，`§3.12`） |
| 48 | `{"type":"step_finish","part":{reason:"stop",cost,tokens{input,output,reasoning,cache}}}` | `turn.completed{stopReason:"end-turn",usage}`（CLI 消息级终态） | **已实测**（2026-10-26，`repro/probe-opencode.sh §11`） |
| 49 | 其他 `type` | 丢弃 + 计数 | 未观测 |

### 5.5 丢弃项汇总（必须计数）

| 原生项 | 原因 | 计数键 |
|---|---|---|
| `: heartbeat` | 保活 | `drop.sse_heartbeat` |
| 重复 `data.id` | 重投 | `drop.sse_duplicate` |
| 非本适配器会话事件 | 共享 service | `drop.foreign_session_event` |
| catalog 噪声 9 类 | 与任务无关 | `drop.catalog_event` |
| `session.inbox.delivered` / `session.step.started` / `session.step.streamed` / `session.instructions.updated` | 内部标记/系统注入 | `drop.internal_event` |
| `available_commands_update`（ACP） | 与编排无关 | `drop.acp_commands` |
| 未知 SSE `type` | 未回填 | `unmapped.sse_type.<type>` |

### 5.6 折叠与限流

- delta 是 **chunk 级（≈50 字/条）**（`§3.12`）→ `message.delta` 的 `granularity:"message"`；不宣称 token 级（`tokenLevelStream=unavailable`）。
- 适配器不把 SSE 原始帧直接推父会话；L3 按 `progress.folded` 采样（默认 5000ms，ABI §11.2）。
- 单 SSE 连接多会话：按 `sessionID` 过滤后再归一化，避免跨会话 `seq` 污染（ABI EV-1）。
- 背压：读线程与归一化线程解耦；高水位丢弃可折叠事件，保留终态。

---

## 6. 原生子代理与嵌套

### 6.1 证据

- 内置 agent：`build`/`plan`（primary）、`general`/`explore`（subagent）、`compaction`/`title`/`summary`（hidden primary）（`opencode.md:105-122`、`:323`）。
- 自定义 agent：`~/.config/opencode/agent/*.md`（**单数生效**，文档写复数；两种都要探测，`opencode.md:125-140`、`:342`），可带 `mode: subagent`、`model`、`permission` 覆写（`opencode.md:127-137`）。
- 子代理 = **子会话**：`POST /api/session{parentID}`（`opencode.md:225`）；`session.list` 用 `parentID`/`fork` 表达（`:238`）；ACP `_meta:{"opencode/child-session-updates":true}`（`:164`、`:206`）；二进制 `parentSessionID/childSessionID`（`:151`）。
- `[文档]`：子代理可被 primary 自动调用或 `@` 提及；`permission.task` 控制可调子代理（`:147`）；`maxSteps` 限单 agent 迭代（`:148`）。

### 6.2 适配器策略

- `nativeSubagents=native`；`childSessionUpdates`：ACP **native**（`_meta` 推送，按 `sessionId` 分组）；v2 **emulated**（`GET /api/session` 按 `parentID` 轮询，1–2s 去重）。
- **两个通道的子会话事件形状均未端到端实测** → 标 TO-VERIFY（§8）；未验证前只承诺终态 `child.completed`，中间过程折叠进父摘要（ABI R-14）。
- **深度上限由兼容层强制**：未发现原生 `max_depth` 键（`opencode.md:328`、`:417`）→ 默认 `maxNestingDepth=1`，更深 → `limit.nesting-exceeded`；也可用 `permission.task`（`:147`）静态禁止子代理调用。
- 只用白名单 agent id；不从自定义 agent 文件推断编排语义。

---

## 7. 权限与沙箱

### 7.1 三档语义映射

见 §3.2。补充：
- ACP 面只有 `build`/`plan`（`opencode.md:204`、`:341`）：`read-only→plan`；`safe-auto→plan+白名单`；`yolo` 在 ACP **无对应 mode**（必须显式禁止或走 v2）。
- `--auto` 语义 = 自动批准未被显式拒绝的权限（`opencode.md:57`）≈ safe-auto 上限；**不在 ACP mode 里**（`:204`）。
- 档位变更后校验：ACP 读 `configOptions.mode`；v2 读 `session.list.agent`。

### 7.2 权限请求应答（**v2 已实测**）

| 通道 | 请求 | 应答 | 状态 |
|---|---|---|---|
| v2 | SSE `permission.asked{id:"per_…",action,resources,save,source{type:"tool",messageID,id}}`；另有 `GET /api/permission/request`（**location 作用域**） | `POST /api/session/{id}/permission/{requestID}/reply {"decision":"once\|always\|reject"}` → `204` | **已实测**（`opencode.md §3.12`、`:234-235`） |
| ACP | 反向 `session/request_permission` | 本地应答（fail-closed deny） | 形状未验证（`opencode.md:415`）→ deny + 总超时兜底 |

- ABI 映射：`once→allow-once`、`always→allow-always`、`reject→deny`；`by:"policy"`（无人值守）。无匹配/超时 → `deny` + `policy.escalation-required`。
- `GET /api/permission/request` **必须带 `location[directory]`**（deepObject）；不带时按服务端 cwd 返回空数组（实测坑，`opencode.md §5` item 14）。

### 7.3 安全默认（默认全放行 → 必须显式收窄）

- `build` 默认 `{"action":"*","resource":"*","effect":"allow"}`，仅 `*.env*` 为 `ask`（`opencode.md:108-109`、`:444`）；本机 `opencode.jsonc` 几乎为空（`:21`）→ 无隐式收窄。
- 硬规则：① 建会话**必须显式** `agent:"plan"` 或白名单只读 agent；② 未指定 → `policy.sandbox-violation` 拒绝创建；③ 自定义 agent 的 `permission` 段不可信（可能 `bash: allow`，`:132-134`）→ 只允许运维登记过的 id。
- 权限键全集可静态裁剪：`read, edit, glob, grep, list, bash, task, todowrite, external_directory, webfetch, websearch, lsp, skill, question, doom_loop`，取值 `ask|allow|deny`，last match wins（`[文档]`，`opencode.md:146`）。

### 7.4 沙箱：**无 OS 级沙箱**（已知残余风险）

- 否证：二进制 `sandbox-exec/seatbelt/landlock/bubblewrap` 命中 0（`opencode.md:326`、`:518`；`repro/probe-opencode.sh §7`）。
- 可用隔离（均非 OS 级）：① **worktree** 原生端点（`:242`）；② 权限规则 + 只读 agent（`:146`）；③ `--standalone` 私有 server（`:72`）/`--server` 受控实例。
- **残余风险（进风险登记册）**：v2 后台 service 默认与用户其他客户端共享（`:328`）；`build` 默认全放行；无 OS 级强制 → 误用 `build`/非 worktree cwd 时越界读写与 `bash` 不可逆。处置：默认 `read-only`（plan）+ 强制 worktree + 事后 diff 审计；`yolo` 必须 worktree 且显式开启，否则 `policy.sandbox-violation`（ABI SEC-4）。

### 7.5 认证相关权限面

- 凭据类端点（`/api/credential`、`/api/integration/{id}/connect/*`，`opencode.md:245`）**默认禁用**：无人值守不代答 OAuth/设备码；需新凭据 → `blocked` + 提示人工（`auth.login-required`）。

---

## 8. 认证与模型路由

### 8.1 Server 鉴权（v2 主通道，已实测）

- **HTTP Basic**，user=`opencode`，password 来自 `OPENCODE_SERVER_PASSWORD`（`opencode.md:25`、`:266-276`、`:463`）。
- 实测：`Basic` → 200；`Bearer` → 401；`x-opencode-password` → 401（`:267-271`）；未鉴权 `/openapi.json` → `{"_tag":"UnauthorizedError"}`（`:273-275`）。
- **禁止**：收集 `serve` stdout（password 明文，`:279`）；把 `service.json` 内容写入日志/文档（`repro/probe-opencode.sh:5-11`）。

### 8.2 Provider 凭据、默认模型与降级（D-019）

**事实（2026-10-26 复测，`docs/research/opencode.md §3.12`）**：

1. 凭据存在：`~/.local/share/opencode/auth.json` → `opencode-go`（`type:api`，key `oc_s…` 51 字符）；`opencode auth list` 显示 `OpenCode Go / API key stored` + `GitHub Copilot / stored`。
2. **付费 key 已过期**：生产默认模型 `opencode-go/deepseek-v4.1-flash` → `provider.auth` / 401 `api_key_expired`（原文：“This API key has expired. … Signing in again will not renew this key.”）；**重新登录不续期**，必须到 OpenCode Console 新建 key 后替换（`opencode auth login` 或直接改 auth.json）。
3. **免费池可用**：`opencode/*-free`（如 `opencode/deepseek-v4.1-flash-free`、`opencode/glm-5.3-flash-free`、`big-pickle`、`beam-free` 等）CLI/HTTP/ACP 三通道实测跑通；`opencode models` 39 条 / 10 条含 `free`。
4. **默认启用**：`enabled:true`（免费模型即可工作），不再以“无凭据”为由禁用。

**适配器规则**：

| 规则 | 要求 |
|---|---|
| 模型分级 | `providerID=="opencode"` 且 id 含 `free` = 免费池（默认可用）；`providerID=="opencode-go"` = 付费池（需有效 key；名字带 `-free` 也仍属付费 provider） |
| 生产默认 | `opencode-go/deepseek-v4.1-flash`（用户口径）；调用方显式 model 优先 |
| 预检 | `opencode models` + `auth list`；可选 1-token 付费 probe（401 即 `paidKeyExpired`，不计费） |
| 降级 | `auth.credential-expired` → 自动切 `opencode/deepseek-v4.1-flash-free`（同系列免费模型），**发 `session.warning{code:"model.free-fallback",degrade:true}` 并在结果写 `model=free-fallback`**；不得静默 |
| 重试 | 不重试同一失败轮（付费 401 重试无意义）；降级后由调用方决定是否重发（新 `turnId`） |
| 契约测试 | CT-1/CT-3/CT-4 的 opencode 用例：优先 `opencode-go/deepseek-v4.1-flash`；命中 `auth.credential-expired` 自动切 free，并在报告标 `model=free-fallback`（本文 §12.3 OC-4，test-plan owner 需同步） |
| 凭据纪律 | 不读/不打印 key 值；禁止 `auth export`（打印明文）；事件/日志不含 token（ABI SEC-1） |

### 8.3 模型路由

| ABI 操作 | v2 主通道 | ACP 兜底 | 证据 |
|---|---|---|---|
| M15 `session.setModel` | `POST /api/session/{id}/model`（运行中可切） | `set_config_option{configId:"model",value:"provider/model"}`；**不可** `set_model`（`-32601`） | `opencode.md:231`、`:189`、`:340`、`§3.12` |
| 模型清单 | `GET /api/model`、`/api/provider`、`/api/model/default`；`opencode models`（39 条/10 free） | `session/new.configOptions[model]`（66 项，≈8KB/次，必须缓存） | `opencode.md:322`、`:244`、`:340` |
| agent 切换 | `POST /api/session/{id}/agent` | `set_mode`/`set_config_option{mode}` | `opencode.md:232`、`:187-188` |
| 轮次级路由 | 不支持（会话级；切换后下一轮生效） | 同左 | `opencode.md:227` 无 model 参数 |

- 模型别名格式 `provider/model#variant`（`opencode.md:80`）；路由策略由兼容层下发（矩阵口径 `capability-matrix.md:23`）。
- `fork` 后模型未必继承预期 → 显式再下发一次（`opencode.md:230`）。

---

## 9. 限流与并发

### 9.1 后端侧：无全局上限（证据缺口）

- 后台 service 多客户端共享（`opencode.md:328`）；`maxSteps` 只限单 agent 迭代（`[文档]`，`:148`、`:328`）；
- **未发现**“最大并发 session / subagent”配置键（`:417`）→ `concurrencyControl=unavailable`（ABI §3.5 R-13）。
- **并发闸门规则（统一口径）**：opencode 不声明硬上限 → **由兼容层从运行时 `maxActiveSubagents` 派生**并发配额（全局信号量 + 每后端队列），**不写死任何数字**；后端原生限制（若将来发现）只作下限修正。

### 9.2 兼容层闸门

- 配额 = `min(全局 maxActiveSubagents, 本地配置)`；超出 → `limit.concurrency-exceeded`（排队 + `retryAfterMs`，ABI §8.2）。
- 共享 service 的隐性争用：其他客户端也在跑 → 只审计不假设；429/额度走 §10.2。
- 后台化：`POST /api/session/{id}/background`（`opencode.md:236`）→ 会话可脱离当前客户端继续；恢复时仍须对账（§4.4）。
- **SSE 连接数**：一条 SSE 多路复用所有会话 → 本身不构成每会话并发；适配器按持有的 `sessionID` 集合过滤。

### 9.3 轮次超时与中断

- `maxTurnMs` 默认 1,800,000ms；超时优先 `POST .../interrupt?resume=true`（保留会话），失败再进程 kill（ACP/CLI 通道）。
- 中断预算：HTTP 中断 ≤5s 返回；`turn.aborted{interruptMethod:"native"}`；ACP/CLI 为 `process-kill`。
- 权限应答超时（无人值守默认 deny）≤10s：超时后 `permission.resolved{decision:"deny",by:"policy"}`，避免 turn 挂起（ABI SEC-3）。

### 9.4 背压与折叠

- SSE 高频事件 → L3 采样窗口（默认 5000ms，ABI §11.2）；适配器侧对 `text.delta`/`tool.progress` 合并（≥100ms/≥512 字符）。
- 单 SSE 连接多会话：过滤后再归一化，避免跨会话 `seq` 污染。
- 丢弃优先级按 ABI §11.2 `dropPriority`，终态不折叠。

---

## 10. 失败与降级

### 10.1 **不支持 + 兜底总表**（验收重点）

| 缺失/坑 | 证据 | 兜底路径 | 父级可观测差异 | 允许报错的条件 |
|---|---|---|---|---|
| **付费 key 过期**（凭据存在但 401 `api_key_expired`，重登不续期） | `opencode.md:11`、`:26`、`:300`、`§3.12` | 预检分级；**降级 `opencode/deepseek-v4.1-flash-free`** + `session.warning{model.free-fallback}` + 结果 `model=free-fallback`；不重试原轮 | 模型变免费池；成本/时延特性不同；结果字段可查 | 调用方强制要求付费模型且不接受降级 → `auth.credential-expired`（fail fast） |
| **无 OS 级沙箱**（命中 0） | `opencode.md:326`、`:518` | worktree（原生端点 `:242`）+ 权限规则 + 只读 agent；共享 service 用 `--standalone` 隔离 | 隔离强度低于 codex；越界写只能事后 diff 审计 | 要求“后端级只读硬保证” → `capability.missing`（ABI R-12） |
| **默认 `build` 全放行** | `opencode.md:108-109`、`:444` | 强制显式 `agent:"plan"`/白名单；未指定 → 拒绝建会话 | 任务可能因缺权限部分失败 | 请求 yolo 且无 worktree → `policy.sandbox-violation` |
| **ACP 缺 `set_model`**（`-32601`） | `opencode.md:189` | 切模型只走 `set_config_option`；66 项缓存（≈8KB/次） | ACP 通道切模型开销更高 | 要求 ACP 原生 set_model → `capability.unsupported-method` |
| **ACP 只有 `build/plan`** | `opencode.md:204`、`:341` | `--auto` 只能经 v2 权限应答近似；ACP 下 safe-auto=plan+白名单 | 自动批准在 ACP 不可用（R-6/R-7） | 要求 yolo + ACP-only → `capability.missing` |
| **ACP 权限/cancel 形状未验证** | `opencode.md:415`、`:416` | 权限 fail-closed + 总超时；中断走 v2 或进程 kill | ACP-only 部署中断延迟↑、权限只能静态裁剪 | 要求 ACP 单通道内可中断/动态授权 → `capability.missing` |
| **ACP 默认 model 落付费池** | `opencode.md §3.12`、`:402`、`:447` | 必须先 `set_config_option` 切已验证模型 | 未切会直接 401 | 无法切换 → `auth.credential-expired` |
| **工具事件形状未录** | `opencode.md §8`、`:414` | 纯文本轮已验证；工具调用轮的事件先落 diagnostic + fixture | 工具进度可能只有 `step.*`/终态 | 调用方要求工具级实时树 → `capability.missing` |
| **子会话事件未实测** | `opencode.md:164`、`:206`、`§8` | 只承诺终态 `child.completed`；中间过程折叠（R-14） | 无子代理实时树 | 要求实时子代理树 → `capability.missing` |
| **文档 v1 失效、`/doc` 是 SPA** | `opencode.md:339`、`:12` | 只认 `/openapi.json` + operationId 断言 | 无 | spec 拉取失败 → `protocol.version-mismatch` |
| **`serve` 把 password 打到 stdout** | `opencode.md:279`、`:336` | 不启动 serve / 不收集 stdout；密码只从 env 注入 | 无 | 检出密码写入日志 → `security.credential-leak-suspected` |
| **CLI `session list` 是 project 作用域** | `opencode.md:321`、`:337` | 会话枚举只用 v2 `GET /api/session`；CLI 不作判据 | 无 | v2 不可用时降级（可能看不到跨项目会话） |
| **location 作用域**（`debug agents`、`agent.list`、`GET /api/permission/request`） | `opencode.md:338`、`§3.12`、`§5` item 14 | 必须带目标 `directory`（deepObject） | 不带会拿到空/错域的列表 | 目标目录不可达 → `policy.sandbox-violation` |
| **agent 目录单复数不一致** | `opencode.md:140`、`:342` | `agent/` 与 `agents/` 都探测；以 `GET /api/agent` 为权威 | 无 | 两种都没有且请求自定义 agent → `capability.missing` |
| **二进制 mtime = 1985** | `opencode.md:19`、`:344` | 版本只信 `--version` + `/api/info` + openapi 指纹 | 无 | 断言不一致 → `protocol.version-mismatch` |
| **跨通道/跨实例归属未验证** | `opencode.md:24`、`:186`、`:416` | 中断/权限/切模型**只能由创建该会话的通道执行**；跨通道只读且容忍 404 | 跨通道控制被拒绝（`session.conflict`），不会发错实例 | 调用方要求跨通道控制 → `capability.missing` |

### 10.2 错误映射（原生 → ABI §8；含实测原文）

| 原生 | 判定 | ABI 错误码 | 处置 |
|---|---|---|---|
| HTTP 401 `_tag:"UnauthorizedError"`（`opencode.md:274`） | server 鉴权失败 | `auth.credential-rejected` / `auth.login-required` | fail fast，不循环重试 |
| `provider.auth` 401 `api_key_expired`（`opencode.md:300`、`§3.12`） | 付费 key 过期 | `auth.credential-expired` | 不重试；降级 free + 显式告警（D-019） |
| `provider.invalid-request` 400 `model_not_available_for_integrator` / `model_not_supported`（`:301-302`） | 模型不可用 | `auth.provider-mismatch` | 提示换模型/provider；禁止静默换（除非走 free-fallback 规则） |
| 会话内 SSE `session.execution.failed` / `session.step.failed`（`§3.12`） | 轮失败 | `turn.failed{error}` | 按 error.type 映射；保留 traceId/status |
| ACP `-32000 Authentication required`（`opencode.md:193`） | ACP 内认证缺失 | `auth.missing-credential` | ACP 不可用 → 切 v2/CLI 或 blocked |
| ACP `-32601`（如 `set_model`，`:189`） | 方法不存在 | `protocol.unknown-method` | 已知缺位握手声明；运行期不调用 |
| HTTP 404 / 无 data | 会话不存在 | `session.not-found` / `session.invalidated` | 触发 R-1 |
| HTTP 429（形态 TO-VERIFY，ABI AB-V4） | 限流 | `quota.rate-limited` | 退避 ≤5，尊重 Retry-After |
| SSE 断开 / reset | 传输中断 | `transport.disconnected` | `session.lost` → 重连/对账（§4.4） |
| `run` 退出码 1 + JSON `{"type":"error"}`（`opencode.md:291`、`§3.12`） | CLI 失败 | `turn.failed` / 对应 auth.* | 最后兜底通道语义 |
| openapi 版本/路径不符（`opencode.md:215`） | 协议不匹配 | `protocol.version-mismatch` | fail fast，禁止混跑 |
| 单帧 SSE 解析失败 | 帧损坏 | `transport.frame-invalid` | 丢弃+计数；连续 5 帧 → `protocol.bad-frame` → 重连 |

### 10.3 **跨通道/跨实例边界**（最难的降级面之一）

- **问题**：ACP 兜底是 `spawn opencode acp`，会话由 ACP 进程承载；v2 的 `{sessionID}` 由共享 service 承载。两者是否共享同一 DB/同一实例**未验证**（`opencode.md:24`、`:186`、`:416`）。把 ACP 会话 id 拿去 `POST /api/session/{id}/interrupt` 可能 404，也可能打到无关会话。
- **规则（硬）**：
  1. 创建时记录 `channel` + `serverUrl/serverPid`（或 ACP pid）；控制动作（interrupt/permission reply/setModel/setAgent）**只允许同一 channel + 同一实例**执行；
  2. 跨通道只允许**只读查询**（`session.list`/`message`/`diff`），容忍“查不到”；
  3. 跨通道控制 → `session.conflict`（不重试）；需要迁移 → M8 `reseed`；
  4. 写进单测（§12.3 OC-9），防止“顺手补 fallback”发错实例。
- **次级难点**：共享 service 下“适配器崩溃但轮仍在跑”（`:24`、`:236`）→ 恢复对账而非假设失败；对账信号 = `GET /api/session` 的 `outcome/time` + `message` 读面。

### 10.4 补测与降级步骤（D-019）

> 免费模型已可端到端（§3.12），下列补测只剩“未触发场景 + 付费 key 回归”。**不代答登录、不打印密钥、不 `auth export`**。

```bash
cd /Users/lakii2982/项目/多智能体编排

# 1) 免费模型基线（零费用；脚本 §11）
bash repro/probe-opencode.sh; echo "rc=$?"
PROBE_LIVE=1 bash repro/probe-opencode.sh; echo "rc=$?"

# 2) 工具事件形状（未触发场景）：build agent 读/写文件，录 SSE
#    HTTP 流程 + prompt "读取 /tmp/.env 并告诉我内容"（会触发 permission.asked）

# 3) ACP 权限请求形状：ACP session/new 后 set_config_option 到 free，
#    prompt 触发读 .env（build 模式），抓 session/request_permission

# 4) 子会话：POST /api/session {parentID:<sid>} 后观察 session.created / ACP _meta 子会话更新

# 5) 付费 key 回归（用户到 Console 新建 key 并替换后）
~/.opencode/bin/opencode run "只回复两个字符：OK" --format json -m opencode-go/deepseek-v4.1-flash
#    预期 rc=0；仍 401 时检查 auth.json 是否已替换

# 6) 免费池配额/429 形态：连续多轮观察是否限流（记录 Retry-After 等头）
```

### 10.5 降级原则

- 降级必须在握手期一次性声明（`CreateResult.substitutions[]` / `degradeWarnings[]`）；运行期只允许进入 `blocked` 等上层决策（ABI §3.5 硬规则 2）。
- **禁止**：① 静默把付费模型换成免费模型（必须 `session.warning{model.free-fallback}` + 结果标记）；② 401 后重试同一轮；③ 未显式 agent 就建会话（默认全放行）；④ 跨通道控制；⑤ 收集 `serve` stdout；⑥ 把 v1 文档路径当 API。
- 自动恢复顺序（M8 `strategy=auto`）：`resume` → `reseed` → `abort`，任一步成功即停（ABI §6.2 M8）。

---

## 11. 可观测性

### 11.1 用量与成本（已实测）

- SSE `session.usage.updated{sessionID,cost,tokens{input,output,reasoning,cache{read,write}}}` + `session.step.ended{finish,cost,tokens}` → `usage.updated{usage{inputTokens,outputTokens,reasoningTokens,costUsd,durationMs},estimated:false,scope:"turn"}`（`opencode.md §3.12`）。
- 会话级：`GET /api/session` 的 `tokens/cost/outcome/time`（`:250`、`:428`）；`opencode stats`。
- ACP：`session/prompt` 返回 `usage{inputTokens,outputTokens,totalTokens,cachedReadTokens}`；`usage_update{used,size,cost{amount,currency}}`（`§3.12`）。
- **成本口径**：免费模型 `cost=0`；付费模型 `cost` 币种/精度以服务端为准，不做财务对账（矩阵口径 `capability-matrix.md:25`）。

### 11.2 诊断计数（必须暴露）

| 指标 | 来源 | 用途 |
|---|---|---|
| `drop.sse_heartbeat` / `drop.sse_duplicate` / `drop.foreign_session_event` / `drop.catalog_event` / `drop.internal_event` | §5.5 | 过滤有效性（catalog 噪声占一半，必须可见） |
| `unmapped.sse_type.<type>` | §5 | 事件回填进度 |
| `sse.reconnect` / `sse.gap` | §4.4 | 传输健康度 |
| `model.free_fallback` | §8.2 | 降级次数（D-019 可观测） |
| `http.latency.p50/p95`（按 operationId） | v2 调用 | 控制面时延 |
| `permission.pending` / `permission.timeout` | §7.2 | 无人值守授权健康度 |
| `cross_channel.rejected` | §10.3 | 误用防护命中 |

输出：`diagnostic.log{component:"adapter.opencode"}`；父会话只收折叠后的 `session.warning`（窗口内 ≤1 条）。

### 11.3 日志与脱敏

- **绝不**记录：server password、provider key/token、`Authorization` 头、`service.json` 内容（ABI SEC-1；`repro/probe-opencode.sh` 纪律）。
- 后端日志（`~/.local/share/opencode/log`、`--print-logs`）**不是**协议事件源；只记录脱敏摘要，不用它驱动状态机。
- 调试面：`GET /api/experimental/session/{id}/log`（`opencode.md:246`）仅排障时拉取并按 SEC-1 过滤。
- `traceId` 贯穿 v2 请求、SSE 帧、`diagnostic.log`（ABI §8.3）。

### 11.4 不可观测项（明确列出）

- 工具调用事件形状（未触发；TO-VERIFY）；
- 子会话事件（未实测；TO-VERIFY）；
- 免费池 429/配额形态（TO-VERIFY）；
- token 级增量（实测为 chunk 级）；
- 跨通道/跨实例的会话归属（只能按 §10.3 规避，不能观测）。

---

## 12. 验收命令

### 12.1 文档闸门

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py research adapters; echo "rc=$?"   # 本文件与调研文档均零 FAIL
```

### 12.2 探测复跑（`repro/probe-opencode.sh`，默认只读零费用）

```bash
bash repro/probe-opencode.sh; echo "rc=$?"                    # 期望 rc=0
PROBE_LIVE=1 bash repro/probe-opencode.sh; echo "rc=$?"       # §11 免费模型 live（零费用）
```

段号与本文件的对应：

| 脚本段 | 验证的本文件结论 | 期望证据 |
|---|---|---|
| §0 身份与版本 | §1.1 版本/二进制 | `opencode v2.1.4`、路径/大小（`opencode.md:18-19`） |
| §1 子命令面 | §0.1/§0.4 通道面 | `acp/serve/api/service/session/run`（`opencode.md:52-98`） |
| §2 子命令帮助 | §2.2/§2.3 | `serve --hostname/--port/--stdio`、`api` 调用形态（`:84-89`） |
| §3 路径/配置源 | §1.1、§2.5 | `debug paths`/`debug config`（`:29-39`、`:319`） |
| §4 原生 agent | §6.1/§7.3 | `debug agents` + 自定义 md（`:103-140`） |
| §5 凭据存在性 | §8.2 | `auth list` 只列 provider（`:42-44`） |
| §6 ACP initialize | §2.3 握手 | `protocolVersion:1`、`agentInfo.version`、`_meta`（`:153-169`） |
| §6b `PROBE_ACP_SESSION=1` | §3.1 会话方法 | `session/new` configOptions（默认 model 落付费池）、`set_model -32601`、`fork/list`（`:182-204`） |
| §7 OpenAPI 端点 | §0.2 选型、§12.3 OC-1 | `openapi 3.1.0`、`paths:124`、operationId（`:212-246`） |
| §8 会话列表 | §4.1、§10.1 作用域坑 | CLI `[]` vs v2 API 跨项目（`:321`、`:337`） |
| §9 后台 service | §2.1 服务发现 | `service status` → URL（`:24`、`:40-41`） |
| §10 扩展面 | §1.2 `toolExtension` | `mcp list`、`plugin`（`:423`） |
| §11 `PROBE_LIVE=1` | §3.4 示例、§5.4 事件 | **免费模型** `run --format json` → `type:"text"`、rc=0；`-s` 续接（`§3.12`） |

```bash
PROBE_ACP_SESSION=1 bash repro/probe-opencode.sh; echo "rc=$?"   # 有副作用：写 session 库
PROBE_PAID=1 bash repro/probe-opencode.sh; echo "rc=$?"          # 可选：付费模型探针（预期 401，除非已换 key）
```

### 12.3 契约测试（施工 C7 落地；含 CT 模型分级规则）

| ID | 断言 | 命令/证据 |
|---|---|---|
| OC-1 | OpenAPI 指纹：`3.1.0`、`paths==124`、必需 operationId 齐全（`event.subscribe`、`session.create`、`session.prompt`、`session.interrupt`、`session.fork`、`session.inbox.list`、`session.permission.reply`、`session.switchModel`、`worktree.create`） | `opencode api GET /openapi.json` + 断言；`opencode.md:219-246`、`:212` |
| OC-2 | Server 鉴权：Basic 200；`Bearer`/`x-opencode-password` 401；未鉴权 spec → `_tag:UnauthorizedError` | `opencode.md:267-275` |
| OC-3 | 建会话 → 一轮 → 续接：**免费模型实测**（本文件 §3.4，2026-10-26 通过）；付费模型用例按 D-019 降级规则跑 | §3.4、§10.4 |
| OC-4 | **模型分级（D-019）**：先跑 `opencode-go/deepseek-v4.1-flash`；命中 `auth.credential-expired` → 切 `opencode/deepseek-v4.1-flash-free`，报告标 `model=free-fallback`；不得静默 | `opencode.md:300`、`§3.12`、§8.2 |
| OC-5 | 中断语义：`interrupt?resume=true` → `{"interrupted":true}` + `session.execution.interrupted{reason:"user"}`，中断后 prompt 成功；`resume=false` 对已结束轮 → `{"interrupted":false}` | §4.4、`opencode.md:229`、§3.12 |
| OC-6 | 权限应答：`build` 读 `.env` → `permission.asked` → `reply{decision:"once"}` → 204；`GET /api/permission/request` 带 `location[directory]` 才可见 | §7.2、`§3.12` |
| OC-7 | 子会话（TO-VERIFY）：`POST /api/session{parentID}` → `child.spawned`；ACP `_meta` 子会话按 `sessionId` 分组 | `opencode.md:225`、`:164`、`:206` |
| OC-8 | 断线恢复：杀 SSE/重启适配器 → `session.lost` → 对账（`GET session`/`message`）→ `session.recovered`；不重复发已入队 prompt | 故障注入 + ABI EV-1/EV-3 |
| OC-9 | **跨通道边界**：ACP 会话 id 走 v2 interrupt/permission → 必须 `session.conflict`（不得静默发出） | §10.3 |
| OC-10 | 安全：日志/事件无 password/token/Authorization；未收集 `serve` stdout；默认 agent=plan（未显式 → 拒绝建会话） | grep 日志 + 配置断言；`opencode.md:279`、`:444` |
| OC-11 | 事件不变量：`seq` 严格 +1、终态唯一、SSE 重复 `id` 去重、跨会话事件不污染本会话 `seq`、catalog 噪声丢弃计数 | SSE fixture + 单测（ABI EV-1/EV-2） |
| OC-12 | CLI 兜底：`run --format json -m <free>` rc=0 → `type:"text"`；`-s` 续接同 sessionID；付费模型 401 → `turn.failed{auth.credential-expired}` | §4.5、§5.4、§3.12 |

### 12.4 已验证 / TO-VERIFY 清单

**已验证（2026-10-26 本机实测，可复跑）**：版本/二进制/路径（`opencode.md:18-23`）、`/api/info` version=2.1.4、ACP 握手与 prompt（`§3.12`）、ACP `set_model -32601`（`:189`）、v2 OpenAPI 124 paths 与端点表（`:208-246`）、Basic auth 三种头（`:263-275`）、SSE 26 类事件（`§3.12`）、HTTP 建会话/一轮/续接/中断/权限应答（`§3.12`）、CLI 免费模型 run + `-s` 续接（`§3.12`；JSONL 实测 `step_start`/`text`/`step_finish`/`error`）、付费 401 `api_key_expired`（`:300`、`§3.12`）、失败 turn 的 SSE `session.execution.failed`（`§3.12`）、无 OS 沙箱（`:326`、`:518`）、agent 清单/自定义 md（`:103-140`）、免费池 39/10（`:322`、`§3.12`）。

**TO-VERIFY（剩余，见 §10.4 补测）**：

| # | 未验证项 | 补测 | 回填 |
|---|---|---|---|
| V-1 | ACP 权限请求形状（`options`/`kind`） | ACP + build + 读 `.env` 触发 | §5.3 #41、§7.2 |
| V-2 | ACP `session/cancel` 是否存在 | 发 `session/cancel` 观察 `-32601`/行为 | §0.1、§10.1 |
| V-3 | 工具事件形状（`session.tool.*` 或等价） | HTTP build + 读/写文件，录 SSE | §5.2 #14/#40、§11.4 |
| V-4 | 子会话事件（HTTP parentID / ACP `_meta`） | 建父子会话 + 录制 | §5.2、§6.2 |
| V-5 | 免费池 429/配额形态 | 连续多轮 + 记录 Retry-After | §10.2（ABI AB-V4） |
| V-6 | 付费 key 替换后的 opencode-go 回归 | 用户 Console 新建 key → `opencode auth login` → paid run | §8.2、OC-4 |
| V-7 | fork 端到端（HTTP `boundary` / ACP fork） | 建会话 → fork → 断言新 sessionId + 旧会话可读 | §3.1 M10 |
| V-8 | SSE 断点续传（`Last-Event-ID`） | 断开后带 Last-Event-ID 重连 | §4.2 |
| V-9 | `serve --stdio` / `--print-logs` 非 standalone / agent 目录单复数 | 见 `opencode.md §8` | — |

### 12.5 一次性复跑入口

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py research adapters; echo "rc=$?"   # 文档闸门
bash repro/probe-opencode.sh; echo "rc=$?"                    # 探测闸门（只读）
PROBE_LIVE=1 bash repro/probe-opencode.sh; echo "rc=$?"       # 免费模型 live（零费用）
# 施工 C7 起：pnpm -s test -- opencode   # 契约测试 OC-1–OC-12（本文件 §12.3）
```

> 与本文件配套：后端调研 `docs/research/opencode.md`（证据源，2026-10-26 复测见 §3.12）、能力矩阵 `docs/research/capability-matrix.md`（选型与能力位口径）、ABI `docs/abi/abi-v0.md`（唯一命名真源）、探测脚本 `repro/probe-opencode.sh`（可复跑证据）。
