#!/usr/bin/env bash
# probe-claude.sh — claude-code 后端只读探测（幂等、不消耗模型额度、不写 ~/.claude）
#
# 产出：原始证据落在 ${MOCL_PROBE_OUT:-$TMPDIR/mocl-probe}/claude/ 下，并打印可引用摘要。
# 安全：只读 typings / --help / 二进制字符串 / 本地会话列表；不发起任何 LLM 请求，
#       不读取 auth 内容，不打印任何凭据。
#
# 用法: bash repro/probe-claude.sh        # 退出码 0 = 探测完成（缺失项标注 SKIP）
set -uo pipefail

OUT="${MOCL_PROBE_OUT:-${TMPDIR:-/tmp}/mocl-probe}/claude"
mkdir -p "$OUT"
CLAUDE_BIN="$(command -v claude || true)"
CC_ROOT="${HOME}/.nvm/versions/node/v24.18.1/lib/node_modules/@anthropic-ai/claude-code"
SDK_DIR="${HOME}/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk"
DSH_PLUGIN="${HOME}/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-claude-code"

say() { printf '%s\n' "$*"; }
hr()  { printf "%s\n" "============================================================"; }

say "== probe-claude  out=${OUT}"

# ---------------------------------------------------------------- 1. 版本与安装路径
hr; say "[1] 版本与安装路径"
if [ -n "$CLAUDE_BIN" ]; then
  say "claude path : ${CLAUDE_BIN} -> $(readlink -f "$CLAUDE_BIN" 2>/dev/null || echo '?')"
  say "claude ver  : $("$CLAUDE_BIN" --version 2>&1 | head -1)"
else
  say "SKIP claude CLI 未安装"
fi
if [ -f "${SDK_DIR}/package.json" ]; then
  say "agent-sdk   : ${SDK_DIR}"
  say "agent-sdk v : $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "${SDK_DIR}/package.json")"
  say "sdk.d.ts    : $(wc -l < "${SDK_DIR}/sdk.d.ts" | tr -d ' ') 行 ;  sdk-tools.d.ts: $(wc -l < "${SDK_DIR}/sdk-tools.d.ts" | tr -d ' ') 行"
else
  say "SKIP agent-sdk 不存在于 ${SDK_DIR}"
fi

# ---------------------------------------------------------------- 2. CLI 帮助（落盘 + 关键 flag 取证）
hr; say "[2] claude --help 关键 flag 取证"
if [ -n "$CLAUDE_BIN" ]; then
  "$CLAUDE_BIN" --help > "$OUT/help.txt" 2>&1 || true
  say "  help -> ${OUT}/help.txt ($(grep -c . "$OUT/help.txt") 行)"
  for flag in --agents --resume --continue --fork-session --include-partial-messages \
              --forward-subagent-text --from-pr --permission-mode --permission-prompts \
              --output-format --input-format --session-id --no-session-persistence --restricted --tools; do
    line="$(grep -nE "^  (-[a-zA-Z], )?${flag% *}( |,)" "$OUT/help.txt" | head -1)"
    printf '  %-30s %s\n' "$flag" "${line:-<未在 --help 出现>}"
  done
  say "  子命令: $("$CLAUDE_BIN" --help 2>&1 | sed -n '/^Commands:/,$p' | awk '/^  [a-z]/{print $1}' | tr '\n' ' ')"
  say "  claude agents --help -> $OUT/help-agents.txt"
  "$CLAUDE_BIN" agents --help > "$OUT/help-agents.txt" 2>&1 || true
  grep -nE '^  --(json|all|cwd)' "$OUT/help-agents.txt" | sed -E 's/^/    /' || true
else
  say "  SKIP"
fi

# ---------------------------------------------------------------- 3. Agent SDK typings（带行号）
hr; say "[3] Agent SDK typings 关键符号行号（${SDK_DIR}/sdk.d.ts）"
if [ -f "${SDK_DIR}/sdk.d.ts" ]; then
  python3 - "${SDK_DIR}" <<'PYEOF'
import re, sys, os
d = sys.argv[1]
sdk = open(os.path.join(d, "sdk.d.ts"), encoding="utf-8", errors="replace").read().splitlines()
tools = open(os.path.join(d, "sdk-tools.d.ts"), encoding="utf-8", errors="replace").read().splitlines()

def find(lines, literal, limit=2):
    return [str(i + 1) for i, ln in enumerate(lines) if literal in ln][:limit]

print("  选项声明行号（sdk.d.ts，字面量精确匹配）:")
for lit in ("resume?: string;", "forkSession?: boolean;", "resumeSessionAt?: string;",
            "agents?: Record<string, AgentDefinition>;", "includePartialMessages?: boolean;",
            "forwardSubagentText?: boolean;", "permissionMode?: PermissionMode;",
            "canUseTool?: CanUseTool;", "hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;",
            "persistSession?: boolean;", "disallowedTools?: string[];", "maxTurns?: number;",
            "abortController?: AbortController;", "permissionPrompts?: 'host' | 'none';",
            "allowDangerouslySkipPermissions?: boolean;", "sandbox?: SandboxSettings;",
            "resumeSessionAt", "sessionId?: string;"):
    print("    %-56s %s" % (lit, ",".join(find(sdk, lit)) or "-"))

print("  枚举/联合类型声明:")
for i, ln in enumerate(sdk):
    if re.match(r"export declare type (PermissionMode|HookEvent|AgentDefinition|SDKMessage) ", ln):
        print("    %d: %s" % (i + 1, ln[:190]))

print("  Query 控制方法（可续接/可中断/可换模型）:")
for i, ln in enumerate(sdk):
    if re.match(r"^    (interrupt|setPermissionMode|setMcpPermissionModeOverride|rewindFiles|setModel|stopTask)\(", ln):
        print("    %d: %s" % (i + 1, ln.strip()[:120]))

print("  用量/成本字段:")
for lit in ("total_cost_usd: number;", "usage: NonNullableUsage;", "modelUsage: Record<string, ModelUsage>;"):
    print("    %-40s %s" % (lit, ",".join(find(sdk, lit, 3)) or "-"))

print("  sdk-tools.d.ts 工具输入类型（子代理链）:")
for lit in ("| AgentInput", "| TaskStopInput", "| WorkflowInput", "| TaskOutputInput"):
    print("    %-24s %s" % (lit, ",".join(find(tools, lit, 2)) or "- (无独立 SendMessage/ListAgents 输入类型)"))
print("  注：SendMessage/ListAgents 无公开 typing，仅运行时存在（见 [4]）")
PYEOF
else
  say "  SKIP sdk.d.ts 不存在"
fi

# ---------------------------------------------------------------- 4. 运行时工具集证据（二进制字符串，零额度）
hr; say "[4] 原生子代理工具存在证据（CLI 二进制字符串扫描，零额度）"
BIN_REAL="$(readlink -f "${CLAUDE_BIN:-}" 2>/dev/null || true)"
if [ -n "$BIN_REAL" ] && [ -f "$BIN_REAL" ]; then
  say "  binary: ${BIN_REAL} ($(wc -c < "$BIN_REAL" | tr -d ' ') bytes)"
  for pat in ListAgents SendMessage TaskStop Workflow SendUserMessage ListPeers; do
    printf '    %-16s occurrences=%s\n' "$pat" "$(LC_ALL=C grep -a -c -F "$pat" "$BIN_REAL" 2>/dev/null || echo 0)"
  done
  python3 - "$BIN_REAL" "$OUT" <<'PYEOF'
import sys
path, out = sys.argv[1], sys.argv[2]
targets = [b'var g={Task:"Agent"', b'Lists agents you can', b'Launch a new agent to handle']
found, CH, prev = {}, 1 << 24, b''
with open(path, 'rb') as f:
    while True:
        b = f.read(CH)
        if not b: break
        buf = prev + b
        for t in targets:
            if t in found: continue
            i = buf.find(t)
            if i >= 0:
                found[t] = bytes(c if 32 <= c < 127 else 46 for c in buf[max(0, i - 40):i + 420]).decode()
        prev = buf[-400:]
with open(out + "/binary-tool-strings.txt", "w") as fh:
    for t in targets:
        fh.write("### %s\n%s\n\n" % (t.decode(), found.get(t, "NOT FOUND")))
for t in targets:
    print("    ### %s" % t.decode())
    print("      " + (found.get(t, "NOT FOUND")[:380]))
PYEOF
else
  say "  SKIP 无法解析 claude 可执行文件真实路径"
fi

# ---------------------------------------------------------------- 5. 会话枚举（session-list，零额度）
hr; say "[5] 本机会话枚举（claude agents --json，零额度）"
if [ -n "$CLAUDE_BIN" ]; then
  python3 - "$CLAUDE_BIN" "$OUT" <<'PYEOF'
import json, subprocess, sys
binp, out = sys.argv[1], sys.argv[2]
try:
    r = subprocess.run([binp, "agents", "--json"], capture_output=True, text=True, timeout=25)
except subprocess.TimeoutExpired:
    print("  SKIP 超时(>25s)"); raise SystemExit(0)
print("  rc=%s stderr=%r" % (r.returncode, r.stderr[:120]))
try:
    data = json.loads(r.stdout or "[]")
except Exception:
    print("  SKIP 非 JSON 输出: %r" % (r.stdout[:120],)); raise SystemExit(0)
print("  会话数=%d" % len(data))
for row in data[:5]:
    print("    keys=%s kind=%s status=%s" % (sorted(row), row.get("kind"), row.get("status")))
open(out + "/agents-json.json", "w").write(r.stdout or "[]")
PYEOF
else
  say "  SKIP"
fi

# ---------------------------------------------------------------- 5b. SDK 会话 API（程序化 session-list，零额度）
hr; say "[5b] Agent SDK 程序化会话 API（真跑 listSessions/listSubagents，零额度、只读）"
if [ -f "${SDK_DIR}/sdk.mjs" ] && command -v node >/dev/null 2>&1; then
  cat > "$OUT/ls-probe.mjs" <<'MJS'
const sdk = await import(process.argv[2]);
const names = Object.keys(sdk).sort();
console.log("  sdk exports =", names.length);
console.log("  会话类导出 =", names.filter(n => /Session|Subagent/.test(n)).join(", "));
try {
  const list = await sdk.listSessions({ limit: 5 });
  console.log("  listSessions ->", list.length, "行; row keys =",
    Object.keys(list[0] || {}).sort().join(","));
  for (const s of list.slice(0, 3))
    console.log("    sessionId(前8)=" + String(s.sessionId).slice(0, 8) + "…  cwd=" + s.cwd +
                "  summaryLen=" + String(s.summary || "").length);
  if (list[0]) {
    const subs = await sdk.listSubagents(list[0].sessionId);
    console.log("  listSubagents(第一个会话) ->", subs.length, "个子代理 id");
  }
} catch (e) { console.log("  listSessions FAILED:", e.message); }
MJS
  node "$OUT/ls-probe.mjs" "${SDK_DIR}/sdk.mjs" 2>&1 | head -20
else
  say "  SKIP（缺 sdk.mjs 或 node）"
fi

# ---------------------------------------------------------------- 5c. 原生子代理 transcript 落盘形状
hr; say "[5c] 原生子代理 transcript 落盘形状（~/.claude/projects/<dir>/<sid>/subagents/）"
SUBDIRS="$(find "${HOME}/.claude/projects" -type d -name subagents 2>/dev/null | head -3)"
if [ -n "$SUBDIRS" ]; then
  for d in $SUBDIRS; do
    say "  ${d}"
    for f in "$d"/agent-*.meta.json; do
      [ -f "$f" ] || continue
      python3 - "$f" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
print("    " + sys.argv[1].rsplit("/", 1)[-1] + " keys=" + ",".join(sorted(d)) +
      "  agentType=" + repr(d.get("agentType")) + "  spawnDepth=" + repr(d.get("spawnDepth")))
PYEOF
    done
  done
else
  say "  SKIP 未发现 subagents 目录（本机该特性尚未落盘）"
fi
hr; say "[6] 本地会话存储（resume/fork 的前提）"
PROJ="${HOME}/.claude/projects"
if [ -d "$PROJ" ]; then
  say "  session jsonl 数量: $(find "$PROJ" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  say "  项目目录数: $(find "$PROJ" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
else
  say "  SKIP ${PROJ} 不存在"
fi
ls -d "${HOME}"/.claude/plugins/* 2>/dev/null | head -5 | sed -E 's/^/  plugin: /' || true

# ---------------------------------------------------------------- 7. DSH 插件实际传了什么
hr; say "[7] DSH 插件 @deepseek-ai/dsh-subagent-claude-code 的 query options（能力关在哪）"
if [ -f "${DSH_PLUGIN}/lib/index.js" ]; then
  say "  插件版本: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "${DSH_PLUGIN}/package.json" 2>/dev/null || echo '?')"
  say "  claudeQueryOptions 实际传入的键:"
  awk '/^function claudeQueryOptions/,/^}/' "${DSH_PLUGIN}/lib/index.js" \
    | grep -oE '^[[:space:]]*[a-zA-Z]+:' | tr -d ' :' | sort -u | tr '\n' ' ' | sed -E 's/^/    /'; echo
  say "  关键行:"
  grep -nE 'persistSession|disallowedTools|canUseTool|permissionMode:|allowDangerouslySkipPermissions|onElicitation|onUserDialog|supportedDialogKinds' \
    "${DSH_PLUGIN}/lib/index.js" | head -12 | sed -E 's/^/    /'
  say "  允许的 permissionMode 枚举与默认:"
  awk '/^const CLAUDE_CODE_PERMISSION_MODES/,/^const SUPPORTED_UNATTENDED_DIALOG_KINDS/' "${DSH_PLUGIN}/lib/index.js" | sed -E 's/^/    /'
  say "  结果消费策略（只认一条 success result）:"
  grep -nE 'message\.subtype !== "success"|message\.type !== "result"|successfulResult' \
    "${DSH_PLUGIN}/lib/index.js" | head -6 | sed -E 's/^/    /'
else
  say "  SKIP ${DSH_PLUGIN}/lib/index.js 不存在"
fi

hr; say "== probe-claude 完成（原始产物: ${OUT}）"
exit 0
