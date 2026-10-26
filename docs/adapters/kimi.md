# kimi-code 适配器规格（D5b / kimi）

> **后端**：kimi-code CLI `2.3.1`（`.astra/BRIEF.md:52` 版本基线）。
> **ABI 目标**：`abiVersion = "0.1"`（`docs/abi/abi-v0.md`）。本文件**不定义**任何 ABI 类型；事件名/错误码/能力位/方法名一律引用 `docs/abi/abi-v0.md`（§3 能力位、§6 方法、§7 事件、§8 错误码），本文只给**原生字段 → ABI 字段的映射**与**后端特化行为**。
> **证据纪律**：每条结论附 `docs/research/kimi.md:<行号>` 或 `repro/probe-kimi.sh §段号`；无证据的写 `TO-VERIFY` 并给补测命令，不臆测。`[推断]` 明确标注。
> **写域**：仅本文件（与 `docs/adapters/opencode.md`）。DSH 接入属 `docs/integration/*`，不在此展开。

---

## 0. 决策摘要与传输通道选型

### 0.1 两条原生面的对照（必须先分清）

kimi 有两个可编程面，事件粒度差一个数量级，适配器必须**分开建模**（→ `docs/research/kimi.md:8`）：

| 维度 | A（主通道）ACP over stdio | B（兜底通道）`-p --output-format stream-json` |
|---|---|---|
| 协议 | newline-delimited JSON-RPC 2.0，无 Content-Length 头（→ `kimi.md:226`） | 子进程 stdout JSONL，`role ∈ {meta,assistant,tool}`（→ `kimi.md:309-332`） |
| 握手 | `initialize`，`protocolVersion=1`（→ `kimi.md:197`、`kimi.md:202`、`kimi.md:222`） | 无握手；`kimi --version` 断言（→ `kimi.md:18`） |
| 会话原语 | `session/new\|load\|fork\|list\|prompt\|set_mode\|set_config_option\|set_model` + 反向 `session/request_permission`（→ `kimi.md:230-242`、`kimi.md:272-290`） | `-S/--session`、`-r`、`-c/--continue`、`kimi fork`、`kimi export`、`kimi session list`（→ `kimi.md:336-348`） |
| 事件粒度 | **token 级**：`agent_message_chunk`/`agent_thought_chunk`，一句思考 161 条 fragment（→ `kimi.md:264-265`、`kimi.md:364`） | **消息级**：一条 assistant 消息一个事件，无 token delta（→ `kimi.md:332`） |
| 多轮 | 同 session 连续多次 `session/prompt`，均 `stopReason:end_turn`（→ `kimi.md:244-252`、`kimi.md:239`） | 每次进程一轮；续接靠 `-S/-r/-c` 新进程（→ `kimi.md:337-341`） |
| 中断 | **无**：`session/cancel` → `-32601`（→ `kimi.md:240`、`kimi.md:368`） | **无**：`--help` 无中断入口；只能 SIGTERM（→ `kimi.md:368`） |
| 权限应答 | 反向请求 `session/request_permission`，3 个 option kind（→ `kimi.md:276-290`） | 无反向通道；档位由 `config.toml: default_permission_mode` 固定（→ `kimi.md:106-115`） |
| 客户端负担 | **必须**实现 `fs/read_text_file`，否则 `session/prompt` 永久静默挂死（→ `kimi.md:292-307`） | 无需反向 handler（→ `kimi.md:363` 直接可跑） |
| 认证 | 只有 terminal 设备码登录，运行期无法在 ACP 内认证（→ `kimi.md:211-217`、`kimi.md:223`） | 依赖已登录的 CLI 凭据（→ `kimi.md:24`） |

### 0.2 选型结论：**ACP 优先 + `-p --output-format stream-json` 兜底**

- **默认走 ACP**：唯一能拿到 token 级增量、权限应答通道（`permissionRequestBridge`）、会话级 `set_model`/`set_config_option`、同进程多轮的面（→ `kimi.md:9`、`kimi.md:230-242`）。这也是能力矩阵的定位（→ `docs/research/capability-matrix.md:37`）。
- **兜底切 CLI**，触发条件（任一成立，握手期一次性决定，运行期禁止临时切换，ABI §3.5 硬规则 2）：
  1. `kimi acp` 无法 spawn 或 `initialize` 超时/版本不符 → `transport.connect-failed` / `protocol.version-mismatch`；
  2. 适配器的反向往返 handler 无法保证注册成功（见 §2.3）——**宁可降级也不允许出现 `fs/read_text_file` 无 handler 的 ACP 进程**；
  3. 运维显式配置 `transport=cli`（例如需要单进程一次性执行、不接受长驻 stdio）。
- **兜底后的能力收缩**（写进 `degradeWarnings[]`，见 §1.2）：`tokenLevelStream → unavailable`（降为消息级，ABI §3.5 R-5）、`permissionRequestBridge/permissionAutoReply → unavailable`（只能静态档位，R-7/R-6）、`steerTurn/inputInbox → unavailable`、`permissionModes → emulated`（只能由配置文件决定，R-7）。
- **禁止**把 CLI 通道当成“等价通道”：它没有中断、没有权限应答、档位被配置锁死，只是“能让任务跑完”的降级路径。

### 0.3 不选另一条路（作为唯一通道）的原因

- **不以 CLI 为主通道**：无中断（→ `kimi.md:368`）、事件仅消息级（→ `kimi.md:332`）、`-p` 与三种模式旗标互斥导致 headless 无法按调用方要求改档位（→ `kimi.md:106-115`）、无反向权限通道 → ABI 的 `interruptTurn`/`permissionRequestBridge`/`tokenLevelStream` 三位全部落空，等于把可编排后端降成一次性批处理。
- **不以 ACP 为唯一通道**：ACP 要求实现完整客户端（反向 handler + 全程总超时）；`fs/read_text_file` 没实现就**永久静默挂死、kimi 侧不报错不超时**（→ `kimi.md:292-307`）——一旦适配器自身有缺陷或运行环境让该 handler 不可用，唯一结果就是任务无声卡死。CLI 兜底是这条病理的**可执行降级出口**。
- **不用 `kimi web` / `server(deprecated)` 面**：`acp` 无任何传输/端口参数，固定 stdio（→ `kimi.md:67`）；web/server 面在调研中未被当作可编排通道验证 → 不引入未验证面。

### 0.4 切换成本（ACP ⇄ CLI，同一 ABI 下）

| 成本项 | ACP → CLI（降级） | CLI → ACP（恢复） |
|---|---|---|
| 代码 | 复用 L1 绑定抽象（`open/request/notify/close`，ABI §4），需增加一个 `cli-stream-json` 绑定 + 事件映射表（§5） | 需实现 ACP 客户端四件套：行协议、反向 handler、总超时、会话缓存 |
| 事件能力 | 丢失 token 级增量与权限事件；`message.delta` 粒度降为 `message`（ABI §3.5 R-5） | 恢复 token 级；需重新校准折叠阈值（§9.4） |
| 中断 | 仍为一任务一进程 + SIGTERM（§10.1），无变化 | 无变化（kimi 两侧都无单轮中断） |
| 续接 | `-S/-r/-c` 新进程；`session.resume` 的 `backendSessionId` 仍是 `session_<uuid>`，语义一致 | `session/load`（→ `kimi.md:233`） |
| 风险 | headless 档位被 `config.toml` 锁死，安全档位可能反而更宽（§7.5） | 反向上帝缺失即静默挂死（§2.3） |

---

## 1. 身份与版本

### 1.1 身份与版本断言

| 项 | 值 | 证据 |
|---|---|---|
| `backendId` | `kimi` | `docs/abi/schema/session.json` 的 `backendRef.id` 枚举 |
| 二进制 | `~/.kimi-code/bin/kimi`（189,674,560 B） | `docs/research/kimi.md:19`；`repro/probe-kimi.sh §0` |
| 版本 | `2.3.1` | `kimi.md:18`、`kimi.md:29`；`probe-kimi.sh §0` |
| 会话存储 | `~/.kimi-code/sessions/wd_<workspace>_<hash>/session_<uuid>/` | `kimi.md:22`、`kimi.md:346` |
| 配置 | `~/.kimi-code/config.toml`（键名见 §7.5/§8） | `kimi.md:20`、`kimi.md:161-193` |
| 日志 | `~/.kimi-code/logs/kimi-code.log` + 每会话 `logs/` | `kimi.md:23` |

握手期必须断言（失败 → `protocol.version-mismatch`，ABI §2.3）：

1. `initialize.result.protocolVersion == 1`（实测只支持 1 → `kimi.md:222`）；
2. `initialize.result.agentInfo.version == "2.3.1"`（→ `kimi.md:217`）；
3. 二进制版本 `kimi --version == 2.3.1`（→ `kimi.md:18`）；
4. 二进制路径 + `sha256(binary)[:16]` 写入后端注册表（因为 `kimi upgrade` **只升 latest、无版本参数**，无法用安装器钉版本 → `kimi.md:377`）。

### 1.2 CapabilityDeclaration（A 组 15 位 + B 组相关位）

`state` 语义按 ABI §3.3；**只有握手实测结论才能填 `native`**（ABI §10 SEC-5）。本表“证据”列为实测依据。

| 能力位 | state | detail（原生面/约束） | 证据 |
|---|---|---|---|
| `headless` | native | `-p` 非交互；rc=0/参数冲突 rc=1 | `kimi.md:363` |
| `streaming` | native（ACP）/ emulated（CLI） | ACP token 级；CLI 消息级 | `kimi.md:364`、`kimi.md:332` |
| `resumeSession` | native | `session/load`；CLI `-S/-r/-c` | `kimi.md:233`、`kimi.md:337-341` |
| `forkSession` | native | ACP `session/fork`；CLI `kimi fork` | `kimi.md:235`、`kimi.md:342-343` |
| `listSessions` | native | `session/list{cwd}` 只返回该 cwd；CLI `--all` 跨工作区 | `kimi.md:234`、`kimi.md:389` |
| `interruptTurn` | **unavailable** | `session/cancel` → `-32601`；只能杀进程 | `kimi.md:240`、`kimi.md:368` |
| `nativeSubagents` | native（存在但不透传） | 5 个内置 profile + 盘上 `agents/agent-N`；ACP 未暴露 subagent 方法 | `kimi.md:124-127`、`kimi.md:149-157`、`kimi.md:369`、`kimi.md:453` |
| `toolExtension` | native | 插件 4 个、`--skills-dir`、`mcp.json`、`session/new{mcpServers}` | `kimi.md:352-357`、`kimi.md:370` |
| `permissionModes` | native | ACP 4 档 `default/plan/auto/yolo`；CLI 3 旗标 + 默认 | `kimi.md:97-102`、`kimi.md:371` |
| `sandboxModes` | **unavailable** | 二进制 `sandbox-exec/seatbelt/landlock/bubblewrap` 命中 0 | `kimi.md:372`、`kimi.md:447` |
| `modelRouting` | native | `set_model` / `set_config_option{configId:"model"}`；`-m` | `kimi.md:238`、`kimi.md:237`、`kimi.md:373` |
| `concurrencyControl` | **unavailable**（证据缺口） | 未发现 `maxConcurrent*` 配置键 | `kimi.md:374`、`kimi.md:452` |
| `usageReporting` | emulated（coarse） | 只有 `usage_update{used,size}`（上下文窗口占用），无 cost/token 计费 | `kimi.md:268`、`kimi.md:375` |
| `structuredProtocol` | native | ACP JSON-RPC 2.0 / newline / protocolVersion=1 | `kimi.md:376`、`kimi.md:226` |
| `versionPinning` | emulated | 只能固定二进制路径/副本（upgrade 只升 latest） | `kimi.md:377` |
| `multiTurn` | native | 同 session 连续多轮 | `kimi.md:244-252` |
| `steerTurn` | unavailable | 无运行中追加输入原语 | `kimi.md:230-242` 无对应方法 |
| `inputInbox` | unavailable | 同上 | 同上 |
| `tokenLevelStream` | native（ACP） | fragment 级 | `kimi.md:264-265` |
| `planUpdates` | unavailable | 无结构化计划事件（计划落盘 `agents/main/plans/*.md`，非协议面） | `kimi.md:383` |
| `diffUpdates` | unavailable | 无 diff 事件 | `kimi.md:254-270` 无对应 |
| `tokenUsage` | emulated | 见 `usageReporting`；轮末 `usage_update` | `kimi.md:268` |
| `permissionAutoReply` | native（ACP） | `request_permission` 3 option kind，程序化可选 | `kimi.md:276-290` |
| `permissionRequestBridge` | native（ACP） | 服务端→客户端反向请求 | `kimi.md:272-290` |
| `childSessionUpdates` | **unavailable** | ACP 未暴露子代理方法（二进制有字符串，实测不暴露） | `kimi.md:369`、`kimi.md:453` |
| `sessionArchive` | unavailable | CLI `session list --archived` 只是过滤器，没有归档/取消归档动作 | `kimi.md:367` |
| `sessionUnarchive` | unavailable | 无 | — |
| `sessionDelete` | native | 握手声明 `sessionCapabilities.delete` | `kimi.md:206` |
| `sessionExport` | emulated | 只有 CLI `kimi export`，不在 ACP 面 | `kimi.md:344` |
| `sessionReseed` | emulated | `session/new` + 适配器注入交接摘要（ABI `seedSummary`） | `kimi.md:232` |
| `worktreeIsolation` | unavailable | 无原生 worktree；只有 `--add-dir` 目录集合 | `kimi.md:53`、`kimi.md:372` |
| `backgroundRuns` | unavailable | 无 serve/daemon 面；进程即生命周期 | `kimi.md:60-67` |
| `processKillInterrupt` | native | 杀进程后会话落盘，新进程 `session/load` 可续；当轮丢失 | `kimi.md:204`、`kimi.md:233`、`kimi.md:385`；冷恢复往返 → §12.4 TO-VERIFY |
| `handshakeVersion` | native | `initialize` 回 `agentInfo.version` | `kimi.md:217` |

`warnings[]` 必须包含（父级可见）：

- `interruptTurn=unavailable` → 中断以 `process-kill` 上报，当轮内容可能丢失；
- `sandboxModes=unavailable` → 隔离由外层 worktree + 权限规则承担（已知残余风险，§7.4）；
- `childSessionUpdates=unavailable` → 子代理只有终态或不可见（ABI §3.5 R-14）；
- `usageReporting=emulated` → 用量不可用于计费对账。

### 1.3 版本钉不住时的处置

`versionPinning=emulated` 时按 ABI §2.3 记 warning 并**收窄能力位**：只启用已在 2.3.1 实测过的方法（§5 表），未知方法一律 `capability.unsupported-method`；禁止“先跑再看”。

---

## 2. 启动与握手

### 2.1 进程模型：**一任务一进程（硬约束）**

- kimi ACP 单进程**可承载多 session**（→ `kimi.md:374`、`kimi.md:252`），但无单轮中断 → 中断必须杀进程组，**同进程的其他会话会被连带终止**（→ `kimi.md:385`）。因此：**每个逻辑会话 = 一个 ACP 子进程 + 独立进程组**（`setsid`/`start_new_session=True`），`killpg(SIGTERM)` 只影响该任务。
- 进程 cwd = 已解析的绝对 worktree 路径（ABI M2 `cwd` 必填、相对路径拒绝）；`session/new` 的 `cwd` 与进程 cwd 保持一致（`kimi acp` 无 `--cwd`，工作目录继承进程 cwd，`session/new` 的 `cwd` 才是权威 → `kimi.md:67`）。
- 环境变量：`NO_COLOR=1`（`probe-kimi.sh` 全脚本口径）；**不注入**任何 key/token（凭据由 CLI 自身读取，适配器不碰 `~/.kimi-code/credentials|oauth|server.token` 内容 → `kimi.md:24`）。

### 2.2 握手序列（ACP 主通道）

```text
1) spawn  ["kimi","acp"]，cwd=<worktree>，new process group
2) 注册反向 handler（必须先于第一帧，§2.3）
3) → initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}, terminal:true},
                 clientInfo:{name:"mocl",version:"0.1"}}
   ← result {protocolVersion:1, agentCapabilities{loadSession,...}, authMethods[{id:"login",type:"terminal"}], agentInfo{version:"2.3.1"}}
   断言 §1.1 三条；否则 protocol.version-mismatch / protocol.invalid-params
4) → session/new {cwd:<abs>, mcpServers:<白名单>}
   ← {sessionId:"session_<uuid>", configOptions[model,thinking,mode], modes{currentModeId,availableModes}}
5) 读 config.toml: default_permission_mode / default_plan_mode（只读键名与值，§7.5），必要时显式 set_mode 覆盖
6) 产出 CapabilityDeclaration（§1.2），开始接 turn
```

- 握手超时：`initialize` 15s（`probe-kimi.sh §5` 用 20s 上限）；任何 request 默认 30s（ABI §4 要求传输层超时），`session/prompt` 例外用 `maxTurnMs`（§9.3）。
- 握手期失败**不允许**“先建会话再说”：`capability.missing` / `transport.connect-failed` / `protocol.version-mismatch` 一律 fail fast（ABI §2.2 第 4 步）。
- `mcpServers` 只注入白名单（BRIEF 安全默认）；用户全局 `~/.kimi-code/mcp.json` 的自动继承**不承诺**（→ `kimi.md:356`）。

### 2.3 反向请求处理器：**先注册、fail-closed、绝不挂起**

ACP 客户端若不实现 `fs/read_text_file`，`session/prompt` 会**永久静默挂住**（无错误、无超时，`kimi.md:292-307`）。因此：

| 反向方法 | 处理策略 | 证据 |
|---|---|---|
| `fs/read_text_file` | **必须首实现**：只读；`realpath` 必须落在允许根（worktree + `--add-dir` 集合）内；单文件 ≤1 MiB（ABI `maxFrameBytes` 默认）；越界 → 回 JSON-RPC error + `policy.sandbox-violation`，**不允许不回**。**回包契约（F3/D-003）**：成功 `result:{content}`；`FileNotFoundError` → `error:{code:-32602}`；其他异常 → `error:{code:-32603}`——任何分支都必须回包，否则 `session/prompt` 永久静默挂死 | `kimi.md:292-307`、`kimi.md:394`；示例见 §3.4 |
| `fs/write_text_file` | 默认 **deny**（error），仅 `permissionProfile=yolo` + worktree 隔离时按路径白名单放行 | `kimi.md:394`（已声明、实测未触发） |
| `terminal/*` | 注册 fail-closed handler（返回 error），实测未触发，但**不能没有 handler** | `kimi.md:394` |
| `session/request_permission` | 走策略自动应答：无人值守默认 `reject`（`optionId` 按 `kind` 匹配，不按字面 id） | `kimi.md:276-290`、`kimi.md:395` |

- **注册失败即拒绝启动 ACP**（切 CLI 兜底或 `capability.missing`）：这是本适配器最重要的一条启动守卫。
- 兜底网络：即使 handler 正常，`session/prompt` 仍受 §9.3 的硬超时 + 空闲看门狗保护（双保险）。

### 2.4 预检（启动前，零额度）

1. `kimi --version` / `kimi doctor`（配置是否合法，→ `kimi.md:30-34`）；
2. 二进制存在且可执行（`probe-kimi.sh §0` 的 `[ -x ]` 口径）；
3. `config.toml` 可读、关键键可解析（`default_model`/`default_permission_mode`/`default_plan_mode` → `kimi.md:164-166`）；
4. 凭据存在性（只 `ls` 目录，不读内容 → `kimi.md:24`）；
5. ACP spawn + initialize（§2.2）。任一步失败 → 明确错误码，不做“部分可用”。

---

## 3. 会话生命周期

### 3.1 ABI 方法 → kimi 原生调用

| ABI 方法（`docs/abi/abi-v0.md` §6） | ACP 主通道 | CLI 兜底通道 | 备注 |
|---|---|---|---|
| M2 `session.create` | spawn + `initialize` + `session/new` | `spawn kimi -p ... --output-format stream-json` | 幂等键 `(backendId, clientRequestId)`（ABI §9.1） |
| M3 `session.send` | `session/prompt{sessionId,prompt:[{type:"text",text}]}` | 新进程 `-S <id> -p ...` | 同会话最多一个进行中轮（ABI M3 turnLock） |
| M5 `session.interrupt` | **无原生** → `killpg(SIGTERM)`（§10.1） | 同左 | `interruptMethod:"process-kill"` 如实上报 |
| M6 `session.query` | 适配器内存态 + `session/list` 校准 | 同左 | `session/list` 只按 cwd 过滤（→ `kimi.md:234`） |
| M7 `session.list` | `session/list{cwd}` | `kimi session list --json` | Broker 注册表为权威（ABI §3.5 R-8） |
| M9 `session.close` | `session/close`（握手声明支持）→ 杀进程 | 进程自然退出 | 重复调用幂等；会话目录保留 |
| M10 `session.fork` | `session/fork{sessionId,cwd}` → 新 id | `kimi fork <id> -y` | fork 继承 model，路由不同需再 `set_config_option`（→ `kimi.md:235`） |
| M11 `session.archive` | 无动作，仅 Broker tombstone | 同左 | `sessionArchive=unavailable`（ABI R-10） |
| M12 `session.respond` | 应答 `session/request_permission` | 不可用（R-7） | 默认 `reject` |
| M14 `session.setMode` | `session/set_mode{modeId}` 或 `set_config_option{configId:"mode",value}` | **不可用**（`-p` 互斥，§7.5） | `currentModeId` 不可作权威，认 `current_mode_update`（→ `kimi.md:384`） |
| M15 `session.setModel` | `set_config_option{configId:"model",value}`（首选）/ `set_model{modelId}` | `-m` 新进程生效 | 见 §8.2 |

### 3.2 权限模式：**按语义映射，不按名字**

kimi 的权限命名**错位**（→ `kimi.md:88-104`）：CLI `-y/--yolo` = “Ask When Needed” ≈ ACP `auto`；CLI `--auto` = “Never Ask” ≈ ACP `yolo`。适配器只认 ABI 三档语义（read-only / safe-auto / yolo，ABI M2 `permissionProfile`）：

| ABI `permissionProfile` | ACP `modeId`（首选） | CLI 旗标（**不用于 headless**） | 原生语义证据 |
|---|---|---|---|
| `read-only` | `plan`（只读规划、无工具执行） | `--plan` | `kimi.md:99`、`kimi.md:398` |
| `safe-auto` | `auto`（自动批准安全操作） | CLI `-y/--yolo`（名字≠语义！） | `kimi.md:92`、`kimi.md:100` |
| `yolo` | `yolo`（自动批准一切） | CLI `--auto`（**Never Ask**） | `kimi.md:93`、`kimi.md:101` |
| （人工审批）`blocked` | `default` | 默认 | `kimi.md:98` |

- **映射后必须校验**：`set_mode` 之后等 `current_mode_update`，断言 `currentModeId` 等于期望；不等 → `session.warning{code:"permission.mode-drift", degrade:true}` 并按**更严**档执行（fail-closed）。
- `session/new` 返回的 `modes.currentModeId` **不可作为权威快照**（实测返回 `default` 却已在 plan 模式 → `kimi.md:384`）。
- `read-only` 的实现有两条路，适配器按配置二选一并在 `detail` 写明：
  - **严格档**：`plan`（无工具执行）——最安全，但连 Read 也不会跑（`kimi.md:99`）；
  - **可用档**：`default` + 预注册 `[[permission.rules]]` 白名单（本机已有 `allow Read/Grep/Glob` 规则，→ `kimi.md:179-182`），其余 `ask` 一律自动 deny。默认选**严格档**，可用档必须显式开启。

### 3.3 状态机映射（ABI `state` 枚举见 `session.json`）

| 阶段 | 触发 | ABI `state` | 事件 |
|---|---|---|---|
| 建会话 | `session/new` 成功 | `created` → `running`（有 firstInput 时） | `session.created` → `session.state-changed` |
| 轮进行中 | `session/prompt` 已发出未回 | `running` | `turn.started` |
| 轮结束 | `stopReason:end_turn` | `completed`（若 `expect=continue` 可再 `running`） | `turn.completed` |
| 等待人工（本适配器不产生） | `default` 模式下 ask | `awaiting-input` | `input.requested`（kimi 无独立输入方法，权限 ask 归 `permission.*`） |
| 被中断 | `killpg(SIGTERM)` | `aborted`（当轮）/ `lost`（连接） | `turn.aborted` → `session.lost` |
| 进程异常 | 非本端信号退出 | `lost` | `session.lost` → 冷恢复 |
| 恢复中 | `session/load` 进行 | `recovering` | `session.recovered`（成功后 `running`/`completed`） |
| 关闭 | M9 | `archived`（Broker 侧）或 `completed` | `session.closed`（§7.1） |

### 3.4 最小可运行示例（建会话 → 一轮 → 续接；含 fail-closed `fs/read_text_file`）

> **状态**：ACP 通道行为**本机已验证**（`initialize` + `session/new` + 同会话连续两轮 `session/prompt` 均 `end_turn` → `kimi.md:244-252`；会话级方法可用性 → `PROBE_ACP_SESSION=1 bash repro/probe-kimi.sh §5b`）。脚本本身是**规格示例**，施工 C6 落测时以本文件 §12.3 K1–K3 断言；跨进程 `session/load` 续接为 **TO-VERIFY**（补测见 §12.4）。
> **注意**：脚本会真实调用模型（消耗额度），默认纪律下只在 `PROBE_LIVE` / C6 回归时跑。

```python
# kimi_acp_min.py —— 建会话 → 一轮 → 同会话续接（kimi 2.3.1 已登录；会消耗额度）
import json, os, subprocess, threading, time
BIN = os.path.expanduser("~/.kimi-code/bin/kimi")
p = subprocess.Popen([BIN, "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     start_new_session=True)          # 独立进程组：中断=killpg
inbox = []                                            # 入站帧：响应 / session/update / 反向请求
threading.Thread(target=lambda: [inbox.append(json.loads(l)) for l in p.stdout if l.strip()],
                 daemon=True).start()

def send(o):
    p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

def reply_read_text_file(f):                          # F3/D-003：三态回包，绝不抛异常/挂起
    try:
        with open(f["params"]["path"], encoding="utf-8", errors="replace") as fh:
            send({"jsonrpc": "2.0", "id": f["id"], "result": {"content": fh.read()}})
    except FileNotFoundError:
        send({"jsonrpc": "2.0", "id": f["id"],
              "error": {"code": -32602, "message": "file not found"}})
    except Exception as e:                            # 其他 I/O/权限/编码错误
        send({"jsonrpc": "2.0", "id": f["id"],
              "error": {"code": -32603, "message": type(e).__name__}})

def wait(pred, timeout):                              # 顺带应答 fs/read_text_file：不实现则 prompt 永久挂住
    end = time.time() + timeout
    while time.time() < end:
        for f in list(inbox):
            if f.get("method") == "fs/read_text_file":
                inbox.remove(f)
                reply_read_text_file(f)               # 成功/缺失/异常都回包（fail-closed）
            elif pred(f):
                inbox.remove(f); return f
        time.sleep(0.05)
    raise TimeoutError("no frame; kill kimi pgid")    # 兜底：绝不无限等

def call(rid, method, params, timeout=180):
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    return wait(lambda f: f.get("id") == rid, timeout)

call(1, "initialize", {"protocolVersion": 1,
     "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True},
     "clientInfo": {"name": "mocl-min", "version": "0.1"}})
sid = call(2, "session/new", {"cwd": os.getcwd(), "mcpServers": []})["result"]["sessionId"]
for rid, text in ((3, "只回复 OK"), (4, "再回复一次 OK")):      # 第二轮 = 同会话续接（已验证）
    r = call(rid, "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
    print("turn", rid - 2, sid, r["result"]["stopReason"])
print("跨进程续接：新进程 initialize 后 session/load {sessionId,cwd} 再 prompt（TO-VERIFY）")
p.terminate()
```
```

**验收预期**：两行 `turn 1 session_... end_turn` / `turn 2 session_... end_turn`（`stopReason` 原样，映射到 ABI `end-turn` 见 §5），进程 rc=0、总耗时约 25s。**F3 强制项**：kimi 会请求其会话目录下**不存在的** `agents/main/plans/*.md`；即使该文件缺失，handler 也必须回 `-32602` 并让两轮正常走到 `end_turn`（评审实测：不加 catch 时 0.9s `FileNotFoundError` 崩溃；加 6 行 catch 后 24.6s 两轮 PASS）。**生产实现必须补**：`fs/write_text_file` 与 `terminal/*` 的 fail-closed handler、每轮硬超时、SIGTERM 进程组回收（示例为突出最小路径而省略）。

---

## 4. 续接与恢复（含幂等/去重、恢复判定）

### 4.1 持久化映射记录（Broker 侧，每会话一条）

```json
{
  "sessionId": "sess_01J9...",
  "backendId": "kimi",
  "backendSessionId": "session_706c84c0-...",
  "cwd": "/abs/worktree",
  "mode": "auto",
  "model": "kimi-code/k3.1-pro",
  "transport": "acp-stdio",
  "binaryPath": "/Users/.../.kimi-code/bin/kimi",
  "binarySha256_16": "…",
  "epoch": 3,
  "lastSeq": 128,
  "lastTurnId": "turn_01J9...",
  "pid": 4812,
  "pgid": 4812,
  "journalChecksum": "…"
}
```

规则：**Broker 注册表是权威**，`session/list`/`session list` 只作校准（ABI §3.5 R-8；`kimi.md:234`、`kimi.md:389`）。

### 4.2 续接判定算法（确定性、可单测）

```text
R0. 载入映射记录；校验 journal 校验和/结构
    ├─ 校验失败或字段歧义 → session.mapping-corrupt：拒绝服务该会话，隔离为 orphan，
    │   不自动重绑定（避免绑错会话）；人工处置 = M8 strategy=manual
    └─ 通过 → R1
R1. backendSessionId 是否已回填？
    ├─ 否且 create 只有 intent → 对账：session/list{cwd} 里按 title/updatedAt **无法可靠定位**
    │   → 判 session.not-found（不猜）；附带可用会话列表供上层重派
    ├─ 否且 create 有 ack（不应发生）→ session.mapping-corrupt
    └─ 是 → R2
R2. 探测后端存在性：spawn 新进程 → initialize → session/load{sessionId,cwd}
    ├─ 成功 → R3 resume
    ├─ 错误 -32602 / data.sessionId 回带（kimi 实测形状，→ kimi.md:242）
    │   → 后端已失效 → session.invalidated → 按 R-1 走 reseed 或 aborted
    ├─ -32603 / 其他 → session.resume-failed（重试 ≤3，退避 1s/2s/4s）
    │   → 仍失败 → 降级 reseed（sessionReseed=emulated）或 aborted，**不伪装成功**
    └─ 传输失败 → transport.connect-failed（换绑定 CLI 或 fail）
R3. resume 成功：epoch+1 → session.replay(fromSeq) 补齐 journal 事件 → session.recovered
    → 按需继续（可带 input 起一轮）
```

- **R-1 必测**（ABI §3.5）：`resumeSession` 为 unavailable 的后端（本适配器 CLI 兜底仍是 native，但后端软删/迁移可能失效）必须走 “reseed 或 aborted” 二选一，**两次调用返回同一结果**（幂等）。
- 恢复**不重放已终态轮次**：`turn.*` 终态恰好一条（ABI EV-4）；若 journal 有 `turn.started` 无终态 → 补发 `turn.failed{process.crashed}` 或 `turn.aborted`，由对账确定（ABI §7.9）。
- 冷恢复代价：新进程 = 重新握手；**当轮上下文丢失**（kimi 无单轮中断，→ `kimi.md:385`），历史由后端会话目录续上（→ `kimi.md:22`）。

### 4.3 幂等与去重（三条硬规则）

1. **写操作幂等键**：`clientRequestId` 作用域 `(sessionId, method)`；`session.create` 作用域 `(backendId, clientRequestId)`（ABI §9.1）。账本写 `intent`（载荷 SHA-256）→ 执行 → `committed`；同键不同载荷 → `session.conflict`（ABI §9.1 第 3 条）。
2. **`session/prompt` 绝不盲目重发**：ACP `session/prompt` **无内置超时**（→ `kimi.md:396`），超时后无法区分“未执行/执行中/已执行”。规则：
   - 超时 → **不重发**，直接按 §9.3 杀进程组 → `turn.aborted{interruptMethod:"timeout",partial:true}` → `session.lost` → 冷恢复后**新开一轮**（新 `turnId`），旧 `turnId` 永不补发；
   - 重放同 `clientRequestId`：有 `committed` 结果 → 返回同一 `turnId` + `deduplicated:true`；只有 `intent` → 先走 §4.2 探测/对账，禁止直接再发。
3. **事件去重**：适配器按 `seq` 严格 +1（ABI EV-1），`eventId` 全局唯一（EV-2）；重放事件保留原 `eventId`/`seq`/`ts`（ABI §7.9）。旧 `epoch` 事件丢弃并记 `abi.warning`（EV-3）。

### 4.4 恢复判定矩阵（故障 × 处置）

| 故障 | 判定依据 | 处置 | ABI 事件/错误码 |
|---|---|---|---|
| 进程崩溃（非本端 kill） | 退出信号 + 无 `turn` 终态 | `lost` → 冷恢复（§4.2） | `session.lost` → `session.recovered` 或 `session.resume-failed` |
| 本端中断（M5） | 本端 `killpg` 记录 | 当轮作废，不重放；会话可续 | `turn.aborted{process-kill,partial:true}` |
| 轮超时 | `maxTurnMs` 到期 | 杀进程组 + 恢复 | `limit.turn-timeout` → `turn.aborted{timeout}` |
| 后端 session 不存在 | `session/load` → `-32602` | R-1：reseed 或 aborted | `session.invalidated` |
| 映射损坏 | journal 校验失败/歧义 | orphan 隔离，人工介入 | `session.mapping-corrupt` |
| 本地无记录/tombstone 已 GC | 查注册表未命中 | 拒绝 | `session.not-found` |
| 连续坏帧 | ≥5 帧解析失败 | 重建连接 → `lost` → 恢复 | `transport.frame-invalid` → `protocol.bad-frame` |
| 额度/限流 | ACP error 含 rate 信息（形态未测） | 退避 ≤5，尊重 Retry-After | `quota.rate-limited`（TO-VERIFY，ABI AB-V4） |

### 4.5 首轮前 `remoteSessionId` 为空（D-020：pending backfill）

- **事实**：CLI 兜底通道（`-p --output-format stream-json`）在首轮 `session/prompt` 之前没有后端会话 id（只有 ACP `session/new` 会立即返回 `sessionId`）→ `session.create` 的 `remoteSessionId` 允许为空。
- **语义（D-020 裁定）**：**空 id = pending backfill，不是错误**。Broker 允许空 `remoteSessionId` 落库，会话对象标 `remoteIdState:"pending"`；首轮收到 `session.resume_hint` / `session.recovered`（或 CLI 输出里的会话 id）后**回填并持久化**，状态转 `remoteIdState:"bound"`。
- **判定与守卫**：
  - `pending` 时**禁止** `session.resume`（无 id 可探测）→ 只能 `session.send` 等首轮回填；回填前的冷恢复按 §4.2 走 reseed（R-1）或重开新会话。
  - `bound` 后才允许按 id 探测/续接；空 id 不得被当作"会话丢失"（`session.not-found`）处理。
  - `status`/`session.query` 的 `remoteIdState` 是唯一判据；`backendSessionId` 为空 + `remoteIdState:"bound"` 属映射损坏（§4.4）。
- ABI 字段定义：`docs/abi/abi-v0.md` §6.2 会话对象、`docs/abi/schema/session.json` 的 `remoteIdState`。

---

## 5. 流事件映射

### 5.1 原则

- **事件名唯一权威** = `docs/abi/abi-v0.md` §7；本文左列是 ACP 原生名，**禁止**把原生名透传给上层（ABI §0 规则 2）。
- 无法映射的原生事件：**丢弃 + 内部计数**（`abi.warning` 级诊断），不伪造 ABI 事件（ABI §7 前言、§13.2）。
- 一轮内顺序遵循 EV-4：`turn.started` → 过程事件 → 唯一终态；折叠比例受 §11.2 上限约束。

### 5.2 ACP `session/update` / 反向请求 / 进程信号 → ABI 事件（逐条，含丢弃项）

| # | 原生来源（ACP） | 原生关键字段 | ABI 事件 / 处置 | 映射说明与证据 |
|---|---|---|---|---|
| 1 | `initialize` result | `protocolVersion`、`agentInfo.version`、`agentCapabilities` | **无事件**（握手内部） | 断言 + 能力声明；证据 `kimi.md:197-219` |
| 2 | `session/new` result | `sessionId`、`configOptions`、`modes` | `session.created`（payload `state`、`cwd`、`label`） | `backendSessionId` 回填；configOptions 缓存；证据 `kimi.md:232` |
| 3 | `session/load` result | `configOptions` | `session.recovered` + `session.state-changed` | 续接成功，`strategy:"resume"`（payload 按 ABI §7.1）；证据 `kimi.md:233` |
| 4 | `session/fork` result | 新 `sessionId` | 新会话 `session.created`（M10 结果返回新 id） | `kimi.md:235` |
| 5 | `session/list` result | `{sessions:[{sessionId,cwd,title,updatedAt}]}` | **无事件**（读方法） | 只作校准，不改状态；`kimi.md:234` |
| 6 | `session/update` · `available_commands_update` | `availableCommands[]`（13 条 slash） | **丢弃 + 计数** | `unmapped.available_commands_update`；`diagnostic.log{level:debug}`；`kimi.md:260`、`kimi.md:357` |
| 7 | `session/update` · `session_info_update` | `{title}` | **丢弃 + 计数** | 可写会话 label（非事件）；`kimi.md:261` |
| 8 | `session/update` · `current_mode_update` | `{currentModeId}` | **无对应 ABI 事件**：更新内部权限快照；与请求档位不符 → `session.warning{code:"permission.mode-drift",degrade:true}` | 模式的**权威来源**（`currentModeId` 不信）；`kimi.md:262`、`kimi.md:384` |
| 9 | `session/update` · `config_option_update` | `{configOptions[]}` | **丢弃 + 计数** | 更新配置缓存；`kimi.md:263` |
| 10 | `session/update` · `agent_thought_chunk` | `content.text`（fragment） | `reasoning.delta{text,granularity:"token"}` | 一句思考 161 条 → 必须折叠；默认不进父会话（ABI §11.2 `includeReasoning:false`）；`kimi.md:264`、`kimi.md:386` |
| 11 | `session/update` · `agent_message_chunk` | `content.text`（fragment） | `message.delta{channel:"assistant",text,granularity:"token",messageId}` | `messageId` 由适配器按 `turnId` 生成（ACP 无 message id）；轮末补 `message.completed`（权威全文）；`kimi.md:265` |
| 12 | `session/update` · `tool_call` | `toolCallId`、`title`、`kind=pending` | `tool.started{toolCallId,name:title,kind}` | `kind` 实测 `read/other`（未穷举）；`kimi.md:266`、`kimi.md:270` |
| 13 | `session/update` · `tool_call_update`（`status:"in_progress"`） | `rawInput` 逐字符回显 | `tool.progress`（**节流 ≥200ms**，仅文本/百分比；`rawInput` 不进事件） | 逐字符回显必须丢弃（`{"path":"a` → `{"path":"a.txt"`）；`kimi.md:267`、`kimi.md:386` |
| 14 | `session/update` · `tool_call_update`（`status:"completed"`） | `rawOutput`、`content[]` | `tool.completed{toolCallId,status:"ok",outputDigest,artifact?}` | `outputDigest=sha256(rawOutput)[:16]`；`rawOutput` >8 KiB 只留 artifact + `truncated:true`；`kimi.md:267` |
| 15 | `session/update` · `tool_call_update`（`status:"failed"`，ACP 规范值；kimi 未观测） | `error` | `tool.failed{toolCallId,error}` | **未观测**：按规范兜底，录制后回填；`kimi.md:266-267` |
| 16 | `session/update` · `usage_update` | `{used,size}`（如 36996/1000000） | `usage.updated{usage:{estimated:true,scope:"turn",durationMs},estimated:true}` + 首见 `session.warning{code:"usage.coarse"}` | `used/size` 是上下文窗口占用，**不是**计费 token → 不伪造 `inputTokens`（ABI §8 `usageRef`）；`kimi.md:268`、`kimi.md:375` |
| 17 | 反向 `session/request_permission` | `toolCall{toolCallId,title,content}`、`options[{optionId,kind}]` | `permission.requested{requestId,tool,risk,options[]}` | `requestId`=JSON-RPC id；`risk` 按工具语义（Read→read、Write/Edit→write、Bash→execute）；`kind` 映射见 §7.2；`kimi.md:276-287` |
| 18 | 本端应答后（`{outcome:"selected",optionId}`） | 选择结果 | `permission.resolved{requestId,decision,by:"policy"}` | 无人值守默认 `deny`；拒绝被真实尊重（目标文件未创建）；`kimi.md:288`、`kimi.md:395` |
| 19 | `session/prompt` 响应 · `stopReason:"end_turn"` | `{stopReason}` | `turn.completed{stopReason:"end-turn",usage}` | 一轮恰好 1 条终态（EV-4）；`usage` 必填（schema `usageRef`）；`kimi.md:239`、`kimi.md:249-250` |
| 20 | `session/prompt` 响应 · 其他 `stopReason`（`max_tokens`/`refusal`/`cancelled`，kimi 未观测） | `{stopReason}` | `max_tokens`→`turn.completed{stopReason:"context-limit"}`；`refusal`→`turn.completed{stopReason:"other"}`；`cancelled`→`turn.aborted{interruptMethod:"native"}` | **未观测**，按语义兜底；录制后回填；`kimi.md:239` |
| 21 | `session/prompt` 错误 · `-32602 Unknown sessionId` | `error.data.sessionId` | `turn.failed{error:{code:"session.invalidated"},partial:false}` | 立即触发 §4.2 R-1；`kimi.md:242` |
| 22 | `session/prompt` 错误 · `-32603`/其他 | `error{code,message,data}` | `turn.failed{error:{code:"backend.internal-error"（后端内部，v0.1 MINOR）或 "protocol.invalid-params"}}` | 按上下文分类；`backend.internal-error` 必须带 `details.backendCode`；带 `traceId`（ABI §8.3） |
| 23 | `session/prompt` 无响应（> `maxTurnMs`） | 无帧 | `turn.aborted{interruptMethod:"timeout",partial:true}` + `session.lost` | 杀进程组；`limit.turn-timeout`；`kimi.md:396` |
| 24 | 进程退出（非本端 kill，轮未完成） | 退出信号 | `turn.failed{error:{code:"process.crashed"},partial:true}` + `session.lost` | 冷恢复（§4.2）；ABI §7.9 |
| 25 | 本端 `killpg(SIGTERM)`（M5 中断） | 本端记录 | `turn.aborted{interruptMethod:"process-kill",partial:true}` + `session.lost` | ABI §3.5 R-3；`kimi.md:368`、`kimi.md:385` |
| 26 | 反向 `fs/read_text_file`、`fs/write_text_file`、`terminal/*` | 请求参数 | **无 ABI 事件**（本地应答） | fail-closed；越界 → `policy.sandbox-violation` + error 应答 + `diagnostic.log`；`kimi.md:292-307`、`kimi.md:394` |
| 27 | stdout EOF / 单帧解析失败 | EOF / JSON 解析错 | EOF：`transport.state-changed`（closed）→ `session.lost`；单帧：`transport.frame-invalid` + 计数（连续 5 帧 → `protocol.bad-frame` 重建） | ABI §4 要求 3；`kimi.md:226` |

> 覆盖 ABI 事件：`session.created`、`session.state-changed`、`session.recovered`、`session.lost`、`turn.started`、`turn.completed`、`turn.failed`、`turn.aborted`、`message.started/completed`（由适配器补齐）、`message.delta`、`reasoning.delta`、`tool.started/progress/completed/failed`、`permission.requested/resolved`、`usage.updated`、`session.warning`、`diagnostic.log`、`transport.state-changed`。

### 5.3 丢弃项汇总（必须计数，不得静默）

| 原生项 | 丢弃原因 | 计数键 |
|---|---|---|
| `available_commands_update` | slash command 列表与编排无关 | `drop.available_commands_update` |
| `session_info_update` | 只有标题 | `drop.session_info_update` |
| `config_option_update` | 配置缓存变更 | `drop.config_option_update` |
| `tool_call_update.rawInput` 逐字符回显 | 高频且非语义（`kimi.md:386`） | `drop.tool_rawinput_fragment` |
| `agent_thought_chunk` 超出折叠窗口的部分 | 保护父会话（ABI §11.2 `includeReasoning:false`） | `fold.reasoning_dropped` |
| 重复/迟到的 JSON-RPC 响应 | `protocol.unexpected-response`（ABI §8） | `drop.unexpected_response` |

计数暴露方式：`diagnostic.log{level:"debug", component:"adapter.kimi"}` 周期汇总；**不逐条上报**父会话（BRIEF 硬约束 3）。

### 5.4 折叠与限流（token 洪水）

- 适配器对 `agent_message_chunk` / `agent_thought_chunk` **原样映射**（`granularity:token`），但**禁止**直接触发父会话写入；父会话增量由 L3 按 `progress.folded` 采样窗口（默认 5000ms，ABI §11.2）产出。
- 适配器侧二次节流：`tool.progress` ≥200ms 合并；`message.delta` 累计 ≥512 字符或 ≥100ms 才转发到 L3（本地缓冲，丢失由 `message.completed` 权威全文兜底）。
- 丢弃优先级按 ABI §11.2 `dropPriority`；终态事件不受折叠上限约束（ABI §11.1）。

---

## 6. 原生子代理与嵌套

### 6.1 证据与可用面

- 内置 5 个 agent profile：`plan`（只读规划）、`agent`（通用）、`coder`（默认）、`explore`（只读探索）、`tower-worker`（→ `kimi.md:124-127`）。
- `--agent-file` 加载 Markdown+YAML frontmatter 定义（→ `kimi.md:129-147`）；自定义发现目录 `~/.kimi-code/agents/`（本机未创建，→ `kimi.md:146`）。
- 原生多代理**落盘痕迹**：会话目录下 `agents/main` + `agents/agent-N`（观测到 `agent-19`，→ `kimi.md:149-157`）。
- 限制：`--agent` **不能**与 `--session/--continue` 组合（→ `kimi.md:51`）；ACP 面**没有** subagent 方法（二进制有 `session/subagent/*` 字符串但未暴露 → `kimi.md:453`）→ `childSessionUpdates=unavailable`。

### 6.2 适配器策略：透传能力位，不承诺子代理树

- `nativeSubagents=native`（能力存在），但 **`childSessionUpdates=unavailable`**：ACP 不推送子会话事件 → 按 ABI §3.5 R-14，只上报终态 `child.completed`，中间过程折叠进父摘要。
- **禁止**把磁盘 `agents/agent-N` 目录当作事件源（不是协议面，且随时可能变），只能用于排障计数（`diagnostic.log`）。
- 子代理 profile 的选择在 **CLI 通道**可用（`--agent`）；ACP 通道无 per-session agent 选择方法 → ACP 下 agent profile 由 `config.toml` 默认决定（`config.toml` 的 `--agent` 语义未在 ACP 暴露，标 TO-VERIFY，补测：ACP `session/new` 后观察首轮工具集是否受 profile 影响）。

### 6.3 嵌套编排：Broker 多实例模拟

- 默认 `maxNestingDepth = 1`；更深请求 → `limit.nesting-exceeded`（ABI §8）。
- 因为“一任务一进程”，父任务要派子任务时：由 Broker 起**新的** kimi ACP 进程（同一后端、独立 pgid），`parentSessionId` 指向父逻辑会话；父级通过 `child.completed` 拿终态，不共享进程。
- 子进程的 worktree 必须与父隔离（§7.4），避免并发写同一目录。

---

## 7. 权限与沙箱

### 7.1 三档语义映射（唯一依据 = 语义，不按名字）

见 §3.2 表。补充：

- **CLI 旗标命名陷阱**：`-y/--yolo` 是 “Ask When Needed”（≈ ACP `auto`），`--auto` 是 “Never Ask”（≈ ACP `yolo`）（→ `kimi.md:45-46`、`kimi.md:92-93`、`kimi.md:104`）。任何按名字透传的实现都会把 “safe-auto” 放大成 “yolo”。
- 适配器在握手期把 ABI 档位翻译为 ACP `modeId`，并通过 `current_mode_update` 校验；**运行期禁止**因上层请求临时切档（ABI §3.5 硬规则 2）→ 档位变更只能走 M14，且必须回发 `session.warning` 说明差异。

### 7.2 `session/request_permission` 应答（ACP → ABI）

原生 options（`kimi.md:282-286`）：

| 原生 `optionId` | 原生 `kind` | ABI `options[].kind`（`permission.requested`） | 本端决策（`permission.resolved.decision`） |
|---|---|---|---|
| `approve_once` | `allow_once` | `allow-once` | `allow-once`（仅 `safe-auto`/`yolo` 且风险≤write 时） |
| `approve_always` | `allow_always` | `allow-always` | `allow-always`（仅 `yolo`；`safe-auto` 不持久放行） |
| `reject` | `reject_once` | `deny-once` | `deny`（**默认**） |

- `kind` 只有 3 种（→ `kimi.md:290`），但 `optionId` 可能随版本变化 → **按 kind 匹配，不按 optionId 字面**；无匹配 → 回 `reject` 并 `policy.escalation-required`。
- 应答格式：`{"outcome":"selected","optionId":"reject"}`（→ `kimi.md:288`）；**必须真的回**，否则 turn 挂起（与 `fs/read_text_file` 同类病理；ABI §10 SEC-3）。
- 风险分级（`risk`）：工具 `title/kind` → `read`（Read/Grep/Glob）、`write`（Write/Edit）、`execute`（Bash/命令类）、`network`（webfetch 类）、`unknown`。`read-only` 档即使收到 write/execute 请求也一律 deny。

### 7.3 fs / terminal 反向请求策略

| 请求 | 策略 | ABI 错误 |
|---|---|---|
| `fs/read_text_file` | 允许，但 `realpath` ⊆ `{worktree, --add-dir 集合}`；单文件 ≤1 MiB；符号链接按 realpath 判定 | 越界/超限 → 回 error + `policy.sandbox-violation` |
| `fs/write_text_file` | 默认 deny；`yolo` + worktree 下按路径白名单放行 | `policy.permission-denied` |
| `terminal/*` | fail-closed error（实测未触发，但必须注册） | `policy.escalation-required` |

**路径穿越防线**：拒绝 `..` 逃逸、绝对路径越界、`/etc/passwd` 类敏感文件（只读白名单可含 cwd 内任意文件）；命中 → 拒绝 + `diagnostic.log{level:"warn"}`，**不得**把请求参数回显给父会话（可能含敏感路径）。

### 7.4 沙箱：**没有 OS 级沙箱**（已知残余风险，必须显式声明）

- 否证：二进制中 `sandbox-exec`/`seatbelt`/`landlock`/`bubblewrap` 命中数均为 0（→ `kimi.md:372`、`kimi.md:447`；复跑 `repro/probe-kimi.sh §2` 的 grep 口径）。
- 隔离只能靠三层，且**都不是 OS 级**：
  1. **worktree**（外层创建，适配器只接受绝对路径 cwd；`worktreeIsolation=unavailable` → 责任在调用方，ABI §3.5 R-16）；
  2. **权限规则**（`[[permission.rules]]` allow/ask/deny；`kimi.md:179-182`）+ ACP 模式（§3.2）；
  3. **适配器路径策略**（§7.3）。
- **残余风险（写进风险登记册）**：`yolo` 档下 kimi 可以读写 worktree 之外的文件、可执行任意 `Bash`，且无 OS 级强制；一旦任务误在非 worktree cwd 启动，隔离失效。因此：
  - 默认 `permissionProfile=read-only`（ABI SEC-4）；
  - `yolo` 必须显式 + 有 worktree，否则 `policy.sandbox-violation` 拒绝派发；
  - 事后审计：任务结束对比 worktree `git status`/diff，越界写记为 `security.*` 事件。

### 7.5 默认档位与 headless 限制（**配置锁死**）

- `-p` 与 `--auto`/`-y`/`--plan` **互斥**（rc=1，→ `kimi.md:106-115`）→ **CLI 兜底通道的权限档位只能由 `config.toml: default_permission_mode` 决定**，命令行改不了。
- 本机该键 = `"auto"`（→ `kimi.md:165`、`kimi.md:115`）；同时 `default_plan_mode = true`（→ `kimi.md:166`、`kimi.md:383`）。
- **[推断] 安全含义**：`config.toml` 是 CLI 配置，键值 `auto` 与 CLI 旗标 `--auto`（= **Never Ask**）同名；若成立，本机 headless 兜底实际是 “yolo 级” 而非 “safe-auto”。**处置（保守）**：
  - CLI 兜底时，若 `permissionProfile ∈ {read-only, safe-auto}` 且 `default_permission_mode` 未被用户改成与预期一致的显式值 → **拒绝使用 CLI 兜底**（fail-closed，提示改配置）；
  - 该推断标 **TO-VERIFY**（补测：把配置改成 `plan`/`default`/`yolo` 各跑一次 `-p`，观察是否需要审批/是否执行写操作，见 §12.4）。
- `default_plan_mode=true` 的副作用：prompt 会话从 plan 起步，且实测 `ExitPlanMode` 被 “auto-approved without user review”（→ `kimi.md:383`）→ 启动时必须**显式** `set_mode` 到目标档位，并忽略会话内自动 plan 退出（否则父级看到的是“隐形只读阶段 + 自动越权”）。
- **D-021 裁定（fail-closed）**：CLI 兜底通道**无法按调用方切档**（`-p` 与 `-y/--auto/--plan` 互斥，rc=1，→ `kimi.md:106-115`）。当调用方要求的 `permissionProfile` 与 `config.toml: default_permission_mode` 的语义不一致（或无法映射到该键）时，适配器**不得**"偷偷降档"、不得静默忽略请求 → 返回 `policy.escalation-required`（ABI §8.2；category=`policy`，retryable=`no`），提示人工改配置或改用 ACP 通道（ACP 可 `session/set_mode`，不受此限）。

---

## 8. 认证与模型路由

### 8.1 认证面

- ACP `authMethods` **只有 terminal 设备码登录**（→ `kimi.md:211-217`、`kimi.md:223`）；没有 API-key 型 auth method → **无人值守必须在启动前已登录**，运行期无法在 ACP 内完成认证。
- 凭据位置（只查存在性，不读内容）：`~/.kimi-code/credentials/`、`~/.kimi-code/oauth/`、`~/.kimi-code/server.token`（→ `kimi.md:24`）。
- 未登录时的失败形态：**TO-VERIFY**（`kimi.md:454` 明确未验证未登录机器）；适配器按保守映射处理：`prompt`/`session/new` 返回认证类错误 → `auth.login-required`（提示人工登录，禁止自动重试，ABI §8.2）。
- 凭据纪律：`diagnostic.log`/事件 payload 不出现 token、OAuth 内容（ABI §10 SEC-1）；`kimi export` 产物可能含敏感信息 → 默认不落盘。

### 8.2 模型路由

| ABI 操作 | 原生调用 | 证据/注意 |
|---|---|---|
| M15 `session.setModel` | 首选 `session/set_config_option{configId:"model", value:"<provider>/<model>"}`；备选 `session/set_model{modelId}` | 两者实测可用：`kimi.md:237`、`kimi.md:238`、`kimi.md:373`；`set_config_option` 是 ACP 标准面，跨后端更稳（对比 opencode 无 `set_model`） |
| 选择模型清单 | `config.toml` 的 `[models."<provider>/<model>"]` + `kimi provider catalog` | `kimi.md:172-175`、`kimi.md:188-189`、`kimi.md:373` |
| 推理档位 | `configId:"thinking"`（`[thinking].{enabled,effort}`） | `kimi.md:176`、`kimi.md:191`；`support_efforts` 取值来自模型定义（`kimi.md:172-175`）；**TO-VERIFY**：`set_config_option{configId:"thinking"}` 的 value 语义 |
| 轮次级路由 | 不支持（会话级） | `session/prompt` 无 model 参数；切换后再发下一轮 |

- 路由策略由兼容层下发、kimi 只执行（矩阵口径 → `capability-matrix.md:23`）；`fork` 继承 model（→ `kimi.md:235`），若新路由不同必须显式再 set。
- 模型不可用/鉴权失败 → `auth.provider-mismatch` / `auth.credential-expired`，fail fast，禁止换模型静默重试（ABI §8.2）。

---

## 9. 限流与并发

### 9.1 后端侧：未发现硬上限（证据缺口）

- 单进程可并发多 session（→ `kimi.md:374`），但**未发现** `maxConcurrent*` 类配置键；`[experimental] tower`、`AgentSwarm` 是否有硬上限未知（→ `kimi.md:452`）→ `concurrencyControl=unavailable`，按 ABI §3.5 R-13 由 Broker 本地闸门兜底（可能超卖后端额度）。

### 9.2 兼容层闸门（权威）

- 全局信号量默认 4（矩阵对策列 → `capability-matrix.md:24`）；kimi 后端 `maxSessionsPerBackend` 建议默认 **2**（一任务一进程 + 无单轮中断，进程数即风险面；内存/CPU 实测数据未采集，标 TO-VERIFY）。
- 超出上限 → `limit.concurrency-exceeded`（可排队：`queued` + `retryAfterMs`，ABI §8.2）。
- **强制不变量**：同一 kimi ACP 进程只承载 1 个逻辑会话（§2.1）；违反 → 中断会连带杀死其他任务（→ `kimi.md:385`）。
- 进程回收：M9/中断后 `killpg(SIGTERM)`，5s 未退 → `killpg(SIGKILL)`；僵尸 pid 巡检（Broker 启动时清理本实例遗留 pgid）。

### 9.3 轮次超时与看门狗（**必需**，因为 kimi 无内置超时）

- 每轮硬超时 `maxTurnMs`（ABI M2 默认 1,800,000ms；建议 ≥180s，因为 `thinking.effort=max` 单轮可达分钟级 → `kimi.md:396`）。
- 空闲看门狗：连续 `idleTimeoutMs`（默认 120s）无任何帧且轮未结束 → 判 `process.hung`（ABI §8）：先 `session/ping` 不适用（无 ping 方法）→ 直接杀进程组 + 冷恢复。
- `fs/read_text_file` handler 与超时的关系：handler 是**同步本地读**，不会阻塞；但若实现里做了网络/慢盘 I/O，必须 ≤2s 完成（ABI §14 ABI-T8 挂起测试 ≤2s 口径）。
- 中断延迟预算：M5 发出 → `turn.aborted` ≤5s（SIGTERM）+ ≤2s（SIGKILL 兜底）。

### 9.4 背压

- token 洪水（161 fragment/句 → `kimi.md:386`）：适配器按 §5.4 节流；L3 折叠窗口默认 5000ms、单轮 ≤8 条、≤1200 字符（ABI §11.2）。
- 事件投递队列高水位 → 丢弃可折叠事件（`message.delta`/`tool.progress`/`reasoning.delta`），**保留终态**（ABI §8 `transport.backpressure`）。

---

## 10. 失败与降级

### 10.1 **不支持 + 兜底总表**（本适配器的验收重点）

| 缺失/坑 | 证据 | 兜底路径 | 父级可观测差异 | 允许报错的条件 |
|---|---|---|---|---|
| **无单 turn 中断**（`session/cancel` → `-32601`；CLI 无入口） | `kimi.md:240`、`kimi.md:368`、`kimi.md:385` | **一任务一进程**：M5 = `killpg(SIGTERM)`（5s 后 SIGKILL）→ `turn.aborted{process-kill,partial:true}` + `session.lost` → 新进程 `session/load` 续接（epoch+1）；**不重放**被中断轮 | 中断延迟↑；当轮内容丢失；父子进度出现一次 `lost→recovered` | 调用方要求“中断后同会话同一轮可继续” → `capability.missing`（ABI R-3） |
| **ACP 客户端必须实现 `fs/read_text_file`**，否则 `session/prompt` 永久静默挂死 | `kimi.md:292-307`、`kimi.md:394` | ① 握手前强制注册（§2.3），注册失败即不许启动 ACP；② `maxTurnMs` 硬超时 + 空闲看门狗双保险；③ 超时 → 杀进程组，`limit.turn-timeout`；④ 兜底切 CLI 通道（CLI 无此要求，`kimi.md:363`） | 挂死被转成明确超时事件；慢盘/大文件读取可能触发误杀 | handler 无法注册且无 CLI 兜底 → 拒绝接入（`capability.missing`） |
| **权限命名错位**（CLI `-y`≈ACP `auto`；CLI `--auto`≈ACP `yolo`） | `kimi.md:88-104` | 按**语义**映射（§3.2），模式切换后以 `current_mode_update` 断言；漂移 → `session.warning` + 按更严档执行 | 父级看到的档位名可能与 CLI 习惯相反 | 无法映射到三档语义 → 收窄到 `read-only` + warning（ABI R-6/R-7） |
| **`-p` 与 `--auto/-y/--plan` 互斥**，headless 档位只能改 `config.toml: default_permission_mode` | `kimi.md:106-115`、`kimi.md:382` | CLI 兜底时按 §7.5 保守判定；档位不符则**拒绝 CLI 兜底**（切 ACP 或 fail fast） | CLI 通道无法按调用方要求降档；需用户改配置 | 调用方要求 `read-only` 而配置档位不可确认 → `policy.escalation-required` / `capability.missing` |
| **无 OS 级沙箱**（`sandbox-exec/seatbelt/landlock/bubblewrap` 命中 0） | `kimi.md:372`、`kimi.md:447` | worktree + `[[permission.rules]]` + 适配器路径策略（§7.4）；`yolo` 必须 worktree | 隔离强度显著低于 codex 的 `SandboxMode`；越界写只能事后审计 | 调用方要求“后端级只读硬保证” → `capability.missing`（ABI R-12） |
| **`default_plan_mode=true` 且 `ExitPlanMode` 自动批准** | `kimi.md:166`、`kimi.md:383` | 启动显式 `set_mode` 覆盖；识别“隐形只读阶段”；`session.warning` 提示 | 首轮可能先经历只读规划阶段 | 无法覆盖（set_mode 失败）→ `session.conflict` + 拒绝派发 |
| **ACP 无子代理方法**（仅盘上痕迹/二进制字符串） | `kimi.md:369`、`kimi.md:453` | 只透传能力位；子代理由 Broker 多实例模拟；`childSessionUpdates=unavailable` | 父级看不到子代理实时树，只有终态 | 调用方要求实时子代理树 → `capability.missing`（ABI R-14） |
| **版本只能锁路径**（`kimi upgrade` 无版本参数） | `kimi.md:377` | 注册表记录 `(binaryPath, sha256[:16], 实测 version)`；启动断言；不匹配 → 收窄能力位 | 升级可能静默换版本；只告警不阻断 | 断言失败且要求 `versionPinning=native` → `protocol.version-mismatch` |
| **未登录只能 terminal 设备码**（无 API-key auth method） | `kimi.md:211-217`、`kimi.md:223` | 启动预检存在性；运行期认证失败 → `auth.login-required` fail fast | 任务 blocked，需人工登录 | 无人值守下无法代答 → `auth.login-required`（ABI §8.2） |

### 10.2 错误映射（原生 → ABI §8）

| 原生 | 判定 | ABI 错误码 | 处置 |
|---|---|---|---|
| JSON-RPC `-32601 Method not found`（`kimi.md:241`） | 方法不存在 | `protocol.unknown-method` | 已知缺位（`session/cancel`）在握手期就声明，**运行期不调用**；其他 → `capability.unsupported-method` |
| `-32602`（含 `Unknown sessionId`，`kimi.md:242`） | 参数/会话无效 | `session.invalidated`（会话不存在）/ `protocol.invalid-params`（其他） | 触发 §4.2 R-1 |
| `-32603`（如 `Already in plan mode`，`kimi.md:236`、`kimi.md:384`） | 状态冲突 | `session.conflict` | 读取 `current_mode_update` 后按幂等语义处理（不重试同一 set_mode） |
| `stopReason` 缺失 + 进程退出 | 崩溃 | `process.crashed` | 冷恢复 |
| 退出码 `-15`（SIGTERM，`kimi.md:368`） | 本端杀 | `process.killed`（预期） | 按中断语义结束 |
| 握手 `protocolVersion != 1` / `agentInfo.version` 不符 | 版本 | `protocol.version-mismatch` | fail fast，禁止混跑 |
| 单帧 JSON 解析失败 | 帧 | `transport.frame-invalid` | 丢弃+计数；连续 5 帧 → `protocol.bad-frame` |
| 限流（ACP error 含 rate 信息，**未实测**） | 429 类 | `quota.rate-limited` | 退避 ≤5，尊重 `Retry-After`（形状 TO-VERIFY，ABI AB-V4） |

### 10.3 降级路径与“禁止动作”

- 降级必须在握手期一次性声明（`CreateResult.substitutions[]` / `degradeWarnings[]`），运行期**只允许进入 `blocked` 等上层决策**（ABI §3.5 硬规则 2）。
- **禁止**：① 超时后重发 `session/prompt`（无内置超时、无法对账 → 必然重复轮次）；② 同进程跑多会话（中断连带杀伤）；③ 把 `session/cancel` 当作可用方法（必 `-32601`）；④ 按 CLI 旗标名字映射权限档；⑤ 用磁盘 `agents/` 目录当事件源；⑥ 读 `~/.kimi-code/config.toml` 里的 api_key 值（只读键名/非敏感值，ABI SEC-1）。
- 自动化恢复顺序（M8 `strategy=auto`）：`resume` → `reseed`（`sessionReseed=emulated`）→ `abort`，任一步成功即停（ABI §6.2 M8）。

---

## 11. 可观测性

### 11.1 用量与成本（coarse，不可对账）

- 唯一用量信号：`usage_update{used,size}`（→ `kimi.md:268`、`kimi.md:375`）→ `usage.updated`（§5.2 #16），`estimated:true`、`scope:"turn"`、`durationMs`。
- 轮末耗时可用适配器本地计时（参考实测：`-c` 一轮 5,324ms → `kimi.md:350`；ACP 一次 turn 的 fragment 数 161 → `kimi.md:264`）。
- `costUsd` **不产生**（无计费字段）→ 预算控制只能按“调用次数/时长/上下文 used”近似；不得用于财务对账（矩阵口径 → `capability-matrix.md:25`）。
- 会话级校准：`kimi session list --json` 的 `id/workDir/sessionDir/createdAt/updatedAt/archived/lastTurnReason`（→ `kimi.md:346`）；每会话 `state.json`（→ `kimi.md:375`）。**这些只做校准，不作为事件源。**

### 11.2 诊断计数（必须暴露）

| 指标 | 来源 | 用途 |
|---|---|---|
| `drop.available_commands_update` / `drop.session_info_update` / `drop.config_option_update` | §5.3 | 证明丢弃是显式而非漏映射 |
| `fold.reasoning_dropped` / `coalesce.tool_progress` | §5.4 | 折叠比例可观测（ABI AB-V6 阈值回填输入） |
| `prompt.timeout` / `kill.sigterm` / `kill.sigkill` | §9.3 | 中断/挂死健康度 |
| `handshake.ms` / `turn.ms` / `fragments.per_turn` | §2.2、§11.1 | 时延与洪水基线 |
| `response.unexpected` / `frame.invalid` | §5.2 #27 | 协议健康度 |

- 输出：`diagnostic.log{component:"adapter.kimi"}`；父会话只收折叠后的 `session.warning`（窗口内 ≤1 条，ABI §7.1）。

### 11.3 日志与脱敏

- 适配器日志**不落**：token/api_key/OAuth、`config.toml` 敏感值、用户 home 绝对路径（按配置脱敏家目录，ABI SEC-2）。
- `~/.kimi-code/logs/kimi-code.log` 是**后端日志**，不是协议事件源；只在 `diagnostic.log` 里记录“存在性/尾部摘要（脱敏）”，不解析它驱动状态机（避免把非契约文本当协议）。
- `traceId`：每个 ABI 请求生成，贯穿 ACP JSON-RPC `id` 与 `diagnostic.log`（ABI §8.3）。

### 11.4 不可观测项（明确列出）

- 子代理实时树（无 ACP 方法 → R-14）；
- 结构化 plan/diff（无事件 → 只能从工具结果/磁盘痕迹旁证，不进 ABI）；
- 精确 token/成本（只有上下文 used/size）；
- 运行中转向/输入队列（无 `steerTurn`/`inputInbox`）。

---

## 12. 验收命令

### 12.1 文档闸门

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py adapters; echo "rc=$?"       # 本文件零 FAIL（其他后端缺失属正常）
```

### 12.2 探测复跑（`repro/probe-kimi.sh`，只读、幂等、零额度，约 5s）

```bash
bash repro/probe-kimi.sh; echo "rc=$?"                   # 期望 rc=0
```

段号与本文件的对应：

| 脚本段 | 验证的本文件结论 | 期望证据 |
|---|---|---|
| §0 身份与版本 | §1.1 版本/二进制 | `2.3.1`、路径/大小（`kimi.md:18-19`） |
| §1 子命令面 | §0.1 ACP stdio 固定、fork/export/session 面 | `acp --help` 无传输参数（`kimi.md:60-67`） |
| §2 权限/模式旗标 | §3.2/§7.5 命名错位、`-p` 互斥 | `Ask When Needed` vs `Never Ask` 原文（`kimi.md:45-46`） |
| §3 内置 profile | §6.1 5 个 profile | `plan, agent, coder, explore, tower-worker`（`kimi.md:124`） |
| §4 config 键名 | §7.4/§7.5/§8 配置映射 | `default_permission_mode`/`default_plan_mode`/`[[permission.rules]]`（`kimi.md:161-193`） |
| §5 ACP initialize | §2.2 握手断言 | `protocolVersion: 1`、`agentInfo.version`、`authMethods`（`kimi.md:197-219`） |
| §5b `PROBE_ACP_SESSION=1` | §3.1 会话方法、§10.1 无中断 | `session/new`、`fork`、`list` 成功、`session/cancel` → `-32601`（`kimi.md:230-242`） |
| §6 会话目录 | §6.1 子代理痕迹 | `agents/main`、`agents/agent-N`（`kimi.md:149-157`） |
| §7 会话列举 | §4.1 校准、§4.2 作用域 | `session list --json`（`kimi.md:346`） |
| §8 工具扩展 | §1.2 `toolExtension` | plugins/skills/mcp.json（`kimi.md:352-357`） |
| §9 `PROBE_LIVE=1` | §3.4 最小示例的通道行为 | `stream-json` 三行事件（`kimi.md:309-332`，消耗额度） |

```bash
PROBE_ACP_SESSION=1 bash repro/probe-kimi.sh; echo "rc=$?"   # 有副作用：写 ~/.kimi-code/sessions
PROBE_LIVE=1 bash repro/probe-kimi.sh; echo "rc=$?"          # 消耗额度
```

### 12.3 契约测试（施工 C6 落地；断言优先，证据形态可复跑）

| ID | 断言 | 命令/证据 |
|---|---|---|
| K1 | 握手断言通过：`protocolVersion==1`、`agentInfo.version=="2.3.1"`，否则 `protocol.version-mismatch` | 录 ACP 帧；对照 `kimi.md:202`、`kimi.md:217` |
| K2 | **无 fs handler 必然挂死**（负向测试）：故意关掉 handler，`session/prompt` 必须在 `maxTurnMs` 内被超时中断，进程组被杀 | 挂起测试 ≤ 配置超时（对照 ABI-T8 ≤2s 口径的放大版）；证据 `kimi.md:292-307` |
| K3 | `fs/read_text_file` 越界（`../../etc/passwd`、worktree 外绝对路径）→ 拒绝 + `policy.sandbox-violation`，**不挂起** | 单测 + 异常路径断言 |
| K4 | 模式语义：请求 `safe-auto` → `current_mode_update.currentModeId=="auto"`；请求 `yolo` → `"yolo"`；请求 `read-only` → `"plan"`（严格档） | 对照 `kimi.md:97-104`；断言**不是**按名字 |
| K5 | 权限自动拒绝：`request_permission` 收到 Write → 自动 `reject`，目标文件不存在 | 复刻 `kimi.md:288` 的实测 |
| K6 | 中断：`killpg(SIGTERM)` ≤5s → `turn.aborted{process-kill,partial:true}`，pgid 全部退出；随后新进程 `session/load` 续接（**TO-VERIFY**，见 §12.4） | `ps -o pgid` 断言；对照 `kimi.md:368`、`kimi.md:385` |
| K7 | 多轮：同 session 两次 prompt 均 `end_turn`，`turn.completed` 恰好 2 条 | 对照 `kimi.md:244-252` |
| K8 | 幂等：同 `clientRequestId` 重放 `session.send` → 后端 `session/prompt` 计数为 1，返回同 `turnId` + `deduplicated:true` | 适配器请求日志计数（ABI-T4 口径） |
| K9 | 一任务一进程：同后端两次派发 → 两个不同 pgid；杀掉 A 不影响 B 的会话 | `ps` + B 续跑断言 |
| K10 | 事件不变量：`seq` 严格 +1、终态唯一、`epoch` 单调；token 洪水下父会话 `progress.folded` 条数 ≤ 上限 | 事件序列断言（ABI EV-1/EV-4、§11.2） |

### 12.4 已验证 / TO-VERIFY 清单（含补测步骤）

**已验证（本机实测，可直接复跑）**：版本/二进制（`kimi.md:18-19`）、ACP 握手（`kimi.md:197-219`）、会话方法全表与 `session/cancel` → `-32601`（`kimi.md:230-242`）、同会话多轮（`kimi.md:244-252`）、`session/update` 全集（`kimi.md:254-270`）、`request_permission` 形状与拒绝生效（`kimi.md:272-290`）、`fs/read_text_file` 挂死对照（`kimi.md:292-307`）、CLI `stream-json` 形状（`kimi.md:309-332`）、fork/export/续接（`kimi.md:336-348`）、权限命名错位（`kimi.md:88-104`）、无 OS 沙箱（`kimi.md:372`、`kimi.md:447`）。

**TO-VERIFY（施工 C6 补测，不阻塞本规格）**：

| # | 未验证项 | 补测步骤 | 回填位置 |
|---|---|---|---|
| V-1 | 杀进程后**新进程** `session/load` 的真实往返（含 fork/并发） | 建会话 → 记 `session_<id>` → `killpg` → 新进程 `initialize` + `session/load{sessionId,cwd}` → `prompt`，断言 `end_turn` 且历史保留 | §1.2 `processKillInterrupt`、§4.2、K6 |
| V-2 | `config.toml: default_permission_mode` 各值的**真实语义**（`auto` 是 Never Ask 还是 safe-auto） | 依次把该键改成 `plan`/`default`/`yolo`/`auto`，各跑一次“写文件”prompt，观察是否需审批/是否真的写盘（用 /tmp 隔离） | §7.5、§10.1 |
| V-3 | 未登录机器的错误形态（`authMethods` 只有 terminal） | 用独立 `KIMI_HOME`/副本二进制或临时移走 `~/.kimi-code/credentials`（先备份）→ 跑 `-p` 与 ACP `session/prompt`，记录错误码 | §8.1、§10.2 |
| V-4 | `set_config_option{configId:"thinking"}` 的 value 语义（effort 取值） | `session/new` 读 `configOptions` 全量 → 逐个 `set_config_option` 观测 `config_option_update` | §8.2 |
| V-5 | ACP 下 agent profile 是否可影响首轮工具集（ACP 无 agent 参数） | `session/new` 后发同一 prompt，对比 `config.toml` 默认 profile 与 `--agent plan` 的 CLI 结果差异 | §6.2 |
| V-6 | 限流/额度错误的 ACP 形态 | 用受限额度账号或故障注入触发 429/额度错误，抓 ACP error 原文 | §10.2（ABI AB-V4） |
| V-7 | `session/update` 与 tool 的 `status:"failed"` 观测值 | 构造工具失败（读不存在文件/权限拒绝）→ 录 `tool_call_update` | §5.2 #15 |

### 12.5 一次性复跑入口

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py adapters; echo "rc=$?"     # 文档闸门
bash repro/probe-kimi.sh; echo "rc=$?"                 # 探测闸门（只读）
# 施工 C6 起：pnpm -s test -- kimi   # 契约测试 K1–K10（本文件 §12.3）
```

> 与本文件配套：后端调研 `docs/research/kimi.md`（证据源）、能力矩阵 `docs/research/capability-matrix.md`（选型与能力位口径）、ABI `docs/abi/abi-v0.md`（唯一命名真源）、探测脚本 `repro/probe-kimi.sh`（可复跑证据）。
