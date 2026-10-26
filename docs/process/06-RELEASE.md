# 06 — 发布（G7）

> 目标：把已合并到 `main` 的改动变成可下载、可安装、可追溯的版本，并在发布后再次验证。
> 上游：`05-REVIEW-MERGE.md`；下游：`07-DELIVERY-REPORT.md`。
> 当前包状态：`mocl` 为 `private`，不发 npm（发布非目标见 `README.md` 的 Non-goals / Roadmap 与 `CHANGELOG.md` 的版本说明）；发布 = GitHub Release + tag + 可复现构建。

## 1. 发布单元与批次

| 项 | 规则 |
|---|---|
| 发布单元 | 一个 Release（`vX.Y.Z`）可包含多个已合并 PR |
| 批次触发 | 到达里程碑（如 `0.1.0` 首个开源版）/ p0 修复 / 用户要求 |
| 谁决定发版 | release-manager 提议，Lead 批准；涉及破坏性变更需用户决策（`09` E-02） |
| 发布分支 | 无长期发布分支；从 `main` 打 tag |

## 2. SemVer 规则（0.x 阶段）

| 位 | 递增条件 | 例子 |
|---|---|---|
| MAJOR | 破坏 ABI（方法/事件/错误码/能力位删除或语义变更） | `0.x` 阶段允许破坏，但必须在 CHANGELOG 标 `BREAKING` |
| MINOR | 新增向后兼容能力（新适配器、新工具、新门禁） | `0.1.0 → 0.2.0` |
| PATCH | 缺陷修复、文档、内部重构、无行为变化 | `0.1.0 → 0.1.1` |

版本号唯一写入点：`package.json` 的 `version`。`CHANGELOG.md` 与 tag 必须与之一致；由 `python3 tools/check_docs.py all` 与 `node .github/scripts/verify-github-config.mjs` 之外的人工断言保证（见 §6 检查单）。

预发布：`v0.2.0-rc.1`（只用于演练/试装，不作为最终交付版本）。

## 3. CHANGELOG 维护

格式遵循 Keep a Changelog + SemVer：

```markdown
# Changelog

## [Unreleased]
### Added
- …
### Changed
- …
### Fixed
- …

## [0.1.0] - 2026-10-26
### Added
- 首个开源版本：MOCL 兼容层 + 设计文档 + 四适配器契约
```

规则：
- 每个合并 PR 必须在 `[Unreleased]` 下加一行（`### Added/Changed/Fixed/Removed/Docs` 之一）；由 reviewer 在 G5 检查。
- 发布时把 `[Unreleased]` 内容整体降级为新版本段，并补日期与比较链接。
- 变更行必须指向 PR：`- 支持 kimi 续接（#42）`。
- 禁止在 CHANGELOG 写内部台账路径、个人路径、未验证能力。

## 4. 发布流程（可机械执行）

| # | 步骤 | 命令 | 判据 |
|---|---|---|---|
| 1 | 确认 `main` 绿 + 工作区干净 | `git status --short`（空）；`gh run list --branch main --limit 1 --json conclusion` | `success` |
| 2 | 升版本 + 更 CHANGELOG（PR） | 改 `package.json` `version`、`CHANGELOG.md`；`gh pr create --title "chore(release): vX.Y.Z"` | 版本 PR 经 G4/G5/G6 |
| 3 | 打 tag（annotated） | `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z` | `git tag -l vX.Y.Z` 有输出 |
| 4 | 触发 Release workflow | `.github/workflows/release.yml`（`on: push: tags: v*`）自动运行 | `gh run list --workflow release.yml --limit 1` |
| 5 | 校验 Release | `gh release view vX.Y.Z --json tagName,name,assets,url` | 存在、notes 含该版本段 |
| 6 | 发布后验证（干净环境） | 见 §5 | 全部 exit 0 |
| 7 | 交付报告 | 见 `07-DELIVERY-REPORT.md` | issue 评论已发 |
| 8 | 状态打标 | `gh issue edit <n> --add-label "status/done"` | label 存在 |

任一步 FAIL → 停，不继续下一步；已 push 的 tag 允许删除重打（仅在 Release 未对外宣告前），属可逆操作。

## 5. 发布后验证（Post-release verification）

在 `/tmp` 的干净目录执行（不得复用本仓库 `node_modules`）：

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/<owner>/mocl.git /tmp/mocl-release-check
cd /tmp/mocl-release-check
pnpm install --frozen-lockfile
pnpm -s typecheck
pnpm -s test -- --run
node tools/validate-abi.mjs
node tools/sync-schema.mjs --check
python3 tools/check_docs.py all
node tools/leak-scan.mjs
node agents/verify-agents.mjs
```

判据：全部 exit 0；`node tools/validate-abi.mjs` 输出含 `ALL CHECKS PASSED (46/34/35/18)`；`git status --short` 为空。结果贴到交付报告「发布后验证」段。

若 clean clone 失败：该版本不得宣称可用；按 §6 回滚。

## 6. 发布检查单（release-manager 逐项打勾）

- [ ] `main` 最新 CI `success`；保护分支规则未被临时放开。
- [ ] `package.json` 版本 = tag = CHANGELOG 段标题（去掉 `v`）。
- [ ] CHANGELOG `[Unreleased]` 已清空并归档到版本段。
- [ ] Release notes 由 `release.yml` 从 CHANGELOG 提取（不手写、不漏项）。
- [ ] `git tag -v` 或 `git cat-file -t vX.Y.Z` = `tag`（annotated）。
- [ ] 发布后验证 §5 全绿。
- [ ] 交付报告已发 issue 评论，含「如何安装」「如何验收」「已知限制」。
- [ ] `status/done` 已打；issue 已关闭（G6 的 `Closes` 或手动）。

## 7. 回滚

| 场景 | 动作 | 命令 | 限制 |
|---|---|---|---|
| 版本内容有缺陷 | 从 `main` revert 对应 squash 提交，发 PATCH | `git revert <merge-sha>` → PR → vX.Y.(Z+1) | 不删历史 tag |
| 发布元数据错误（版本号/notes） | 删除 Release 与 tag，重打 | `gh release delete vX.Y.Z --yes --cleanup-tag` → 重走 §4 步骤 3–5 | 仅当该版本未被用户验收/未公开引用 |
| 需要撤回下载物 | 删除 Release 资产并标注 | `gh release delete-asset vX.Y.Z <asset> --yes` | 记录原因到 CHANGELOG `### Removed` |
| 破坏性 ABI 回归 | 回滚 + 在 CHANGELOG 标 `BREAKING` + 用户决策 | 升级 E-02 | 需用户批准 |

回滚证据（命令 + 退出码 + 输出）必须进交付报告；回滚后重跑 §5 发布后验证。

## 8. 发布反例

| 反例 | 问题 | 正确做法 |
|---|---|---|
| 直接 `git push --tags` 不发 Release | 无下载页、无 notes | 走 release.yml |
| tag 打在非 `main` 提交 | 无法追溯 | tag 必须指向 `main` 上的合并提交 |
| CHANGELOG 事后批量补写 | 漏项 | 每 PR 更新 `[Unreleased]` |
| 发布后不 clean clone 验证 | 用户装不上 | §5 强制 |
| 无证据宣称"已发布" | 违反证据协议 | 贴 `gh release view` 输出 |
