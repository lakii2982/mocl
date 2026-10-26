# MOCL 文档索引（Documentation Index）

> 目标：在 DSH 里把 codex / kimi-code / claude-code / opencode 统一成**可编排的子智能体**，
> 做法是「四适配器 + 内部 ABI + 会话代理 + 事件总线 + 控制面」，不改 DSH 核心。
> 实现与设计文档在同一仓库；本页是文档入口（≤1 页）。

## 0. 版本基线（当前）

| 组件 | 基线 | 说明 |
|---|---|---|
| DSH 宿主 API | **0.2.1-rc.3** | 升级 DSH 需复核 `src/plugin/dsh-types.d.ts` 与 `ctx.tools` 注册签名 |
| codex | **0.164.0** | 唯一生产基线；协议计数 106/85/10（ClientRequest/ServerNotification/ServerRequest） |
| claude-code | **Agent SDK 0.3.263 + 内置 CLI 2.1.263** | 适配器基线；宿主另装的 `claude` 2.1.310 属另一条升级线，默认不用 |
| kimi | **2.3.1** | ACP over stdio |
| opencode | **2.1.4** | v2 HTTP 优先 + ACP 兜底；生产模型 key 过期时降级免费模型 |

## 1. 30 秒速查

| 问题 | 答案 |
|---|---|
| 接入路线？ | **旁路插件 + seam 公开 provider 扩展点，不改 DSH 核心**；扩展 seam 让外部子级可续接登记为二期。见 `docs/integration/00-dsh-integration.md` §0 |
| 工具形态？ | 一个统一入口 `subagent_agent(backend=…)` + `mocl_status`；旧的一次性 `subagent-codex` / `subagent-claude-code` 由 patch 停用 |
| 进度怎么给父会话？ | 一期 = 终态完成通知 1 条 + `mocl_status` 查询 + 落盘文件；不写父会话中间消息（硬上限 8 条 / 1200 字符每轮） |
| 默认安全档？ | 四闸 fail-closed：`enabled:false`、`permissionMode:read-only`、`allowDangerousModes:false`、`worktreeIsolation:required-for-write` |
| 并发上限？ | 一律取运行时 `subagent.maxActiveSubagents`（配置缺省 `runtime` 跟随）；读取失败 → fail-closed，禁止硬编码数字 |
| opencode 能用吗？ | 免费模型池可用（实测 rc=0、`-s` 可续接）；生产模型 key 过期（401 `api_key_expired`），需在 OpenCode Console 新建 key，失效时自动降级并标 `degraded` |
| 现在怎么验？ | `pnpm validate && node tools/sync-schema.mjs --check && pnpm test && pnpm docs:check && pnpm leak-scan` |

## 2. 按角色阅读路径

### 新贡献者 / 施工者

1. 根目录 `README.md` → `CONTRIBUTING.md`
2. `docs/abi/abi-v0.md`（唯一命名真源：能力位 / 方法 / 事件 / 错误码）→ `docs/abi/schema/*.json`
3. `docs/architecture/00-overview.md` → `01-layers.md` → `02-state-machine.md` → `03-failure-modes.md`
4. 按切片读 `docs/adapters/{codex,claude-code,kimi,opencode}.md`（握手 / 会话 / 事件 / 权限 / 失败降级 / 验收）
5. 接 DSH 读 `docs/integration/*`；写代码前读 `docs/test/00-test-plan.md`

### 评审 / 复验

1. `docs/review/SCORECARD.md`（打回项与判定）→ `docs/review/VERIFY-GATE.md`（独立复验证据）
2. 自己重跑：`pnpm validate`、`node tools/sync-schema.mjs --check`、`pnpm test`、`pnpm docs:check`
3. 评审纪律：只看产物与证据，不看作者解释；每条强断言必须能指到命令/行号/导出物

### 用户 / 决策者

1. 根目录 `README.md` 的「后端支持」「项目状态与已知限制」
2. `docs/integration/00-dsh-integration.md` §0（路线结论与代价）、§3.1（逐项对比）
3. 已知限制：官方 GUI 对外部子级只显示**不可打开的叶子**（无状态/进度/用量）；进度用 `mocl_status` 与 journal
4. 流程与角色（issue → 实现 → 验证 → 评审 → 合并 → 发布）见 `docs/process/`
5. **不懂开发 / 不想碰 GitHub**：用对话式交付（`docs/process/11-CONVERSATION-MODE.md`）——你只拍板「做不做 / 往哪做 / 验收」，其余（工作流设计、实现、质量保证、合并、发布）由 DSH 自驱动并用人话回报

## 3. 文档地图（每份一句话职责）

| 文档 | 一句话职责 |
|---|---|
| `docs/abi/abi-v0.md` | ABI 唯一命名真源：34 能力位 / 18 方法 / 35 事件 / 46 错误码 / 幂等 / 父会话增量；§12.1 按用途索引 |
| `docs/abi/schema/*.json` | 可解析 JSON Schema：session / event / error / capabilities / request |
| `docs/architecture/00-overview.md` | 分层总览、DEC-1 决策、部署形态、未决项 |
| `docs/architecture/01-layers.md` | L0–L5 逐层契约 / 不变量 / 降级；父会话增量策略 |
| `docs/architecture/02-state-machine.md` | 9 态状态机、转移表、幂等/冷恢复 |
| `docs/architecture/03-failure-modes.md` | 失败模式分类、重试/熔断、降级阶梯 |
| `docs/research/{codex,claude-code,kimi,opencode}.md` | 四后端实测证据（版本/协议/CLI/限制）+ 可复跑探测 |
| `docs/research/capability-matrix.md` | 4×15 能力矩阵 + 传输选型 + 能力位建议 |
| `docs/adapters/{codex,claude-code,kimi,opencode}.md` | 每后端 L1 映射：握手 / 会话 / 续接 / 事件 / 权限 / 失败降级 / 验收命令 |
| `docs/integration/00-dsh-integration.md` | 接入路线逐项对比、推荐与触发条件、迁移 |
| `docs/integration/01-config-and-enable.md` | 配置参考、patch 启用/停用/回滚/残留清理 |
| `docs/integration/02-ui-data-plane.md` | GUI 数据面：能渲染什么、最小新增、无 UI 时降级 |
| `docs/risk/00-risk-register.md` | 风险登记册（字段完整、错误码统一 ABI） |
| `docs/risk/01-threat-model.md` | 威胁模型：凭据 / 路径穿越 / 沙箱 / 提示注入 / 越权写 / 供应链 |
| `docs/test/00-test-plan.md` | 契约测试 / 录制回放 / 故障注入 / 验收门禁 |
| `docs/test/01-acceptance.md` | 验收矩阵与命令 |
| `docs/review/SCORECARD.md` / `VERIFY-GATE.md` | 独立评审结论与复验记录（历史） |
| `docs/runbook.md` | 运维手册：codex 基线门禁/升级、DSH 插件 bootstrap、e2e 演练 |
| `docs/process/` | 开发流程 OS：G0–G7 门禁、角色、issue/PR 契约、发布、度量、升级 |
| `repro/` | 只读、零额度、可复跑的后端探测脚本（`repro/run_all.sh`） |

## 4. 一键验证

```bash
cd "$(git rev-parse --show-toplevel)"

node tools/validate-abi.mjs          # ABI 契约闸门（46/34/35/18）
node tools/sync-schema.mjs --check   # docs/abi/schema → schema/ 逐字节一致
python3 tools/check_docs.py all      # 文档结构 / 计数 / 要素 / 链接
node tools/leak-scan.mjs             # 无个人路径、凭据、内部台账引用
pnpm test                            # 离线测试
bash repro/run_all.sh                # 四个后端只读探测（缺失项标 SKIP）
```

## 5. 文档纪律（本仓库已固化）

1. **单一事实单处定义**：能力位 / 事件 / 错误码只在 `abi-v0.md` 与 schema 定义；计数类数字只在一处定义、其他处引用，禁止各自复制后漂移。
2. **先跑红、后跑绿**：任何结论先给可复跑命令；闸门/探针红则不得宣称完成。
3. **不确定就标注**：`TO-VERIFY` + 风险登记册；禁止编造实测。
4. **安全默认不得反向**：四闸（enabled false / read-only / allowDangerous false / worktree required）任何文档/配置不得默认放宽。
5. **公开仓纪律**：不提交个人绝对路径、凭据、本机专属配置；发布前 `node tools/leak-scan.mjs` 必须 exit 0。
