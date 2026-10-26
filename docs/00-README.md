# MOCL 设计包 — 00 README（1 页速读）

> 目标：在 DSH 里把 codex / kimi code / claude code / opencode 统一成**可编排的子智能体**，做法是「四适配器 + 内部 ABI + 会话代理 + 事件总线 + 控制面」，不改 DSH 核心。
> 当前阶段：**设计包（可施工，不是生产代码）**。施工在**新工作区/新会话**按 `HANDOFF.md` 执行。
> 版本基线：DSH 0.2.1-rc.3 / **codex 生产基线 0.164.0（D-015；bundle 0.153.4 为待升级旧载荷，C11 前置升级）** / kimi 2.3.1 / **claude = Agent SDK 0.3.263 + SDK 内置 CLI 2.1.263（适配器基线；宿主 CLI 2.1.310 为另一条升级线）** / opencode 2.1.4 / macOS arm64。

## 30 秒速查

| 问题 | 答案 |
|---|---|
| 接入路线？ | **A（旁路插件 + seam 公开 provider 扩展点；不改 seam 源码/契约）**；B（扩展 seam 为 continuable）登记为二期；**B0 上游提案并行推进（W1，不阻塞施工；D-017）**，B2 fork 仍否决（D-011） |
| codex 基线？ | **0.164.0（D-015）**；profile 内 bundle 0.153.4 是待升级旧载荷 → **C0 前完成 C11 前置**（验收：两处 `--version` 一致 = 0.164.0；schema 计数 106/85），升级前不得以 0.153.4 断言假绿 |
| claude 基线？ | **Agent SDK 0.3.263 + SDK 内置 CLI 2.1.263（适配器基线，C5 实测）**；宿主 nvm 的 `claude` 2.1.310 属**另一条升级线**，默认不使用 |
| 工具形态？ | **一个统一入口 `subagent_agent(backend=…)`**；旧 `subagent_codex|claude_code` 由 patch 停用（D-014/R25） |
| 进度怎么给父会话？ | 一期 = **终态完成通知 1 条 + `mocl_status` 可查询 + 落盘文件**；不写父会话中间消息（D-009；硬上限 8 条/1200 字符/轮） |
| 默认安全档？ | codex/kimi/claudeCode `enabled:false` + **opencode `enabled:true`（D-018）** + `permissionMode:read-only` + `allowDangerousModes:false` + `worktreeIsolation:required-for-write`（四闸 fail-closed） |
| 并发上限？ | **一律取运行时 `subagent.maxActiveSubagents`（D-016）**：配置缺省 `runtime` 跟随，禁止硬编码 8；读取失败/缺失 → fail-closed 拒绝启动（本机 desktop 当前 20 仅为实例值，文档不写死） |
| opencode 能用吗？ | **能，且默认开启（D-018）**：四后端链路全部可用。生产模型 `opencode-go/deepseek-v4.1-flash` 的 key **已过期且重新登录不续期**（D-019）→ 需到 OpenCode Console **新建 key**（一次性动作）；key 失效时自动降级免费模型 `opencode/deepseek-v4.1-flash-free`（已实测 rc=0 + `-s` 续接），发 `degraded` 事件并声明 `model=free-fallback`，补测见 HANDOFF §8 |
| 现在能验收吗？ | 设计包全闸门绿：`python3 tools/check_docs.py all && bash repro/run_all.sh` |

## 按角色阅读路径

### 施工会话（新工作区，第一优先）

1. `HANDOFF.md`（交接书：必读顺序、C0–C10、开工前探测、禁止事项、待拍板）
2. `.astra/BRIEF.md`（需求真源）→ `.astra/PLAN.md` Part B（切片与验收命令）→ `.astra/LEDGER.md`（D-001…D-019 裁定）
3. `docs/abi/abi-v0.md`（唯一命名真源）+ `docs/abi/schema/*.json`（5 个 schema）
4. 按切片读对应适配器：`docs/adapters/{codex,claude-code,kimi,opencode}.md`（重点 §2 握手、§5 事件、§7 权限、§10 失败降级、§12 验收）
5. 接 DSH 时读 `docs/integration/*`（路线/配置/UI 数据面）；写代码前读 `docs/test/00-test-plan.md`

### 评审 / 复验

1. `docs/review/SCORECARD.md`（F1–F8 打回项与判定）→ `docs/review/VERIFY-GATE.md`（独立复验证据）
2. `.astra/INTEGRATION.md`（D10 修复记录 + **剩余不一致清单**；先看 §5）
3. 自己重跑：`python3 tools/check_docs.py all`、`bash repro/run_all.sh`、`docs/abi/abi-v0.md §12.2` 的自检脚本
4. 评审纪律：只看产物与证据，不看作者解释；每条强断言必须能指到命令/行号/导出物

### 用户 / 决策者

1. 本页「30 秒速查」+ `HANDOFF.md §9`（需你拍板的事项）
2. `docs/integration/00-dsh-integration.md §0`（路线结论与代价）+ `§3.1`（A/B 逐项对比）
3. 已知限制：官方 GUI 对外部子级只显示**不可打开的叶子**（无状态/进度/用量）；opencode 待凭据

## 文档地图（每份一句话职责）

| 文档 | 一句话职责 |
|---|---|
| `.astra/BRIEF.md` | 需求真源：目标/成功标准 A1–A11/非目标/硬约束 6 条/关键决策 |
| `.astra/PLAN.md` | 执行计划：设计切片 D0–D10 + 施工切片 C0–C10（写域/依赖/**脚本化验收命令**） |
| `.astra/LEDGER.md` | 契约台账 + 决策记录（D-001…D-014：选型/路线/上限/工具形态/openapi 通道） |
| `.astra/CONTEXT-DSH-SEAM.md` | seam 硬事实基线（NO_START_CAPABILITIES 全 false、外部一次性、maxDepth、catalog 叶子） |
| `docs/architecture/00-overview.md` | 分层总览、DEC-1、部署形态 P1–P3、AR 未决项 |
| `docs/architecture/01-layers.md` | L0–L5 逐层契约/不变量/降级；父会话增量策略与上限 |
| `docs/architecture/02-state-machine.md` | 9 态状态机、转移表、幂等/冷恢复、四个必答问题 |
| `docs/architecture/03-failure-modes.md` | 20 类失败模式、重试/熔断、降级阶梯 D0–D4 |
| `docs/abi/abi-v0.md` | ABI 唯一命名真源：34 能力位/18 方法/35 事件/46 错误码/幂等/父会话增量；**§12.1 按用途索引** |
| `docs/abi/schema/*.json` | 可解析 JSON Schema：session/event(35)/error(46)/capabilities(34)/request |
| `docs/research/{codex,claude-code,kimi,opencode}.md` | 四后端实测证据（版本/协议/CLI/限制）+ 可复跑探测 |
| `docs/research/capability-matrix.md` | 4×15 能力矩阵 + 传输选型（按后端）+ 12 能力位建议 + 口径仲裁 C1–C10 |
| `docs/adapters/{codex,claude-code,kimi,opencode}.md` | 每后端 L1 映射：握手/会话/续接/事件/权限/并发/失败降级/验收命令 |
| `docs/integration/00-dsh-integration.md` | A/B 路线逐项对比、推荐与触发条件、A→B 迁移 |
| `docs/integration/01-config-and-enable.md` | 配置 schema（98 顶层键/124 叶子键）、cordis.patch.yml 启用/停用/回滚/残留清理 |
| `docs/integration/02-ui-data-plane.md` | GUI 数据面：现有能渲染什么、最小 5 项新增、无 UI 时降级（工具+文件） |
| `docs/risk/00-risk-register.md` | 风险 ≥20 条（字段完整、错误码统一 ABI） |
| `docs/risk/01-threat-model.md` | 威胁模型：凭据/路径穿越/沙箱/提示注入/越权写/供应链 |
| `docs/test/00-test-plan.md` | 契约测试/录制回放/故障注入/验收门禁（脚本化） |
| `docs/test/01-acceptance.md` | A1–A11 验收矩阵与命令 |
| `docs/review/SCORECARD.md` / `VERIFY-GATE.md` | 独立评审结论与复验记录（历史，不改） |
| `.astra/INTEGRATION.md` / `.astra/JOURNAL.md` | D10 修复留痕 + 剩余不一致 / 可固化规则 |
| `HANDOFF.md` | 施工交接书（新工作区第一份读的文件） |

## 一键验证

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py all          # 文档闸门：exit 0 才算可交付
bash repro/run_all.sh                    # 探测闸门：4/4 PASS（只读、幂等、零额度）
python3 tools/check_docs.py abi && bash -c 'python3 - <<"PY"
import json,pathlib
d=json.loads(pathlib.Path("docs/abi/schema/event.json").read_text())
print("events:", len(d["properties"]["type"]["enum"]))
e=json.loads(pathlib.Path("docs/abi/schema/error.json").read_text())
print("error codes:", len(e["properties"]["code"]["enum"]))
PY'
```

## 文档纪律（本包已固化）

1. **单一事实单处定义**：能力位/事件/错误码只在 `abi-v0.md` 与 schema 定义；计数类数字（99/81/10、35、46、34）只在一处定义、其他处引用，禁止各自复制后漂移（F4 的根因）。
2. **先跑红、后跑绿**：任何结论先给可复跑命令；闸门/探针红则不得宣称完成。
3. **写域互斥**：跨片修改必须进 `.astra/INTEGRATION.md` 一行（文件/问题/改法/依据）。
4. **不确定就标注**：`TO-VERIFY` + 风险登记册；禁止编造实测。
5. **安全默认不得反向**：四闸（enabled false/read-only/allowDangerous false/worktree required）任何文档/配置不得默认放宽。
