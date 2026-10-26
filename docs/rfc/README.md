# docs/rfc — 设计提案（Request for Comments）

> 用途：存放**需要评审的设计决定**。何时必须写 RFC、评审门禁 D-1..D-7、与 ADR 的关系，见 `docs/process/02-DESIGN-RFC.md`。
> 本目录只放 RFC 正文与索引；不放开会记录（ADR 在 `docs/adr/`），不放实现代码。

## 1. 命名与编号

| 项 | 规则 |
|---|---|
| 文件名 | `NNNN-<slug>.md`（四位零填充编号 + kebab-case slug，仅小写字母/数字/连字符） |
| 编号 | 现有最大编号 + 1；不复用、不回填；被废弃的 RFC 保留原编号并标 `Superseded` |
| 示例 | `0001-abstraction-for-adapter-handshake.md` |
| 索引 | 新增 RFC 时同步更新本文件 §3 索引表（一个 PR 内完成） |

## 2. 模板骨架（复制后填写）

```markdown
# RFC NNNN — <标题>

- 状态：Draft | In Review | Accepted | Rejected | Superseded
- 作者：<role>/<agent id>
- 评审：reviewer（新上下文）　评审记录：<PR 链接 / 评论链接>
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

## 3. 索引

| 编号 | 标题 | 状态 | 关联 issue | 合并 PR |
|---|---|---|---|---|
| — | 暂无 | — | — | — |

> 约束：RFC 必须能在仓库内自洽引用（`docs/abi/abi-v0.md` 是 ABI 唯一命名真源）；不得写入个人绝对路径、凭据、内部台账路径。合并前必须通过 `python3 tools/check_docs.py all` 与 `node tools/leak-scan.mjs`（命令归属见 `docs/process/04-VERIFICATION.md` §2）。
