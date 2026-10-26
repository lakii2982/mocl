# 01 — 需求受理（G0）与澄清（G1）

> 目标：让「业务场景」在 30 分钟内变成一条**机器可派发**的 issue。用户只写业务语言；product-owner / pm 负责把它翻译成可验证契约。
> 上游：`00-OPERATING-MODEL.md` §2；下游：`02-DESIGN-RFC.md`。
> 唯一模板：`.github/ISSUE_TEMPLATE/requirement.yml`（R2 交付）。本文件定义**字段语义与判定口径**，模板字段名以该 YAML 为准。

## 1. 两个门禁的分工

| Gate | 角色 | 输入 | 输出 | 判定 |
|---|---|---|---|---|
| G0 需求受理 | product-owner | 用户提交的 issue | 打标后的 issue（`type/*`/`priority/*`/`area/*`） | 模板必填项非空 + 已分类 |
| G1 澄清与 DoR | pm | G0 产物 | issue 正文的「验收口径」+ `.agentspec/issues/<n>/BRIEF.md` + `agent:ready` | DoR 8 条全过 |

G0 只做**分类与完整性**，不改需求语义；需求语义的澄清在 G1。

## 2. 需求 issue 的 8 个字段

### 2.0 对话录入（默认，业务方）

业务方**不需要填表**（对话式见 `11-CONVERSATION-MODE.md`）：直接说需求，DSH 用最多 3 个选择题
补齐下面 8 个字段，写成后台 issue。字段 1–6 以业务方口述为准；7–8 由 DSH 按默认值（`risk=low`、
无凭据）起草并请业务方确认一次。**不得替业务方扩大范围。**


| # | 字段 | 必填 | 写法要求 | 反例（会被退回） |
|---|---|---|---|---|
| 1 | 业务场景 | 是 | ≤2 句，含「谁 / 在什么场景 / 要解决什么」 | "优化一下系统" |
| 2 | 目标用户与使用方式 | 是 | 谁用、怎么触发（命令/接口/文档） | "所有人" |
| 3 | 期望结果 | 是 | 可观测的结果，不是实现手段 | "用 Redis 做缓存" |
| 4 | 成功标准 | 是 | ≥1 条可测量结果（数量/时间/错误率/文件存在） | "更快" |
| 5 | 验收口径 | 是 | ≥3 条 Given/When/Then，每条附命令或可复现步骤（模板见 §4） | "跑一下看看" |
| 6 | 非目标 | 是 | ≥1 条明确不做什么 | 留空 |
| 7 | 优先级与风险 | 是 | 表单优先级（映射 `priority/p0|p1|p2`）+ 表单「风险与权限」字段（风险等级 low/med/high + perm 声明）+ 触及模块初判 | 全部 p0 |
| 8 | 权限与数据声明 | 是 | 是否涉及凭据、生产数据、删除/迁移、对外发布；默认声明「无」 | 留空 |

字段 1–6 是业务语言，由用户提供；7–8 允许 product-owner 按模板追问补齐，但**不得替用户扩大范围**。

### 2.1 优先级口径（必须可判）

| label | 含义 | 响应时限 | 例子 |
|---|---|---|---|
| `priority/p0` | 阻塞发布/安全/数据损坏 | 当天进入 G1 | 泄漏个人路径；门禁失效 |
| `priority/p1` | 本迭代必须交付的业务需求 | 2 个工作日内进 G1 | 新增一个适配器文档章节 |
| `priority/p2` | 可延后的改进 | 排入 backlog，不承诺时限 | 文档措辞优化 |

### 2.2 风险与权限声明（决定走哪条门禁）

写在 issue 表单的 `risk-and-permission` 字段里，**不单独打 label**；需要机器可判时在 issue 评论追加 `risk=high perm=worktree-write`。

| 声明值 | 含义 | 流程影响 |
|---|---|---|
| `risk=low` | 只改文档/测试/注释，无行为变化 | G2 可免 RFC |
| `risk=med` | 改实现但接口不变 | G2 需设计说明评论；G4 全门禁 |
| `risk=high` | 改 ABI/配置键/依赖/安全默认/CI | **必须 RFC**（`02` §3） |
| `perm=read-only` | 只需读仓库 | runner 用只读档 |
| `perm=worktree-write` | 在 worktree 内写 | 默认档；必须 worktree 隔离 |
| `perm=repo-write` | push 分支/开 PR/打 label | 需 `gh` 凭据；仍禁止合并与发版 |
| `perm=release` | 打 tag/发 Release | 仅 release-manager，且 G6 已合并 |

## 3. DoR（Definition of Ready）— 8 条硬判据

`pm` 必须逐条勾选；任一条不满足则不得打 `agent:ready`。

| # | 判据 | 机器/人工判定 | 证据位置 |
|---|---|---|---|
| DoR-1 | 业务场景 ≤2 句且含「谁/场景/问题」 | 人工（product-owner 复核） | issue 字段 1 |
| DoR-2 | 目标用户与触发方式明确 | 人工 | issue 字段 2 |
| DoR-3 | 成功标准 ≥1 条且可测量 | 人工 | issue 字段 4 |
| DoR-4 | 验收口径 ≥3 条，每条含命令或可复现步骤 | 人工 + 抽查 1 条能跑 | issue 字段 5 |
| DoR-5 | 非目标 ≥1 条 | 人工 | issue 字段 6 |
| DoR-6 | 优先级/风险/权限已声明 | 自动：labels 含 `type/*`、`priority/*`；风险/权限来自表单 `risk-and-permission` 字段（非独立 label） | issue labels + 表单字段 |
| DoR-7 | 写域已初判（允许粗粒度：目录级） | 人工；写入 issue 评论 `## 写域` | issue 评论 |
| DoR-8 | 无未决问题，或未决项已由用户决策并记录 | 人工；未决项必须写「决策：… / 日期」 | issue 评论 |

**DoR 自检命令**（pm 在打标前跑，输出贴评论）：

```bash
gh issue view <n> --json title,body,labels,comments \
  --jq '{title, labels: [.labels[].name], has_body: (.body|length>0)}'
```

退出码 0 且 label 至少含 `type/*`、`priority/*` 各一个、表单「风险与权限」字段非空，方可进 G1 出口。

## 4. 验收口径模板（必须可机械执行）

每条验收项写成三段，禁止只写期望：

````markdown
### AC-<k>：<一句话结论>
- Given：<前置状态，含数据/版本>
- When：<执行的命令或操作>
- Then：<可观测结果，含退出码或字段断言>

命令：
```bash
<可直接复制执行的一条命令>
```
期望：
- 退出码 = 0
- stdout 包含 `<关键字符串>`
````

示例（合格）：

```markdown
### AC-1：validate-abi 保持 46/34/35/18
- Given：当前 main 的 commit <sha>
- When：`node tools/validate-abi.mjs`
- Then：退出码 0，且 stdout 含 `ALL CHECKS PASSED (46/34/35/18)`
```

反例（不合格）：「接口正常」「性能提升」「文档更清晰」——不可判定，退回重写。

## 5. 澄清流程（G1）

1. `intake` 生成需求摘要：`node orchestrator/cli.mjs intake --issue <n>` → `.agentspec/issues/<n>/BRIEF.md`。
2. pm 对照 DoR 找缺口，**最多提 5 个问题**，每个问题给出默认答案（用户只回「默认」即可）。
3. 澄清评论模板：

```markdown
## 澄清（G1）· 共 <k> 个问题
1. <问题> ？默认：<可接受的默认答案>
...
> 回复「默认」表示全部采用默认；24h 未回复按 `09-ESCALATION.md` §4 处理。
```

4. 用户回复后，pm 把结论回写 issue 正文（编辑「验收口径」段），并在评论写 `DoR: 8/8`。
5. 打标并派发：

```bash
gh issue edit <n> --add-label "agent:ready"
gh issue comment <n> --body "DoR 8/8 通过，进入 G2/G3。写域：<目录列表>。验收口径见正文 §AC。"
```

标注 `intake` 的产物（`.agentspec/issues/<n>/BRIEF.md`）必须含：需求摘要、验收口径、风险、非目标、待澄清问题（解决后写「已解决」）。

## 6. 标签与状态流转（G0/G1 范围）

| 时点 | 动作 | 命令 |
|---|---|---|
| issue 创建 | 自动带模板 labels（`type/*` 之一） | 模板 `.github/ISSUE_TEMPLATE/requirement.yml` |
| G0 分类 | 补 `priority/*`、`area/*` | `gh issue edit <n> --add-label "priority/p1" --add-label "area/docs"` |
| 信息不足 | 打 `status/needs-info` 并 @owner | `gh issue edit <n> --add-label "status/needs-info"` |
| DoR 通过 | 打 `agent:ready` | `gh issue edit <n> --add-label "agent:ready"` |
| 澄清完成 | 移除 `status/needs-info` | `gh issue edit <n> --remove-label "status/needs-info"` |

标签真源：`.github/labels.yml`；状态机全集见 `00-OPERATING-MODEL.md` §4。

## 7. 受理反例（必须退回，不得打 `agent:ready`）

| 反例 | 退回理由 | 退回动作 |
|---|---|---|
| "把项目做得更专业" | 无验收口径、无范围 | 要求按模板补 8 字段 |
| "修复所有 bug" | 不可枚举、不可验收 | 拆成单条 issue，每条一个可复现缺陷 |
| "用 Rust 重写" | 指定实现手段且无业务理由 | 要求写业务场景与成功标准；命中 RFC 触发条件则走 `02` |
| 描述含凭据/个人绝对路径 | 泄漏风险（A6） | 要求脱敏后重提；已有评论编辑清除 |
| 涉及删除生产数据/改仓库可见性 | 不可逆 | 直接升级（`09` E-01/E-03），agent 不得受理 |

## 8. G1 出口检查（pm 自检）

```bash
# 1) label 齐全（type/* 与 priority/* 各至少 1 个；标签真源 .github/labels.yml）
gh issue view <n> --json labels --jq '[.labels[].name] | map(select(startswith("type/") or startswith("priority/")))'
# 2) 正文含验收口径段落与风险/权限字段
gh issue view <n> --json body --jq '.body' | grep -q '验收口径'
gh issue view <n> --json body --jq '.body' | grep -q '风险'
# 3) 需求 BRIEF 已生成
test -f .agentspec/issues/<n>/BRIEF.md && echo BRIEF-OK
```

三条都成功（退出码 0）才允许打 `agent:ready`；否则回 G0 补字段。
