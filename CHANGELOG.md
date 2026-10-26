# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-26

First open-source release of MOCL: a compatibility layer that exposes codex,
claude-code, kimi and opencode as orchestration-capable subagents of DeepSeek
Harness (DSH), without modifying DSH itself.

### Added

- **ABI v0 core**: five JSON Schemas (session / event / error / capabilities /
  request) and the matching TypeScript wire types. Contract counts are verified
  by `node tools/validate-abi.mjs`: **46** error codes, **34** capability bits,
  **35** event types, **18** methods (9 schema-frozen).
- **Session broker**: session registry, idempotency keys, kill/recover, and
  runtime-derived concurrency limits (no hard-coded concurrency).
- **Event bus**: per-session ring buffer, event folding, limits for
  parent-delivery (at most 1 terminal notification per turn) and snapshot support.
- **Backend adapters**:
  - `codex` over the `app-server` JSON-RPC protocol (baseline 0.164.0);
  - `claude-code` over the Claude Agent SDK (adapter baseline Agent SDK 0.3.263
    with its bundled CLI 2.1.263);
  - `kimi` over ACP (kimi-code 2.3.1), including process-kill based interrupt;
  - `opencode` over its v2 HTTP API with ACP as an alternate channel
    (opencode 2.1.4).
- **Facade and DSH plugin**: a thin `subagent_agent(backend=...)` tool plus
  `mocl_status(childId?, cursor)`; renderer-facing data stays in the facade, the
  plugin only registers tools. A patch file composes the plugin row and disables
  the legacy one-shot `subagent-codex` / `subagent-claude-code` tools.
- **Offline end-to-end scenario**: `node e2e/pr-scenario.mjs` runs a fake
  backend through a temporary git worktree and asserts terminal events, parent
  delivery, usage, and zero writes outside the worktree. The live variant is
  opt-in via `MOCL_LIVE=1`.
- **Repository tooling**: `tools/validate-abi.mjs` (contract gate),
  `tools/sync-schema.mjs` (schema copy gate), `tools/build-plugin-package.mjs`
  (installable plugin bundle), `tools/check_docs.py` (documentation structure,
  counts and link gate) and `tools/leak-scan.mjs` (publish-time leak gate).
- **Documentation**: ABI reference, architecture (layers, state machine,
  failure modes), per-backend adapter mappings, DSH integration notes,
  capability matrix and research evidence, risk register and threat model, test
  plan and acceptance matrix, independent review records, and an operations
  runbook.
- **Agent-driven delivery process** (this repository is its own reference
  implementation): a ten-document process OS in `docs/process/` (gates G0–G7,
  RACI, label state machine, requirement intake, RFC/ADR, verification evidence
  protocol, review & merge, release, delivery report, metrics, escalation, local
  runtime); eight six-section role prompts in `agents/roles/`; a zero-dependency
  delivery engine in `orchestrator/` (`intake | deliver | verify | watch |
  status`) with dry-run and a mock runner; GitHub CI gates plus a PR contract
  guard (`.github/workflows/ci.yml`, `process-guard.yml`), issue forms, labels,
  CODEOWNERS and a release workflow; and `scripts/provision-github.sh` to apply
  labels, merge policy and branch protection from the repository itself.
- **Open-source packaging**: MIT `LICENSE`, bilingual `README.md` /
  `README.zh-CN.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `.editorconfig`, `.nvmrc`, `config.example.json`, and a `.gitignore` that
  excludes local configuration and build output.

### Fixed

- **Facade: opencode assembly** (issue #8). `createBackendAdapter("opencode", ...)`
  now injects the HTTP or ACP client instead of constructing `OpenCodeAdapter`
  without one. Enabling opencode no longer fails facade assembly with a
  `TypeError`; when the channel is not configured the facade fails closed with
  the ABI error `auth.missing-credential`. The ACP client is created lazily, so
  assembly still does not spawn a child process.

### Known limitations

- `codex` live turns are environment-limited on the development machine: the
  `app-server` returned `turn.failed` (internal error) after ~47 s, so the live
  end-to-end run is recorded as `skipped:host-unavailable`. The offline scenario
  passes.
- `claude-code` live smoke passes (Agent SDK 0.3.263 path).
- `kimi` live smoke consumes reserved quota; default probes are zero-quota and
  read-only.
- `opencode` paid-model credentials on the development machine are expired
  (`401 api_key_expired`); the adapter falls back to the free model pool, which
  was verified end-to-end (`rc=0`, session continuation via `-s`).
- DSH host API baseline is **0.2.1-rc.3**; upgrading DSH requires re-checking
  `src/plugin/dsh-types.d.ts` and the `ctx.tools` registration signature.
- Rendering delegated external subagents inside the official DSH GUI stays
  limited to non-openable leaf rows; use `mocl_status` and the session journal
  for state and progress.
- No npm release is provided; install by cloning this repository (Node >= 24).

### Security

- The shipped configuration is fail-closed: all backends disabled, read-only
  permission, dangerous modes disallowed, worktree isolation required for
  writes.
- `tools/leak-scan.mjs` is part of the release checklist and must exit `0`
  before publishing.

[0.1.0]: https://github.com/lakii2982/mocl/releases/tag/v0.1.0
