<!--
  MOCL PR 模板（G3 创建 PR 时使用，G4 验证 / G5 评审 / G6 合并的证据位）
  说明：
  - 本模板由 .github/workflows/process-guard.yml 机械校验，不合格 PR 会红。
  - 校验器：node .github/scripts/check-pr.mjs --body-file <file> --title "<title>"
  - 规则来源：docs/process/04-VERIFICATION.md（证据协议）、05-REVIEW-MERGE.md（评审与合并）。
  - 「证据表」必须真跑后填写；verifier 会用新上下文独立复跑同一命令，不采信作者结论。
  - 小节命名与 docs/process/、orchestrator/templates/pr-body.md 保持一致：
    关联 issue / 交付内容（或变更摘要）/ 门禁（G0–G7）/ 证据表 / 风险与回滚 / 文档更新 / 检查清单。
-->

## 关联 issue

<!-- 必须写 Closes #N / Refs #N；没有关联 issue 的 PR 一律不合并（流程要求）。 -->

Closes #

## 变更摘要

<!-- 1–3 条：做了什么、为什么、影响哪些用户可见行为。不写「优化代码」这类空话。 -->

-

## 门禁（G0–G7）

> G0–G3 在 issue 侧留证（需求/设计/实现范围）；本 PR 负责 **G4 验证 → G5 评审 → G6 合并**。
> 只填本 PR 实际经过的门禁，未经过写 `—` 并说明原因。

| 门禁 | 状态 | 证据（命令 / CI URL / 文件） |
|------|------|------------------------------|
| G4 验证（本地门禁 + 独立复跑） | 待填 | 见下方证据表 |
| G5 评审（reviewer 新上下文） | 待填 | PR review 记录 |
| G6 合并（required checks 全绿） | 待填 | CI run URL |

## 证据表

> 逐条真跑，粘退出码与关键输出。**禁止**「应该通过」「本地已测」。
> 含**非零退出码**或**未替换占位符**的 PR 会被 process-guard 拒绝；声明性 SKIP（如无凭据/无网络）写成
> `SKIP` 并另在「风险与回滚」说明原因，不得写成 0。
> 常用门禁：`pnpm -s typecheck` / `pnpm -s test` / `pnpm -s validate` / `node tools/sync-schema.mjs --check` /
> `node e2e/pr-scenario.mjs` / `pnpm -s build:plugin` / `node .github/scripts/verify-github-config.mjs` /
> `python3 tools/check_docs.py all`

| 命令 | 退出码 | 关键输出 |
|------|--------|----------|
| `<command>` | `<0>` | `<关键输出摘要>` |

## 风险与回滚

<!-- 风险：行为变化、兼容性、权限、数据；回滚：具体动作与验证方式（命令/开关/还原点）。 -->

- 风险：
- 回滚：

## 文档更新

<!-- 改了行为就必须改文档；确实无需改文档时写「无需更新」+ 一句原因。 -->

-

## 检查清单

<!-- 全部勾选后提交；除流程项（CI 绿/评审通过/打 status 标签）外不得留空。 -->

- [ ] PR 标题符合 Conventional Commits（如 `fix(ci): 修复 process-guard 误报`）
- [ ] 已关联 issue，且变更范围与 issue 的验收口径一致（无未申报的范围扩张）
- [ ] 证据表全部为真跑结果，无占位符、无「应该通过」；声明性 SKIP 已说明原因
- [ ] 涉及行为变化时已同步更新 docs/（或在「文档更新」说明无需更新的原因）
- [ ] 已自查无凭据、token、个人绝对路径（`/Users/...`）、内部台账内容
- [ ] 已自查无第三方依赖新增或版本升级（若必须新增，已在「风险与回滚」说明并获批准）
- [ ] 本 PR 的写域与 issue/任务约定一致，未改动他人写域文件
