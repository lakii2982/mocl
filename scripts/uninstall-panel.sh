#!/usr/bin/env bash
# W2：一键回滚面板插件 —— remove 当前版本，恢复上一次 install-panel.sh 留下的备份并重新 add。
# 若想彻底移除面板，运行：dsh plugin --profile desktop remove @mocl/dsh-plugin
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/dist/plugin-package"
backup="$root/dist/.plugin-package.backup"
profile="desktop"
plugin="@mocl/dsh-plugin"

if [ ! -d "$backup" ]; then
  echo "[uninstall-panel] 没有可用备份：$backup（先跑过 scripts/install-panel.sh 才有）" >&2
  exit 1
fi

echo "[uninstall-panel] remove $plugin（未安装则忽略）"
dsh plugin --profile "$profile" remove "$plugin" || true

echo "[uninstall-panel] 恢复备份 → dist/plugin-package"
rm -rf "$pkg"
cp -R "$backup" "$pkg"

echo "[uninstall-panel] 重新 add file:$pkg"
dsh plugin --profile "$profile" add "file:$pkg"

echo "[uninstall-panel] 完成：已回滚到上一版面板产物"
