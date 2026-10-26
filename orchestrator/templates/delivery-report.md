# 交付报告 — issue #{{issueNumber}} {{issueTitle}}

> 自动生成 by mocl-agent · run `{{runId}}` · {{generatedAt}}

## 交付摘要

{{summary}}

## 关联

- issue：{{issueLink}}
- PR：{{prUrl}}
- 分支：`{{branch}}` → `{{base}}`
- worktree：`{{worktree}}`
- 改动文件：{{changedFiles}}

## 证据

{{evidenceTable}}

## 风险与回滚

- 风险：{{risks}}
- 回滚：
{{rollback}}

## 运行信息

| 项 | 值 |
| --- | --- |
| runner | {{agentRunner}} |
| 角色 prompt | {{rolePromptSource}} |
| issue 来源 | {{issueSource}} |
| 运行目录 | `{{runDir}}` |
| 耗时 | {{duration}} |
| 证据日志 | `{{eventsPath}}` |

---

<sub>由 mocl-agent 自动生成；证据可用 `node orchestrator/cli.mjs verify --pr {{prNumber}} --repo {{repo}}` 复跑。</sub>

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
