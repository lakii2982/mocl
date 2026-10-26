# Contributing to MOCL

Thanks for your interest in MOCL. This document describes the development
workflow and the gates a change must pass before it can be merged.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
For security issues, do **not** open a public issue — follow
[SECURITY.md](SECURITY.md).

## 1. Development environment

- Node.js **>= 24** (`.nvmrc` is provided; `node --version` must be v24+)
- pnpm (the repository uses a pnpm v9 lockfile; CI pins the pnpm version)
- Python 3.9+ (only for the documentation gate `tools/check_docs.py`)
- macOS/Linux shell (the probe scripts in `repro/` assume POSIX `bash`)

```bash
git clone https://github.com/lakii2982/mocl.git
cd mocl
pnpm install
```

No credentials are required for the offline test suite. Some optional live
tests and probes need locally installed backend CLIs; they are skipped
automatically when the CLIs are missing.

## 2. Build and test

```bash
pnpm typecheck          # tsc --noEmit (strict)
pnpm test               # vitest run (offline)
pnpm validate          # ABI gate: 46 errors / 34 capability bits / 35 events / 18 methods
node tools/sync-schema.mjs --check   # schema copy must match docs/abi/schema
pnpm docs:check         # documentation structure/counts/links
pnpm leak-scan          # no personal paths, credentials or internal ledgers
```

All commands above must exit `0`. If a change intentionally alters ABI
semantics (counts, codes, events, methods), the schema in `docs/abi/schema/`
and the copy in `schema/` must be updated together, and the ABI document
`docs/abi/abi-v0.md` is the single source of truth.

## 3. Pull requests

- Keep changes small and scoped; one topic per pull request.
- Explain **what** changed and **why**, and list the exact commands you ran
  with their exit codes. "Tests pass" without the command is not evidence.
- Do not include generated artifacts (`dist/`, `node_modules/`, `var/`,
  `e2e/tmp/`, `e2e/out/`), local configuration, or credentials.
- Do not commit personal absolute paths. Use `~` or `$(pwd)` in examples.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Documentation lives in `docs/`; keep relative links resolvable and keep
  documented counts consistent with `docs/abi/schema/`.

## 4. Commit messages

Use an imperative subject line of at most 72 characters, optionally with a
conventional prefix (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Reference
the affected area (for example `adapters/codex:`) when it helps review.

## 5. Safety rules for backend adapters

MOCL defaults to a fail-closed configuration: every backend is disabled,
`permissionMode` is `read-only`, dangerous modes are disallowed and worktree
isolation is required for writes. Contributions must not weaken these
defaults; if a feature needs a wider permission, it must be opt-in through
explicit configuration and documented in `SECURITY.md`-adjacent design docs.

## 6. License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
