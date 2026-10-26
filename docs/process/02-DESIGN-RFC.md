# 02 — 设计与 RFC/ADR（G2）

> 目标：在动代码之前，把「不可逆 / 跨模块 / 改契约」的决定写成可评审的文档，避免实现完才发现方向错。
> 上游：`01-REQUIREMENT-INTAKE.md`；下游：`03-IMPLEMENTATION.md`。
> 既有架构语义以 `docs/architecture/00-overview.md`、`docs/architecture/01-layers.md`、`docs/abi/abi-v0.md` 为准；本文件不重复，只定义**何时必须写、写在哪、谁批**。

## 1. G2 的两种形态

| 形态 | 何时 | 产物 | 评审强度 |
|---|---|---|---|
| **免 RFC**（设计说明） | 未命中 §3 任一触发条件 | issue 评论 `## 设计说明`（≥5 行：方案、影响文件、测试点、回滚） | architect 自查 + G5 reviewer 复核 |
| **RFC** | 命中 §3 任一触发条件 | `docs/rfc/NNNN-<slug>.md` 的 PR | RFC PR 由 reviewer（新上下文）批准后合并，issue 链接 RFC 编号 |
| **ADR** | RFC 通过后需固化为长期决策 | `docs/adr/NNNN-<slug>.md`（同一 PR 或紧随其后的 PR） | 随 RFC 一起评审 |

编号规则：`NNNN` = `docs/rfc/` 或 `docs/adr/` 下现有最大编号 +1，四位零填充（`0001`）。文件名 kebab-case，只含小写字母/数字/连字符。目录说明、模板骨架与索引表的维护方式见 `docs/rfc/README.md`、`docs/adr/README.md`（新增时同 PR 更新索引）。

## 2. 何时必须 RFC（触发条件，任一命中即必须）

| # | 触发条件 | 判定方式 | 理由 |
|---|---|---|---|
| T-1 | 改 ABI：方法、事件、错误码、能力位、`docs/abi/schema/*.json` | `git diff --name-only main...HEAD` 命中 `docs/abi/**` 或 `schema/**` | ABI 是唯一命名真源，改动波及 4 个适配器 |
| T-2 | 新增/修改公开配置键（`config.default.json`、`config.example.json`） | diff 命中 `config.*.json` 且 `node tools/sync-schema.mjs --check` 受影响 | 配置是外部用户契约 |
| T-3 | 新增第三方运行时依赖 | diff 命中 `package.json` 的 `dependencies` | 供应链/许可证/体积 |
| T-4 | 修改门禁或发布流程：`.github/**`、`agents/roles/**`、`docs/process/**` | diff 命中这些目录 | 「规则本身」的修改，需人批准（`00` §6） |
| T-5 | 修改安全默认：权限档、worktree 隔离、凭据处理 | diff 命中 `src/**/policy*`、`docs/integration/01-config-and-enable.md` | 安全默认不得反向放宽 |
| T-6 | 跨 ≥2 个顶层模块，或 diff > 400 行（不含测试/文档） | `git diff --stat main...HEAD` | 影响面大，需设计先行 |
| T-7 | 不可逆 / 数据迁移 / 兼容性破坏（含删字段、改语义、删导出） | 人工判断 + diff 命中公共导出 | 回滚成本高 |
| T-8 | 数量级影响：性能 10×、成本翻倍、并发语义变化 | 人工判断 | 需基准与成本核算 |

未命中任何触发条件时，architect 在 issue 写设计说明；**禁止**为了省事把大改拆小绕过 RFC（reviewer 在 G5 检查 diff 规模与触发条件）。

## 3. RFC 模板（`docs/rfc/NNNN-<slug>.md`）

```markdown
# RFC NNNN — <标题>

- 状态：Draft | In Review | Accepted | Rejected | Superseded
- 作者：<role>/<agent id>　评审：<reviewer>
- 关联 issue：#<n>　关联 ADR：<docs/adr/NNNN-...>（可空）
- 日期：YYYY-MM-DD　目标版本：0.x.y

## 1. 问题与背景
<业务场景、现状、为什么现在做；引用 issue 与既有文档章节>

## 2. 目标与非目标
- 目标：<可测>
- 非目标：<明确不做>

## 3. 方案
<选定方案；接口/数据结构/命令形式；与 ABI/配置/门禁的接触点>

## 4. 备选方案与取舍
| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|

## 5. 影响面
| 区域 | 影响 | 需要改的文件 |
|---|---|---|
| ABI/schema | | |
| 配置 | | |
| 测试/门禁 | | |
| 文档 | | |

## 6. 兼容性与迁移
<破坏性？如何迁移？回滚路径？>

## 7. 安全与权限
<凭据/路径/越权/注入风险；默认档位是否变化>

## 8. 验证计划
| 验收项 | 命令 | 期望 |
|---|---|---|

## 9. 未决问题
- [ ] <问题> —— 需要谁决策
```

## 4. ADR 模板（`docs/adr/NNNN-<slug>.md`）

ADR 只记录**已做出的决定**，不重复论证过程（论证留在 RFC）。

```markdown
# ADR NNNN — <决定一句话>

- 状态：Accepted | Superseded by ADR-MMMM
- 日期：YYYY-MM-DD　来源 RFC：<docs/rfc/NNNN-...>
- 决策者：<role>（批准人：<owner>）

## 背景
<2–5 行，为什么需要这个决定>

## 决定
<一句话，动词开头：采用/禁止/固定/迁移>

## 后果
- 正面：<…>
- 负面：<…>
- 约束：<对后续实现/门禁的硬约束>
```

## 5. 设计评审门禁（G2 出口）

| # | 检查项 | 判定 | 证据 |
|---|---|---|---|
| D-1 | RFC 存在性符合触发判定 | 命中 T-1..T-8 之一 → 必须有 RFC 链接；否则免 RFC 说明存在 | issue 评论 / `docs/rfc/` |
| D-2 | 影响面表覆盖所有实际改动目录 | 对照 `git diff --stat`，表内「需要改的文件」≥ 实际改动的前 80% | RFC §5 |
| D-3 | 兼容性与回滚写明 | §6 非空且给出具体回滚动作（revert PR/tag） | RFC §6 |
| D-4 | 安全默认未被放宽 | §7 明确「默认档位不变」或走升级 E-05 | RFC §7 |
| D-5 | 验证计划可执行 | §8 每条命令能在仓库内直接跑 | RFC §8 |
| D-6 | RFC 本身通过 `python3 tools/check_docs.py all` 与 `node tools/leak-scan.mjs` | 命令 exit 0 | RFC PR 的 CI |
| D-7 | 无个人路径/内部台账引用 | `node tools/leak-scan.mjs` exit 0 | CI |

RFC 合并后 issue 追加评论：

```bash
gh issue comment <n> --body "RFC 0007 已合并（<commit sha>），设计评审门禁 D-1..D-7 通过，进入 G3 实现。"
```

## 6. 角色分工

- **architect**：写 RFC/ADR、维护 `docs/architecture/` 与 `docs/abi/` 的一致性、判定是否命中触发条件。
- **reviewer**：只评审「设计是否可实施、影响面是否漏项、回滚是否成立」，不替 architect 重写方案。
- **implementer**：实现必须与 RFC 一致；发现 RFC 不可行 → 停手，回 G2 修订，禁止边写边改契约。
- **pm**：确保 issue 与 RFC 双向链接（issue 评论 + RFC front-matter），未链接不得进 G3。

## 7. 反例

| 反例 | 为什么错 | 正确做法 |
|---|---|---|
| 先写代码，合并前补 RFC | 设计评审失去约束力 | 命中触发条件先出 RFC |
| RFC 只有方案没有备选 | 无法判断取舍 | §4 至少 2 个备选 + 结论 |
| RFC 写「视情况而定」 | 不可判定 | 给默认值与切换条件 |
| 把 RFC 放进 issue 评论代替文件 | 不可版本化、不可引用 | 落 `docs/rfc/NNNN-*.md` |
| RFC 里贴个人路径/内部台账 | 违反 A6 | 用 `~/…` 或 `<path>` |
