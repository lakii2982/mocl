#!/usr/bin/env bash
# W2：构建并热安装 MOCL 面板插件（幂等；失败回滚到备份）。
#
# 契约（.agentspec/issues/18/W2.md §3）：
#   node tools/build-plugin-package.mjs
#   dsh plugin --profile desktop remove @mocl/dsh-plugin   # 未安装则忽略（幂等）
#   dsh plugin --profile desktop add file:$PWD/dist/plugin-package
#
# 插件热替换即重新加载 host+client 半，无需重启 DSH（先例 D-UI-006）。
# 注意：本脚本只负责构建与安装；需要 Lead 先 `pnpm -s install`（esbuild 是 devDependency）。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/dist/plugin-package"
backup="$root/dist/.plugin-package.backup"
profile="desktop"
plugin="@mocl/dsh-plugin"

restore_backup() {
  if [ -d "$backup" ]; then
    rm -rf "$pkg"
    cp -R "$backup" "$pkg"
    echo "[install-panel] 已把 dist/plugin-package 恢复到安装前备份" >&2
  fi
}

echo "[install-panel] 1/3 备份现有产物 → $backup"
if [ -d "$pkg" ]; then
  rm -rf "$backup"
  mkdir -p "$(dirname "$backup")"
  cp -R "$pkg" "$backup"
fi

echo "[install-panel] 2/3 构建（tsc + esbuild client 半）"
if ! node "$root/tools/build-plugin-package.mjs"; then
  echo "[install-panel] 构建失败" >&2
  restore_backup
  exit 1
fi

echo "[install-panel] 3/3 dsh plugin remove（未安装则忽略）+ add file:$pkg"
dsh plugin --profile "$profile" remove "$plugin" || true
if ! dsh plugin --profile "$profile" add "file:$pkg"; then
  echo "[install-panel] 安装失败，回滚到备份并恢复宿主里的上一版" >&2
  dsh plugin --profile "$profile" remove "$plugin" || true
  restore_backup
  if [ -d "$backup" ]; then
    dsh plugin --profile "$profile" add "file:$pkg" || true
  fi
  exit 1
fi

echo "[install-panel] 完成：$plugin 已安装（打开 DSH 右侧栏「外部代理」tab 验收；" \
  "心跳落盘见 <journal.dir>/panel-heartbeat.json）"
