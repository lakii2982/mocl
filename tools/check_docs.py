#!/usr/bin/env python3
"""MOCL 文档闸门 —— 设计阶段的可执行验收。

用法:
    python3 tools/check_docs.py all
    python3 tools/check_docs.py matrix arch abi
    python3 tools/check_docs.py --list

退出码 0 = 全部通过；1 = 有失败（逐条打印 FAIL 原因）。
本脚本只做"是否有证据/结构是否齐全"的机械检查，不做语义评审。
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

BACKENDS = ["codex", "kimi", "claude-code", "opencode"]

# 15 个能力维度（矩阵行）—— 与 BRIEF A1 对齐
CAPABILITIES = [
    "headless",
    "stream",
    "resume",
    "fork",
    "session-list",
    "interrupt",
    "native-subagents",
    "tool-extension",
    "permission-modes",
    "sandbox",
    "auth-model-routing",
    "concurrency",
    "usage-observability",
    "structured-protocol",
    "version-pinning",
]

ADAPTER_SECTIONS = [
    "身份与版本",
    "启动与握手",
    "会话生命周期",
    "续接与恢复",
    "流事件映射",
    "原生子代理与嵌套",
    "权限与沙箱",
    "认证与模型路由",
    "限流与并发",
    "失败与降级",
    "可观测性",
    "验收命令",
]


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checks = 0

    # ---------- helpers ----------
    def require_file(self, rel: str, min_bytes: int = 400) -> str | None:
        p = ROOT / rel
        self.checks += 1
        if not p.is_file():
            self.failures.append(f"[{rel}] 文件不存在")
            return None
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text.encode("utf-8")) < min_bytes:
            self.failures.append(f"[{rel}] 内容过短(<{min_bytes}B)，疑似占位")
        return text

    def require_pattern(self, rel: str, pattern: str, why: str, flags=re.M) -> None:
        self.checks += 1
        p = ROOT / rel
        if not p.is_file():
            self.failures.append(f"[{rel}] 文件不存在（检查: {why}）")
            return
        if not re.search(pattern, p.read_text(encoding="utf-8", errors="replace"), flags):
            self.failures.append(f"[{rel}] 缺少 {why}（pattern={pattern!r}）")

    def forbid_pattern(self, rel: str, pattern: str, why: str) -> None:
        self.checks += 1
        p = ROOT / rel
        if not p.is_file():
            self.failures.append(f"[{rel}] 文件不存在（检查: {why}）")
            return
        if re.search(pattern, p.read_text(encoding="utf-8", errors="replace")):
            self.failures.append(f"[{rel}] 仍包含 {why}（pattern={pattern!r}）")

    # ---------- stages ----------
    def stage_ledger(self) -> None:
        self.require_file(".astra/BRIEF.md", 800)
        self.require_file(".astra/PLAN.md", 800)
        self.require_file(".astra/LEDGER.md", 200)
        self.require_file(".astra/CONTEXT-DSH-SEAM.md", 400)

    def stage_research(self) -> None:
        for b in ["codex", "claude-code", "kimi", "opencode"]:
            rel = f"docs/research/{b}.md"
            text = self.require_file(rel, 800)
            if text is None:
                continue
            for section in ["版本", "证据", "限制"]:
                self.checks += 1
                if section not in text:
                    self.failures.append(f"[{rel}] 缺少小节关键词: {section}")
            self.require_pattern(rel, r"```bash|```shell|\$\s", "可复跑的命令块")
        for script in ["repro/probe-codex.sh", "repro/probe-claude.sh",
                       "repro/probe-kimi.sh", "repro/probe-opencode.sh"]:
            self.require_file(script, 80)

    def stage_matrix(self) -> None:
        rel = "docs/research/capability-matrix.md"
        text = self.require_file(rel, 1200)
        if text is None:
            return
        self.forbid_pattern(rel, r"TO-?VERIFY", "未验证标记（TO-VERIFY）")
        for b in BACKENDS:
            self.checks += 1
            if b not in text:
                self.failures.append(f"[{rel}] 缺少后端列: {b}")
        for cap in CAPABILITIES:
            self.checks += 1
            if cap not in text:
                self.failures.append(f"[{rel}] 缺少能力行: {cap}")
        # 每行至少有 4 个证据标记
        for cap in CAPABILITIES:
            line = next((ln for ln in text.splitlines() if cap in ln), "")
            self.checks += 1
            if line.count("→") + line.count("[") < 4:
                self.failures.append(f"[{rel}] 能力 {cap} 证据不足（需每后端一条证据引用）")

    def stage_arch(self) -> None:
        for rel, keys in {
            "docs/architecture/00-overview.md": ["分层", "数据流", "部署"],
            "docs/architecture/01-layers.md": ["L0", "L1", "L2", "L3"],
            "docs/architecture/02-state-machine.md": ["状态", "转移", "幂等"],
            "docs/architecture/03-failure-modes.md": ["失败模式", "降级", "重试"],
        }.items():
            text = self.require_file(rel, 600)
            if text is None:
                continue
            for k in keys:
                self.checks += 1
                if k not in text:
                    self.failures.append(f"[{rel}] 缺少要素: {k}")

    def stage_abi(self) -> None:
        abc = self.require_file("docs/abi/abi-v0.md", 1000)
        if abc:
            for k in ["版本协商", "错误分类", "能力位"]:
                self.checks += 1
                if k not in abc:
                    self.failures.append(f"[docs/abi/abi-v0.md] 缺少: {k}")
        schema_dir = DOCS / "abi" / "schema"
        self.checks += 1
        files = sorted(schema_dir.glob("*.json")) if schema_dir.is_dir() else []
        if len(files) < 3:
            self.failures.append("[docs/abi/schema] JSON Schema 少于 3 个")
        for f in files:
            self.checks += 1
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                self.failures.append(f"[{f.relative_to(ROOT)}] JSON 解析失败: {exc}")
                continue
            if not isinstance(data, dict) or "$schema" not in data:
                self.failures.append(f"[{f.relative_to(ROOT)}] 缺少 $schema")

    def stage_adapters(self) -> None:
        for b in BACKENDS:
            rel = f"docs/adapters/{b}.md"
            text = self.require_file(rel, 1200)
            if text is None:
                continue
            for section in ADAPTER_SECTIONS:
                self.checks += 1
                if section not in text:
                    self.failures.append(f"[{rel}] 缺少必填小节: {section}")

    def stage_integration(self) -> None:
        rel = "docs/integration/00-dsh-integration.md"
        text = self.require_file(rel, 1200)
        if text:
            for k in ["seam", "旁路", "推荐", "配置"]:
                self.checks += 1
                if k not in text:
                    self.failures.append(f"[{rel}] 缺少要素: {k}")
        self.require_file("docs/integration/01-config-and-enable.md", 600)
        self.require_file("docs/integration/02-ui-data-plane.md", 400)

    def stage_risk(self) -> None:
        rel = "docs/risk/00-risk-register.md"
        text = self.require_file(rel, 1500)
        if text:
            rows = [ln for ln in text.splitlines() if re.match(r"^\|\s*R\d+", ln)]
            self.checks += 1
            if len(rows) < 20:
                self.failures.append(f"[{rel}] 风险条目 {len(rows)} < 20")
            for ln in rows:
                cols = [c.strip() for c in ln.strip().strip("|").split("|")]
                self.checks += 1
                if len(cols) < 7:
                    self.failures.append(f"[{rel}] 风险字段不足 7 列: {ln[:60]}")
        rel2 = "docs/risk/01-threat-model.md"
        text2 = self.require_file(rel2, 800)
        if text2:
            for k in ["凭据", "路径穿越", "沙箱", "提示注入", "供应链"]:
                self.checks += 1
                if k not in text2:
                    self.failures.append(f"[{rel2}] 缺少威胁项: {k}")

    def stage_test(self) -> None:
        rel = "docs/test/00-test-plan.md"
        text = self.require_file(rel, 1000)
        if text:
            for k in ["契约测试", "录制回放", "故障注入", "验收"]:
                self.checks += 1
                if k not in text:
                    self.failures.append(f"[{rel}] 缺少: {k}")
        self.require_file("docs/test/01-acceptance.md", 600)

    def stage_review(self) -> None:
        rel = "docs/review/SCORECARD.md"
        text = self.require_file(rel, 500)
        if text:
            findings = re.findall(r"^\s*(?:[-*]\s*)?(?:F\d+|打回)", text, flags=re.M)
            self.checks += 1
            if len(findings) < 5:
                self.failures.append(f"[{rel}] 打回意见/发现 {len(findings)} < 5")
            self.checks += 1
            if not re.search(r"(未发现|通过|不通过)", text):
                self.failures.append(f"[{rel}] 缺少判定结论")
        self.require_file("docs/review/VERIFY-GATE.md", 300)

    def stage_plan(self) -> None:
        rel = ".astra/PLAN.md"
        text = self.require_file(rel, 800)
        if text:
            slices = re.findall(r"^\|\s*(D\d+|C\d+)\s*\|", text, flags=re.M)
            self.checks += 1
            if len(slices) < 15:
                self.failures.append(f"[{rel}] 切片 {len(slices)} < 15")
            cmds = re.findall(r"`(?:python3 tools/check_docs\.py|pnpm -s|bash repro/)[^`]*`", text)
            self.checks += 1
            if len(cmds) < 10:
                self.failures.append(f"[{rel}] 可执行验证命令 {len(cmds)} < 10")

    def stage_docs(self) -> None:
        for rel in ["docs/00-README.md", "HANDOFF.md", ".astra/INTEGRATION.md", ".astra/JOURNAL.md"]:
            self.require_file(rel, 300)

    def stage_secrets(self) -> None:
        """扫描仓库内是否误提交凭据（防止调研时把 token 粘进文档）。"""
        patterns = [
            (r"sk-[A-Za-z0-9]{16,}", "OpenAI/Anthropic 风格密钥"),
            (r"ANTHROPIC_AUTH_TOKEN\s*[:=]\s*[\"']?[A-Za-z0-9._-]{16,}", "Anthropic token 赋值"),
            (r"(?:api[_-]?key|token|secret)\s*[:=]\s*[\"'][A-Za-z0-9._-]{20,}[\"']", "疑似硬编码密钥"),
            (r"Bearer\s+[A-Za-z0-9._-]{20,}", "Bearer token"),
        ]
        skip_dirs = {"node_modules", ".git", "__pycache__"}
        skip_files = {"BRIEF.md", "PLAN.md", "00-risk-register.md", "01-threat-model.md",
                      "check_docs.py", "00-test-plan.md", "01-acceptance.md"}
        for p in ROOT.rglob("*"):
            if not p.is_file() or p.suffix not in {".md", ".sh", ".py", ".json", ".ts", ".js", ".yml", ".yaml"}:
                continue
            if skip_dirs & set(p.parts) or p.name in skip_files:
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for pat, why in patterns:
                self.checks += 1
                for m in re.finditer(pat, text):
                    self.failures.append(
                        f"[{p.relative_to(ROOT)}] 疑似凭据（{why}）: {m.group(0)[:12]}…")

    def stage_errcodes(self) -> None:
        """风险/测试文档只允许出现 error.json 枚举内的错误码（F6）。"""
        err = ROOT / "docs/abi/schema/error.json"
        self.checks += 1
        if not err.is_file():
            self.failures.append("[docs/abi/schema/error.json] 文件不存在或未同步")
            return
        codes = set(json.loads(err.read_text(encoding="utf-8"))["properties"]["code"]["enum"])
        roots = {"transport", "auth", "quota", "protocol", "process", "capability",
                 "session", "policy", "storage", "limit", "security", "internal", "backend"}
        banned = {"quota-denied", "session-gone", "bad-cwd", "crashed", "bad-frame",
                  "unknown-frame", "auth-failed", "needs-human", "service"}
        for rel in ["docs/risk/00-risk-register.md", "docs/risk/01-threat-model.md",
                    "docs/test/00-test-plan.md", "docs/test/01-acceptance.md"]:
            p = ROOT / rel
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(r"`([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)`", text):
                code = m.group(1)
                if code.split(".")[0] not in roots:
                    continue
                self.checks += 1
                if code not in codes:
                    self.failures.append(f"[{rel}] 使用非 ABI 错误码: {code}")
            for b in banned:
                self.checks += 1
                if f"`{b}`" in text:
                    self.failures.append(f"[{rel}] 残留旧错误码: {b}")

    STAGES = {
        "ledger": stage_ledger,
        "secrets": stage_secrets,
        "errcodes": stage_errcodes,
        "research": stage_research,
        "matrix": stage_matrix,
        "arch": stage_arch,
        "abi": stage_abi,
        "adapters": stage_adapters,
        "integration": stage_integration,
        "risk": stage_risk,
        "test": stage_test,
        "threat": stage_risk,  # alias：威胁模型与风险登记册同一闸门
        "review": stage_review,
        "plan": stage_plan,
        "docs": stage_docs,
    }

    def run(self, names: list[str]) -> int:
        order = ["ledger", "secrets", "errcodes", "research", "matrix", "arch", "abi", "adapters",
                 "integration", "risk", "test", "review", "plan", "docs"]
        targets = order if "all" in names else names
        for name in targets:
            fn = self.STAGES.get(name)
            if fn is None:
                print(f"unknown stage: {name}")
                return 2
            before = len(self.failures)
            fn(self)
            mark = "PASS" if len(self.failures) == before else "FAIL"
            print(f"{mark:4} {name}")
        print(f"\nchecks={self.checks} failures={len(self.failures)}")
        for f in self.failures:
            print("  FAIL " + f)
        return 0 if not self.failures else 1


def main(argv: list[str]) -> int:
    if "--list" in argv:
        print("\n".join(Checker.STAGES))
        return 0
    names = [a for a in argv if not a.startswith("-")] or ["all"]
    return Checker().run(names)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
