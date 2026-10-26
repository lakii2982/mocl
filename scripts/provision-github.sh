#!/usr/bin/env bash
# provision-github.sh — 把本地仓库的 GitHub 侧配置收敛到「流程 OS」要求的基线。
#
# 幂等：可重复执行。所有写操作都显式列出，失败会打印原因而不是静默跳过。
#
# 用法：
#   bash scripts/provision-github.sh [owner/repo]
#   DRY_RUN=1 bash scripts/provision-github.sh        # 只打印将执行的命令
#
# 前置：gh 已登录且有 repo scope（gh auth status）。
#
# 覆盖：仓库元数据与合并策略、topics、labels、分支保护（required checks）、
#       漏洞告警、Actions 权限。不覆盖：仓库可见性（由发布人决定）、secrets。
set -euo pipefail

REPO="${1:-${REPO:-lakii2982/mocl}}"
DRY_RUN="${DRY_RUN:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %q ' "$@"; echo
  else
    "$@"
  fi
}

api() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] gh api %q ' "$@"; echo
  else
    gh api "$@"
  fi
}

echo "== MOCL GitHub provisioning: $REPO =="

echo "[1/7] 校验 gh 登录与仓库存在"
gh auth status >/dev/null
api "repos/$REPO" --jq '.full_name' >/dev/null

echo "[2/7] 仓库元数据与合并策略（squash-only / auto-merge / 删分支）"
api -X PATCH "repos/$REPO" \
  -f description="MOCL — Multi-agent Orchestration Compatibility Layer for DSH: orchestrate codex / claude-code / kimi / opencode as subagents" \
  -F has_wiki=false -F has_projects=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true >/dev/null

echo "[3/7] topics"
api -X PUT "repos/$REPO/topics" --input - >/dev/null <<'JSON'
{"names":["multi-agent","orchestration","dsh","deepseek-harness","codex","claude-code","opencode","kimi","ai-agents","abi"]}
JSON

echo "[4/7] labels（来自 .github/labels.yml）"
if [[ -f "$ROOT/.github/scripts/sync-labels.mjs" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    node "$ROOT/.github/scripts/sync-labels.mjs" --dry-run --repo "$REPO"
  else
    node "$ROOT/.github/scripts/sync-labels.mjs" --apply --repo "$REPO"
  fi
else
  echo "  SKIP: .github/scripts/sync-labels.mjs 不存在"
fi

echo "[5/7] 分支保护 main（required checks 必须与 .github/workflows 的 job name 完全一致）"
PROTECTION='{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "build & contracts (node 24 / pnpm 11)",
      "e2e pr-scenario (offline)",
      "docs gate",
      "pr contract (process-guard)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}'
PROTECTION_WITH_GUARD="$PROTECTION"
if [[ "$DRY_RUN" == "1" ]]; then
  echo '[dry-run] gh api -X PUT '"repos/$REPO/branches/main/protection --input -" <<< "$PROTECTION_WITH_GUARD"
else
  if ! printf '%s' "$PROTECTION_WITH_GUARD" | gh api -X PUT "repos/$REPO/branches/main/protection" --input - >/dev/null 2>/tmp/mocl-protection.err; then
    echo "  WARN: 分支保护设置失败（私有仓在个人免费账号下可能不支持；转 public 后重跑本脚本）："
    sed 's/^/    /' /tmp/mocl-protection.err || true
  fi
fi

echo "[6/7] 依赖漏洞告警（Dependabot alerts）"
api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1 || echo "  WARN: vulnerability-alerts 设置失败（可能已启用或无权限）"

echo "[7/7] Actions 权限（默认只读 + 工作流内声明）"
api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=all >/dev/null

echo "== done =="
if [[ "$DRY_RUN" != "1" ]]; then
  gh repo view "$REPO" --json nameWithOwner,visibility,defaultBranchRef \
    --jq '"repo=\(.nameWithOwner) visibility=\(.visibility) default=\(.defaultBranchRef.name)"'
fi
