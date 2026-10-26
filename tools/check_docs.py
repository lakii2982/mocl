#!/usr/bin/env python3
"""MOCL 文档闸门 —— 公开仓的可执行验收。

用法:
    python3 tools/check_docs.py all
    python3 tools/check_docs.py matrix arch abi
    python3 tools/check_docs.py --list

退出码 0 = 全部通过；1 = 有失败（逐条打印 FAIL 原因）。
本脚本只做"是否有证据/结构是否齐全/链接是否可解析"的机械检查，不做语义评审。
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

BACKENDS = ["codex", "kimi", "claude-code", "opencode"]

# 15 个能力维度（矩阵行）
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
    def stage_community(self) -> None:
        """公开仓必备文件与关键元数据。"""
        license_text = self.require_file("LICENSE", 200)
        if license_text is not None:
            self.checks += 1
            if not license_text.lstrip().startswith("MIT License"):
                self.failures.append("[LICENSE] 不是 MIT 许可证文本")
        for rel in [
            "README.md",
            "README.zh-CN.md",
            "CONTRIBUTING.md",
            "CODE_OF_CONDUCT.md",
            "SECURITY.md",
            "CHANGELOG.md",
            ".gitignore",
            ".editorconfig",
            ".nvmrc",
            "config.example.json",
            "config.default.json",
        ]:
            self.require_file(rel, 2 if rel in {".gitignore", ".editorconfig", ".nvmrc"} else 200)
        # README 必须是英文主文档：标题行不含中文
        text = self.require_file("README.md", 800)
        if text is not None:
            self.checks += 1
            first = next((ln for ln in text.splitlines() if ln.startswith("# ")), "")
            if re.search(r"[\u4e00-\u9fff]", first):
                self.failures.append("[README.md] 主 README 标题应为英文（中文版在 README.zh-CN.md）")
        # 配置示例必须是合法 JSON 且不含绝对路径
        for rel in ["config.example.json", "config.default.json"]:
            p = ROOT / rel
            self.checks += 1
            if not p.is_file():
                self.failures.append(f"[{rel}] 文件不存在")
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                self.failures.append(f"[{rel}] JSON 解析失败: {exc}")
                continue
            if not isinstance(data, dict) or "backends" not in data:
                self.failures.append(f"[{rel}] 缺少 backends 配置块")
            if "/Users/" in json.dumps(data, ensure_ascii=False):
                self.failures.append(f"[{rel}] 含个人绝对路径")
        # package.json 元数据（公开仓）
        pkg = ROOT / "package.json"
        self.checks += 1
        try:
            meta = json.loads(pkg.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            self.failures.append(f"[package.json] 解析失败: {exc}")
            return
        if not str(meta.get("version", "")).startswith("0.1."):
            self.failures.append(f"[package.json] version 应为 0.1.x（实际 {meta.get('version')!r}）")
        if meta.get("license") != "MIT":
            self.failures.append("[package.json] license 应为 MIT")
        if not str((meta.get("repository") or {}).get("url", "")).startswith("git+"):
            self.failures.append("[package.json] 缺少 repository.url（git+https://…）")
        if meta.get("private") is True:
            self.failures.append("[package.json] 公开仓不应设置 private: true")

    def stage_secrets(self) -> None:
        """扫描文档仓内是否误提交凭据（防止调研时把 token 粘进文档）。"""
        patterns = [
            (r"sk-[A-Za-z0-9]{16,}", "OpenAI/Anthropic 风格密钥"),
            (r"ANTHROPIC_AUTH_TOKEN\s*[:=]\s*[\"']?[A-Za-z0-9._-]{16,}", "Anthropic token 赋值"),
            (r"(?:api[_-]?key|token|secret)\s*[:=]\s*[\"'][A-Za-z0-9._-]{20,}[\"']", "疑似硬编码密钥"),
            (r"Bearer\s+[A-Za-z0-9._-]{20,}", "Bearer token"),
        ]
        skip_dirs = {"node_modules", ".git", "__pycache__"}
        # 这些文档本身要讨论凭据模式/安全策略，按文件显式豁免（不是整目录跳过）
        skip_files = {"00-risk-register.md", "01-threat-model.md",
                      "00-test-plan.md", "01-acceptance.md", "SECURITY.md",
                      "leak-scan.mjs", "check_docs.py"}
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
                for m in re.finditer(pat, text):
                    self.failures.append(
                        f"[{p.relative_to(ROOT)}] 疑似凭据（{why}）: {m.group(0)[:12]}…")

    def stage_errcodes(self) -> None:
        """风险/测试文档只允许出现 error.json 枚举内的错误码。"""
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

    def stage_links(self) -> None:
        """相对 Markdown 链接必须能解析到仓内文件（锚点/外链跳过）。"""
        targets = [
            ROOT / "README.md",
            ROOT / "README.zh-CN.md",
            ROOT / "CONTRIBUTING.md",
            ROOT / "SECURITY.md",
            ROOT / "CODE_OF_CONDUCT.md",
            ROOT / "CHANGELOG.md",
        ]
        targets.extend(sorted(DOCS.rglob("*.md")))
        link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
        for p in targets:
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
            for m in link_re.finditer(text):
                target = m.group(1)
                if target.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                path_part = target.split("#", 1)[0]
                if not path_part:
                    continue
                self.checks += 1
                if not (p.parent / path_part).resolve().exists():
                    self.failures.append(f"[{p.relative_to(ROOT)}] 死链: {target}")

    STAGES = {
        "community": stage_community,
        "secrets": stage_secrets,
        "errcodes": stage_errcodes,
        "research": stage_research,
        "matrix": stage_matrix,
        "arch": stage_arch,
        "abi": stage_abi,
        "adapters": stage_adapters,
        "integration": stage_integration,
        "risk": stage_risk,
        "threat": stage_risk,  # alias：威胁模型与风险登记册同一闸门
        "test": stage_test,
        "review": stage_review,
        "links": stage_links,
    }

    def run(self, names: list[str]) -> int:
        order = ["community", "secrets", "errcodes", "research", "matrix", "arch", "abi",
                 "adapters", "integration", "risk", "test", "review", "links"]
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
