# 00 — 运营模型（Operating Model）：G0–G7 与角色 RACI

> 定位：本文件是 MOCL 开发流程的**总入口**。它回答三件事：一个业务需求从哪进、经过哪 8 个门禁、每个门禁由谁负责且用哪条命令判定。
> 上下游：`01-REQUIREMENT-INTAKE.md` → `02-DESIGN-RFC.md` → `03-IMPLEMENTATION.md` → `04-VERIFICATION.md` → `05-REVIEW-MERGE.md` → `06-RELEASE.md` → `07-DELIVERY-REPORT.md`。
> 运行载体：GitHub（issue/PR/Actions/Release）+ 本地 orchestrator（`orchestrator/cli.mjs`）+ DSH 角色 agent（`agents/roles/*.md` 经 `dsh headless` 加载）。运行细节见 `10-DSH-LOCAL-AGENTS.md`。
> 唯一真源：门禁命令以 `mocl/package.json` 的 `scripts` 和本文 §3 的命令列为准；标签以 `.github/labels.yml` 为准；角色以 `agents/roles/*.md` 为准。本文不复制这些定义，只引用。

## 1. 目标与不变量

1. **用户只做 3 件事**：写 issue（业务场景 + 需求）、在升级点做决策、验收交付。其余全部由 agent 与自动化完成。
2. **交付定义**：一次合格交付 = 已合并 PR（`gh pr view <n> --json state,mergedAt` 显示 `MERGED`）+ 发布版本（`gh release view vX.Y.Z`）+ 交付报告（issue 评论，模板见 `07-DELIVERY-REPORT.md`）。
3. **单一真源**：GitHub 仓库是唯一真源；本地只允许存在 gitignored 的运行产物（`.agentspec/`）与 worktree（`.worktrees/`）。
4. **证据可复跑**：任何"已完成/已通过"必须附「命令 + 退出码 + 原始输出」，协议见 `04-VERIFICATION.md` §1。没有证据的完成陈述按未完成处理。
5. **判定权分离**：写代码的人不验证、不评审、不合并；验证者与评审者必须新上下文（见 §6 与 `agents/roles/verifier.md`、`agents/roles/reviewer.md`）。
6. **门禁只可加强**：任何 agent 不得为了让 PR 变绿而放宽门禁（改 CI、删测试、改 required checks、调低断言）；削弱门禁属升级事项（`09-ESCALATION.md` E-06）。

## 2. 门禁总表（G0–G7）

| Gate | 名称 | 负责角色（R） | 触发 | 关键命令/动作 | 出口判据（Done） | 产物落点 | label 变化 |
|---|---|---|---|---|---|---|---|
| **G0** | 需求受理 | product-owner | 用户提交 issue | 读 issue 模板字段；`gh issue view <n> --json title,body,labels` | 字段齐全（模板必填项非空）、类型/优先级已打标 | issue 本体 | `type/*` `priority/*` `area/*` |
| **G1** | 澄清与 DoR | pm | G0 通过 | 写澄清评论/编辑 issue；`node orchestrator/cli.mjs intake --issue <n>` | DoR 8 条全过（`01-REQUIREMENT-INTAKE.md` §3），验收口径 ≥3 条且可执行 | `.agentspec/issues/<n>/BRIEF.md` + issue 评论 | `agent:ready`（或 `status/needs-info`） |
| **G2** | 设计与 RFC/ADR | architect | `agent:ready` 且命中 RFC 触发条件 | 写 `docs/rfc/NNNN-<slug>.md`；必要时 `docs/adr/NNNN-<slug>.md` | RFC 合并进 `main`，或免 RFC 的设计说明评论 ≥5 行 | `docs/rfc/` `docs/adr/` + issue 链接 | 无（RFC 单独 PR） |
| **G3** | 实现 | implementer | G2 通过 | `git worktree add .worktrees/issue-<n> -b agent/<n>-<slug>`；改代码；`git commit`（Conventional Commits）；`git push`；`gh pr create` | PR 存在、`Closes #<n>`、PR 模板证据表已填、本地门禁至少 typecheck+相关测试绿 | 分支 `agent/<n>-<slug>` + PR | `status/in-progress` + `agent:running` → `status/in-review` + `agent:review` |
| **G4** | 独立验证 | verifier（新上下文） | PR 存在且非草稿 | 在干净 worktree 复跑 `04-VERIFICATION.md` §2 全部门禁 | 全部阻塞门禁 exit 0（或黄项已声明），证据表贴 PR 评论 | `.agentspec/runs/<iso>/verify/` + PR 评论 | `status/in-review` + `agent:review` 保持 |
| **G5** | 评审 | reviewer（新上下文） | G4 通过 | 读 diff + 证据；单账号模式：`gh pr comment` 写 `VERDICT: APPROVE|REQUEST_CHANGES`；多人模式：`gh pr review --approve` | 检查单全过（`05` §2）；评审结论 `VERDICT: APPROVE`（单账号）或 review `APPROVED`（多人） | PR 评论 / PR review | 请求改动 → `status/in-progress` |
| **G6** | 合并 | release-manager | G5 通过 | `gh pr checks <n>` 全绿；`gh pr view <n> --json mergeStateStatus,reviewDecision`；`gh pr merge <n> --squash --delete-branch` | 合并提交进 `main`，分支已删，CI 在 `main` 上绿 | `main` + 合并记录 | issue 自动关闭（`Closes` 关键字） |
| **G7** | 发布与交付报告 | release-manager + scribe | G6 通过且达到发布批次 | 更新 `CHANGELOG.md` → 版本 PR → `git tag vX.Y.Z` → `git push --tags` → `release.yml` 生成 Release；clean clone 复验 | Release 存在、发布后验证绿、交付报告已评论到 issue | GitHub Release + `.agentspec/runs/<iso>/DELIVERY-REPORT.md` + issue 评论 | `status/done` → 用户验收后 `status/accepted` |

**门禁三态**：`PASS`（命令 exit 0 且断言成立）/ `FAIL`（非 0 或断言失败，阻塞）/ `YELLOW`（环境缺失导致 SKIP，例如无 `gh` 凭据、无网络；必须在 PR 与交付报告声明，**不得冒充 PASS**）。判定细则见 `04-VERIFICATION.md` §3。

## 3. 角色 RACI

R = Responsible（执行），A = Accountable（最终负责），C = Consulted（必须征询），I = Informed（知会）。
`orchestrator` 与 `用户` 是外部参与者，不与 8 个 agent 角色混同。

| 角色 \ Gate | G0 | G1 | G2 | G3 | G4 | G5 | G6 | G7 |
|---|---|---|---|---|---|---|---|---|
| product-owner | **R/A** | C | C | I | I | I | I | I |
| pm | C | **R/A** | C | I | I | I | C | C |
| architect | I | C | **R/A** | C | C | C | I | I |
| implementer | I | C | C | **R/A** | C | I | I | I |
| verifier | — | — | I | C | **R/A** | C | I | I |
| reviewer | — | — | C | I | C | **R/A** | C | I |
| release-manager | I | I | I | I | I | C | **R/A** | **R/A** |
| scribe | I | C | C | I | C | I | I | **R**（报告/度量归档） |
| 用户（owner） | **A**（提需求） | C（只在升级点决策） | C（只在升级点决策） | I | I | I | I | **A**（验收） |
| orchestrator（系统） | 读 issue | 生成 intake 产物 | 读 RFC 链接 | 派发 deliver | 跑门禁 | 派发评审 | 不合并（契约无 merge） | 触发 release |

规则：
- 同一 issue 的 implementer / verifier / reviewer **不得同一上下文**；verifier 与 reviewer 也不得同一上下文（避免结论互相背书）。
- 合并动作（G6）由 release-manager 或 Lead 执行，implementer 不得自行合并自己的 PR。
- **单账号模式**（当前仓库）：GitHub 不允许对自己的 PR 提交 APPROVE review，G5 出口以 reviewer（新上下文、非作者）的 PR 评论 `VERDICT: APPROVE` 为机械判据；转 public/多人后升级为 `reviewDecision=APPROVED`。详见 `05-REVIEW-MERGE.md` §4。
- 迭代期内 `main` 保护强制 PR + required checks；任何直推 `main` 视为流程违规，需 Lead 记录并回滚。

## 4. 状态机（label 驱动，机械可判）

状态由 issue 上的 label 唯一表达；转换只允许下表列出的边。标签名以 `.github/labels.yml` 为**唯一真源**，本表只是消费视图。既无 `status/*` 又无 `agent:ready` 的 issue 视为 `triage`。

```text
             G0                        G1                       G3                          G4/G5                    G6        G7
 (status/needs-triage) ──► type/* + priority/* ──► agent:ready ──► status/in-progress ──► status/in-review ──► CLOSED ──► status/done ──► status/accepted
                                                    + agent:running      + agent:review        │
                                               agent:blocked / status/blocked ◄──────────────┘（失败或等决策）
                                                    status/needs-info（等用户决策）
```

| 当前 | 事件 | 新状态 | 执行者 | 判定条件 |
|---|---|---|---|---|
| `status/needs-triage`（或空） | 类型/优先级打标完成 | `type/*` + `priority/*` 就位 | product-owner | 各 1 个 |
| 已分类 | DoR 通过 | `agent:ready` | pm | `01` §3 的 8 条全过 |
| 已分类 | 信息不足 | `status/needs-info` | pm | 澄清问题已评论，≤5 条 |
| `agent:ready` | deliver 启动 | `status/in-progress` + `agent:running`（移除 `agent:ready`） | implementer / orchestrator | worktree 创建成功 |
| `status/in-progress` | PR 创建并推送 | `status/in-review` + `agent:review`（移除 `agent:running`） | implementer / orchestrator | PR 存在且非草稿 |
| `status/in-review` | G4 PASS 且 G5 APPROVE | 保持 `status/in-review` + `agent:review` | verifier / reviewer | 见 `04` §2、`05` §2 |
| `status/in-review` | verifier FAIL 或 reviewer request-changes | `status/in-progress`（移除 `agent:review`） | verifier / reviewer | 失败证据已评论 |
| `status/in-review` | G6 合并 | CLOSED | release-manager | PR `MERGED`，`Closes` 自动关闭 |
| 任意进行中 | 重试耗尽 / 等决策 / 越权 | `status/blocked` + `agent:blocked` | implementer / orchestrator | 2 次自动重试后仍失败；并 @owner |
| CLOSED | 发布完成 | `status/done` | release-manager | `gh release view <tag>` 成功 |
| `status/done` | 用户验收通过 | `status/accepted` | scribe | 用户评论含「验收通过」 |
| `status/done` | 用户验收不通过 | `status/needs-info` | scribe | 用户评论含「验收不通过」 |

机器标签契约（真源 `.github/labels.yml`；下表只定义语义与写入责任，R4 `orchestrator` 只消费/写入其中标注的行）：

| label | 语义 | 写入者 | 消费方 |
|---|---|---|---|
| `agent:ready` | 唯一派发信号：DoR 通过、可被取走 | pm（人） | orchestrator `watch` |
| `agent:running` | 已被取走、执行中（orchestrator 持锁，避免重复派发） | implementer / orchestrator | orchestrator |
| `agent:review` | 等待独立 verifier / reviewer（新上下文） | implementer / orchestrator | verifier / reviewer |
| `agent:blocked` | 连续失败或越权，已停下并 @owner | implementer / orchestrator | orchestrator（跳过） |
| `status/needs-triage` | 未分类（issue 表单默认） | 模板 | product-owner |
| `status/needs-info` | 等用户决策（升级） | pm / scribe | 人 |
| `status/in-progress` | 实现/返工中 | implementer / verifier / reviewer | 人 |
| `status/in-review` | 等待验证/评审/合并 | implementer / orchestrator | verifier / reviewer |
| `status/blocked` | 阻塞（凭据/外部依赖/等决策） | verifier / reviewer / orchestrator | 人 |
| `status/done` | 已合并并发布 | release-manager | 人 |
| `status/accepted` | 用户验收通过 | scribe | 人 |

> 注：早期任务契约曾用「冒号」命名（`status` 与短横线之间用冒号连接）；落库标签一律以 `.github/labels.yml` 的斜杠命名（如 `status/in-review`）为准，orchestrator 必须读 `labels.yml`，不得硬编码另一套命名。

## 5. 用户只做 3 件事（A10 的操作面）

**默认入口是对话式**（`11-CONVERSATION-MODE.md`）：业务方只在 DSH 对话里说自然语言，
建 issue、看 PR、合并、发版全部由 DSH 代办；业务方**不需要打开 GitHub**。
开发者/贡献者可选 issue 式（下表），两种模式共用同一后台 G0–G7。

### 5.0 两种入口

| 模式 | 适用人 | 入口 | 详述 |
|---|---|---|---|
| **A 对话式（默认）** | 业务方、不懂开发的决策者 | 直接对 DSH 说需求；拍板与验收也在对话里 | `11-CONVERSATION-MODE.md` |
| **B issue 式** | 开发者、贡献者、社区 | GitHub issue 表单 + `agent:ready` | 本节下表 + `01-REQUIREMENT-INTAKE.md` |

### 5.1 issue 式（开发者模式，可选）

| # | 用户做什么 | 怎么做 | 用户不做什么 |
|---|---|---|---|
| 1 | **写 issue** | GitHub → New issue →「业务需求」表单（`.github/ISSUE_TEMPLATE/requirement.yml`），按 `01-REQUIREMENT-INTAKE.md` §2 填 8 个字段；写完打 `agent:ready` 也可以交给 pm 打 | 不写代码、不写 prompt、不建分支、不选实现方案 |
| 2 | **在升级点决策** | 收到 issue 评论 @你 的升级单（`09-ESCALATION.md` 模板），回复 `A`/`B`/`C` 或「暂停」 | 不参与日常技术决策；不逐条 review 代码 |
| 3 | **验收交付** | 读 issue 里的交付报告，跑 §「如何验收」的命令，回复「验收通过」或「验收不通过：<原因>」 | 不合并 PR、不发版、不改 CHANGELOG |

超过 24h 未回复升级单时的默认行为见 `09-ESCALATION.md` §4（只在可逆且低风险时启用默认项）。

## 6. agent 与人的权限边界

| 动作 | agent（角色） | orchestrator | 人（owner） |
|---|---|---|---|
| 读仓库/issue/PR | 允许 | 允许 | 允许 |
| 在 worktree 内写文件 | 允许（限 issue 声明的写域） | 允许（仅 worktree） | 允许 |
| 直接 push `main` | **禁止** | **禁止** | 禁止（例外须 Lead 记录） |
| push `agent/*`、`fix/*`、`docs/*` 分支 | 允许 | 允许 | 允许 |
| 开 PR / 评论 / 打 `status/*`、`agent:*` | 允许 | 允许 | 允许 |
| 合并 PR | **禁止**（implementer/verifier/reviewer）；仅 release-manager 允许且须 checks 全绿 | **禁止**（R4 契约无 merge 子命令） | 允许 |
| 打 tag / 发 Release | 仅 release-manager 且 G6 已合并 | 禁止 | 允许 |
| 修改 `.github/**`、`agents/**`、`docs/process/**` | **禁止自行合并**（见下） | 禁止 | 允许 |
| 改仓库可见性 / 建仓 / 权限 | 禁止 | 禁止 | 允许 |
| 读取/打印凭据 | 禁止 | 禁止（env 白名单） | 允许但不入库 |
| 降低门禁强度 | 禁止（升级 E-06） | 禁止 | 允许 |

**自我修改保护**：`.github/**`（CI/模板/labels/CODEOWNERS）、`agents/**`（角色 prompt）、`docs/process/**`（本手册）三个目录是"规则本身"。对它们的 PR 必须由**人**在 G5 追加批准（`needs-human-review` 标签 + 用户评论「批准」），否则 release-manager 不得合并。原因：agent 改自己的规则等于绕过门禁。

## 7. 文件与命令地图

| 需要什么 | 去哪 |
|---|---|
| 需求怎么写 | `01-REQUIREMENT-INTAKE.md` §2 |
| DoR 判据 | `01-REQUIREMENT-INTAKE.md` §3 |
| RFC 何时必须、模板 | `02-DESIGN-RFC.md` §2、§4 |
| RFC/ADR 目录与命名 | `docs/rfc/README.md`、`docs/adr/README.md` |
| 分支/commit/worktree | `03-IMPLEMENTATION.md` §2、§3 |
| 门禁命令与证据格式 | `04-VERIFICATION.md` §1、§2 |
| 评审检查单/合并规则 | `05-REVIEW-MERGE.md` §2、§3 |
| SemVer/发版/回滚 | `06-RELEASE.md` §2、§5 |
| 交付报告模板 | `07-DELIVERY-REPORT.md` §2 |
| 度量与采集命令 | `08-METRICS.md` §2 |
| 什么必须问人 | `09-ESCALATION.md` §2 |
| orchestrator/runner/审计 | `10-DSH-LOCAL-AGENTS.md` §2–§6 |
| 角色 prompt | `agents/roles/<role>.md`，索引 `agents/README.md` |
| 流程自检 | `node agents/verify-agents.mjs`（exit 0 才算流程资产完整） |

## 8. 与 orchestrator CLI 的映射

契约命令名固定为 `intake | deliver | verify | watch | status`（由 R4 实现，本手册只定义何时调用）：

| CLI | 对应 Gate | 谁调用 | 失败语义 |
|---|---|---|---|
| `node orchestrator/cli.mjs intake --issue <n>` | G1 | pm（或 watch 前置） | 缺字段 → 输出缺失清单，issue 打 `status/needs-info` |
| `node orchestrator/cli.mjs deliver --issue <n>` | G3 | orchestrator/watch、implementer | 门禁失败 → 重试 ≤2 → `status/blocked` |
| `node orchestrator/cli.mjs verify --pr <n>` | G4/G5 | verifier/reviewer 通过 runner 加载角色 | 证据写 `.agentspec/runs/<iso>/`，非 0 即 FAIL |
| `node orchestrator/cli.mjs watch [--once] [--max <n>]` | G1→G3 调度 | 人（常驻） | 单 issue 失败不终止 watch |
| `node orchestrator/cli.mjs status [--json]` | 全局 | 任何人（只读） | 网络不可用 → `--offline` 读缓存并打印 SKIP |

## 9. 失败与恢复

- 任一 gate FAIL：不在原地硬修，先写清失败证据到 issue 评论，再回退到上一 gate（G4/G5 → G3；G6 → G5；G7 → G6）重走，禁止跳门。
- 重试预算：同一 issue 自动重试 ≤2 次；同一条命令同一原因连续 3 次失败 → `status/blocked` + 升级。
- 中断恢复：所有上下文外置在 issue + `.agentspec/runs/<iso>/`；新 agent 只读这些即可续跑，禁止依赖聊天记忆。
- 回滚：代码回滚走 revert PR（见 `06-RELEASE.md` §5）；流程回滚 = 还原被改的 `.github/**`/`agents/**` 并重跑 `node agents/verify-agents.mjs`。

## 10. 不变量的机械检查

| 不变量 | 检查命令 | 期望 |
|---|---|---|
| 流程资产完整（8 角色六段、11 文档、G0–G7 全出现） | `node agents/verify-agents.mjs` | exit 0 |
| 门禁命令存在且可执行 | `node tools/validate-abi.mjs && node tools/sync-schema.mjs --check` | exit 0 |
| 文档/模板一致 | `python3 tools/check_docs.py all` | exit 0 |
| 无内部台账/个人路径泄漏 | `node tools/leak-scan.mjs` | exit 0 |
| GitHub 工程配置自洽 | `node .github/scripts/verify-github-config.mjs` | exit 0 |
| 本地引擎测试 | `node --test orchestrator/test/` | exit 0 |
