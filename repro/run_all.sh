#!/usr/bin/env bash
# 复跑全部后端探测脚本（幂等、只读、无额度优先）。
# 用法: bash repro/run_all.sh [--with-quota]
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
for s in repro/probe-*.sh; do
  [ -f "$s" ] || continue
  echo "=================== $s ==================="
  if bash "$s"; then
    echo "--- PASS $s"
  else
    echo "--- FAIL $s (exit=$?)"
    fail=1
  fi
done
echo "=================== summary ==================="
[ "$fail" -eq 0 ] && echo "ALL PROBES PASS" || echo "SOME PROBES FAILED"
exit "$fail"
