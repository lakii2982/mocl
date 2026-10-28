# MOCL

> **DeepSeek Harness（DSH）** 的多智能体编排兼容层。
> MOCL 用一套 ABI 统一 **codex**、**claude-code**、**kimi**、**opencode**，把它们
> 暴露为可编排的子智能体，且**不修改 DSH 本体**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

MOCL 处于 1.0 之前（`0.1.0`）。本仓库是 MOCL 实现与设计文档的**唯一真源**。

---

## 1. MOCL 做什么

四个后端各说各的协议、各暴露各的能力。MOCL 位于 DSH 与后端之间，只做四件事：

1. **统一会话**：把每个后端会话变成可寻址、可续接、可中断、可观测的逻辑会话。
2. **统一事件流**：把四套原生事件归一化成一条有界、可折叠、可重放的事件流
   （对父会话的投递有硬上限）。
3. **统一失败形态**：把四套原生错误归一化成一棵错误分类树 + 固定降级路径。
4. **一套 ABI**：新增后端 = 新增一个适配器；broker、事件总线、门面、DSH 插件不变。

非目标：GUI 视觉设计、fork/修改 DSH 内部实现、后端产品自身功能、跨后端会话迁移。

ABI 契约由 `tools/validate-abi.mjs` 机器校验：**46** 错误码、**34** 能力位、
**35** 事件类型、**18** 方法（其中 9 个由 schema 冻结）。

## 2. 后端支持

| 后端 | 传输（首选） | 基线版本 | 本机实测状态 |
|---|---|---|---|
| **codex** | `app-server` JSON-RPC（stdio） | codex-cli **0.164.0** | 离线链路已验证；live turn 受环境限制（`app-server` 约 47s 后返回 `turn.failed`） |
| **claude-code** | Claude Agent SDK（适配器基线 SDK **0.3.263**，内置 CLI 2.1.263） | Agent SDK 0.3.263 | live smoke **通过** |
| **kimi** | ACP over stdio | kimi-code **2.3.1** | 只读探针通过；live smoke 消耗保留额度（默认不跑） |
| **opencode** | v2 HTTP API（ACP 作备选通道） | opencode **2.1.4** | 免费模型池端到端实测通过（`rc=0`、可续接）；付费 key 已过期（`401 api_key_expired`） |

完整的 4 × 15 能力矩阵（每格带证据与复跑入口）见
[`docs/research/capability-matrix.md`](docs/research/capability-matrix.md)。
能力状态来自实测：握手探测不到原生能力的适配器会如实报告缺失，而不是假装可用。

## 3. 架构

MOCL 是旁路层：DSH 保留自己的 subagent seam，MOCL 以插件形式组合进去。会话真相
由 MOCL 的 broker 自管，因为 seam 把外部后端当作「一次执行、拒绝后续输入」。

```text
 父 DSH 会话
        │  subagent_agent(backend = codex | claude-code | kimi | opencode)
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 门面          open / send / status / list / resume /        │
 │               interrupt / close  →  MoclError → ABI ErrorRef│
 ├───────────────────────────┬─────────────────────────────────┤
 │ broker                    │ 事件总线                         │
 │ 会话注册表、幂等、        │ 折叠、环形缓冲、限流、           │
 │ kill / 冷恢复             │ 父会话投递（每轮 ≤1 条终态）     │
 ├───────────────────────────┴─────────────────────────────────┤
 │ ABI v0：46 错误码 · 34 能力位 · 35 事件 · 18 方法            │
 ├─────────────────────────────────────────────────────────────┤
 │ 适配器     codex │ claude-code │ kimi │ opencode             │
 └──────────────┬────┴──────┬───────┴───┬──┴────────────────────┘
                │           │           │
      app-server JSON-RPC  Agent SDK    ACP / v2 HTTP
                │           │           │
        codex 进程      claude CLI   kimi 进程   opencode 服务
```

分层（见 [`docs/architecture/01-layers.md`](docs/architecture/01-layers.md)）：
L0 传输 → L1 适配器 → L2 broker → L3 事件总线 → L4 父会话投递 → L5 门面/插件。

## 4. 快速开始

要求：**Node.js >= 24**（仓库带 `.nvmrc`）、pnpm，以及用于文档闸门的
Python 3.9+。

```bash
git clone https://github.com/lakii2982/mocl.git
cd mocl
pnpm install

pnpm typecheck                    # 严格 TypeScript 类型检查（noEmit）
pnpm test                         # 离线测试（vitest）
pnpm validate                     # ABI 闸门（46/34/35/18）
node tools/sync-schema.mjs --check  # schema 副本与 docs/abi/schema 逐字节一致
pnpm docs:check                   # 文档结构 / 计数 / 链接
pnpm leak-scan                    # 无个人路径、凭据或内部台账
```

以上 6 条命令均应 exit `0`。离线测试套件不需要任何凭据；live 测试与探针为
opt-in，缺少对应后端 CLI 时会自动跳过。

可选的端到端演练（离线，使用临时 git worktree + 假后端）：

```bash
node e2e/pr-scenario.mjs          # 期望：RESULT: PASS (offline)
MOCL_LIVE=1 node e2e/pr-scenario.mjs  # live 档，需要可用后端
```

发布前场景回归（离线；按真人使用路径走 DSH 工具面，并重跑发布门禁）：

```bash
node scenarios/run.mjs                # 12 个场景 + 11 条门禁，产出签收单
node scenarios/run.mjs --strict-known # 已知缺口也阻塞（发布签收推荐）
node scenarios/run.mjs --live         # 额外跑真实后端 smoke
```

场景清单、已知缺口政策与报告格式见 [`scenarios/README.md`](scenarios/README.md)。

## 5. 在 DSH 中使用

MOCL 以 DSH 插件形式交付，注册两个工具：

- `subagent_agent(backend, task, ...)` —— 把任务派发给四个后端之一，返回子会话 id；
- `mocl_status(childId?, cursor?)` —— 按 cursor 查询会话状态/事件。

仓库提供：

- `config.default.json` —— fail-closed 默认值：四后端全禁用、
  `permissionMode: read-only`、禁止危险模式、写入必须 worktree 隔离；
- `config.example.json` —— 同形状示例，可作为起点复制；本地配置文件已被 git 忽略，**不得提交**；
- `patch/cordis.patch.yml` —— 新增插件行，并停用旧的一次性
  `subagent-codex` / `subagent-claude-code` 工具。

### 外部子代理状态面板

插件同时提供 client 半：右侧栏 **「外部代理」** tab 逐行显示每个 MOCL 子代理
「在干什么」（任务摘要）、实际运行体（backend · 通道 · 原生 id · 版本）、生效模型与
实时状态。官方子代理目录把这些外部任务画成**不带执行状态**的叶子条目，这正是本面板
存在的理由。

面板是 `mocl_status` 背后同一门面的**只读投影**（`GET /mocl-panel/list`），仅在 tab
打开时 2s 轮询、关闭即停，客户端不自算状态。

v1.2 起改为**分组仪表盘**：顶部 4 个可点击计数块（运行中/排队/失败/已完成），
按状态分组且组头吸顶可折叠（已完成/已丢失默认收起）；每行有状态芯片与状态色条、
模型 chip（标注实际/配置值/降级/未知），详情分为"人话信息 + 收起的「技术详情」"
（childId / cwd / depth / epoch / turnId 只在技术详情里）。设计与状态表见
[`docs/design/external-agent-panel/`](docs/design/external-agent-panel/README.md)。

```bash
bash scripts/install-panel.sh    # 构建 host + client 半并热替换插件
bash scripts/uninstall-panel.sh  # 恢复上一版 dist 并热替换回去
```

启用/回滚步骤、完整配置项与 GUI 数据面说明见：

- [`docs/integration/01-config-and-enable.md`](docs/integration/01-config-and-enable.md)
- [`docs/integration/00-dsh-integration.md`](docs/integration/00-dsh-integration.md)
- [`docs/integration/02-ui-data-plane.md`](docs/integration/02-ui-data-plane.md)

## 6. 目录结构

```text
mocl/
├── src/
│   ├── abi/          # ABI v0 类型、常量、AJV 运行时校验
│   ├── adapters/     # codex、claude-code、kimi、opencode
│   ├── broker/       # 会话注册表、幂等、并发、kill/冷恢复
│   ├── bus/          # 事件总线、折叠、环形缓冲、父会话投递
│   ├── facade/       # 后端无关门面（配置、错误、适配器装配）
│   └── plugin/       # DSH 薄插件：subagent_agent / mocl_status
├── schema/           # docs/abi/schema/*.json 的逐字节副本
├── fixtures/         # ABI 契约样例（合法 + 非法）
├── tests/            # 单元 / 契约 / e2e 测试（vitest）
├── tools/            # validate-abi、sync-schema、check_docs、leak-scan、build-plugin
├── scripts/          # codex 基线断言/升级、DSH 工具断言
├── e2e/              # 离线 PR 演练（假后端 + worktree）
├── repro/            # 只读、零额度的后端探测脚本
├── patch/            # DSH patch（启用插件、停用旧工具）
├── config.default.json / config.example.json
└── docs/             # ABI、架构、适配器、集成、调研等设计文档
```

## 7. 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/index.md`](docs/index.md) | 一页入口与阅读路径 |
| [`docs/abi/abi-v0.md`](docs/abi/abi-v0.md) | ABI v0：能力位、方法、事件、错误码、幂等、上限 |
| [`docs/architecture/00-overview.md`](docs/architecture/00-overview.md) | 分层总览、DEC-1 决策、部署形态 |
| [`docs/architecture/01-layers.md`](docs/architecture/01-layers.md) | L0–L5 契约、不变量、降级 |
| [`docs/architecture/02-state-machine.md`](docs/architecture/02-state-machine.md) | 会话状态机、转移、幂等、冷恢复 |
| [`docs/architecture/03-failure-modes.md`](docs/architecture/03-failure-modes.md) | 失败模式分类、重试、降级阶梯 |
| [`docs/adapters/`](docs/adapters/) | 各后端 L1 映射（握手、事件、权限、验收） |
| [`docs/research/capability-matrix.md`](docs/research/capability-matrix.md) | 4 × 15 能力矩阵与证据 |
| [`docs/integration/`](docs/integration/) | DSH 集成路线、配置、UI 数据面 |
| [`docs/risk/00-risk-register.md`](docs/risk/00-risk-register.md) | 风险登记册 |
| [`docs/risk/01-threat-model.md`](docs/risk/01-threat-model.md) | 威胁模型（凭据、路径穿越、沙箱、提示注入、供应链） |
| [`docs/test/01-acceptance.md`](docs/test/01-acceptance.md) | 验收矩阵与命令 |
| [`docs/runbook.md`](docs/runbook.md) | 运维手册（codex 基线、插件 bootstrap、e2e） |

文档由 `tools/check_docs.py` 做机械闸门校验（结构、必填小节、ABI 计数、错误码
词表、相对链接可解析）。设计文档以中文为主，README 提供中英双版。

## 8. 项目状态与已知限制

本仓库已验证（命令与退出码可复跑）：

- ABI 契约闸门：46 / 34 / 35 / 18 —— `node tools/validate-abi.mjs`
- schema 副本闸门：`node tools/sync-schema.mjs --check`
- 离线端到端演练：`node e2e/pr-scenario.mjs` → `RESULT: PASS (offline)`

已知限制（详见 [`CHANGELOG.md`](CHANGELOG.md)）：

- `codex` live turn 在本机受环境限制，live e2e 记为 `skipped:host-unavailable`；
- `kimi` live smoke 消耗保留额度，默认探针零额度且只读；
- `opencode` 付费模型凭据已过期，适配器自动降级到免费模型池（已实测）；恢复需在
  OpenCode Console 新建 key；
- DSH 宿主 API 基线为 **0.2.1-rc.3**，升级 DSH 需复核
  `src/plugin/dsh-types.d.ts` 与工具注册签名；
- 官方 DSH GUI 对外部子代理只显示不可打开的叶子行，状态/进度请用
  `mocl_status` 与会话 journal；
- 不做 npm 发布，安装方式为 clone 本仓库。

## 9. 贡献

欢迎贡献。请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。提交 PR 前请跑第 4 节的闸门
（`typecheck`、`test`、`validate`、`sync-schema --check`、`docs:check`、
`leak-scan`）。

安全问题**不要**开公开 issue，请按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 10. 许可证

[MIT](LICENSE) © 2026 lakii2982
