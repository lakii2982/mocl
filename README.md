# MOCL

> A multi-agent orchestration compatibility layer for **DeepSeek Harness (DSH)**.
> MOCL unifies **codex**, **claude-code**, **kimi** and **opencode** behind one
> ABI and exposes them as orchestration-capable subagents — without modifying
> DSH itself.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

MOCL is pre-1.0 (`0.1.0`). This repository is the **single source of truth** for
the MOCL implementation and its design documents.

---

## 1. What MOCL does

The four backends each speak a different protocol and expose different
capabilities. MOCL sits between DSH and the backends and does four things:

1. **Unified sessions** — every backend session becomes addressable, resumable,
   interruptible and observable through one logical session model.
2. **Unified event stream** — four native event vocabularies are normalized into
   one bounded, foldable, replayable stream (with hard limits on what reaches
   the parent conversation).
3. **Unified failures** — four native error shapes become one error taxonomy
   with fixed degradation paths.
4. **One ABI** — adding a backend means adding one adapter; the broker, event
   bus, facade and DSH plugin do not change.

Non-goals: GUI visual design, forking or modifying DSH internals, backend
product features, and cross-backend session migration.

The ABI contract is counted and machine-checked by `tools/validate-abi.mjs`:
**46** error codes, **34** capability bits, **35** event types, **18** methods
(9 of them schema-frozen).

## 2. Backend support

| Backend | Transport (primary) | Baseline version | Status on the development machine |
|---|---|---|---|
| **codex** | `app-server` JSON-RPC (stdio) | codex-cli **0.164.0** | Offline path verified; live turn is environment-limited (`app-server` returned `turn.failed` after ~47 s) |
| **claude-code** | Claude Agent SDK (adapter baseline SDK **0.3.263**, bundled CLI 2.1.263) | Agent SDK 0.3.263 | Live smoke **passes** |
| **kimi** | ACP over stdio | kimi-code **2.3.1** | Read-only probes pass; live smoke consumes reserved quota (opt-in) |
| **opencode** | v2 HTTP API (ACP as alternate channel) | opencode **2.1.4** | Free model pool verified end-to-end (`rc=0`, session continuation works); the paid key is expired (`401 api_key_expired`) |

The full 4 × 15 capability matrix (with per-cell evidence and repro commands)
lives in [`docs/research/capability-matrix.md`](docs/research/capability-matrix.md).
Capability statuses are measured, not assumed: an adapter that cannot verify a
native handshake reports the capability as missing instead of pretending it
works.

## 3. Architecture

MOCL is a side-car layer: DSH keeps its own subagent seam, and MOCL is composed
into it as a plugin. Session truth belongs to MOCL's broker, not to the DSH seam,
because the seam treats external backends as one-shot executions.

```text
 parent DSH session
        │  subagent_agent(backend = codex | claude-code | kimi | opencode)
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ facade        open / send / status / list / resume /        │
 │               interrupt / close  →  MoclError → ABI ErrorRef│
 ├───────────────────────────┬─────────────────────────────────┤
 │ broker                    │ event bus                       │
 │ session registry,         │ fold, ring buffer, limits,      │
 │ idempotency, kill/recover │ parent delivery (≤1 / turn)     │
 ├───────────────────────────┴─────────────────────────────────┤
 │ ABI v0: 46 errors · 34 capability bits · 35 events · 18 methods
 ├─────────────────────────────────────────────────────────────┤
 │ adapters   codex │ claude-code │ kimi │ opencode             │
 └──────────────┬────┴──────┬───────┴───┬──┴────────────────────┘
                │           │           │
      app-server JSON-RPC  Agent SDK    ACP / v2 HTTP
                │           │           │
        codex process   claude CLI   kimi process   opencode service
```

Layers (see [`docs/architecture/01-layers.md`](docs/architecture/01-layers.md)):
L0 transport → L1 adapter → L2 broker → L3 event bus → L4 parent delivery →
L5 facade/plugin.

## 4. Quick start

Requirements: **Node.js >= 24** (a `.nvmrc` is included), pnpm, and
Python 3.9+ for the documentation gate.

```bash
git clone https://github.com/lakii2982/mocl.git
cd mocl
pnpm install

pnpm typecheck                    # strict TypeScript, no emit
pnpm test                         # offline test suite (vitest)
pnpm validate                     # ABI gate (46/34/35/18)
node tools/sync-schema.mjs --check  # schema copy is byte-identical to docs/abi/schema
pnpm docs:check                   # documentation structure / counts / links
pnpm leak-scan                    # no personal paths, secrets or internal ledgers
```

All six commands above are expected to exit `0`. No credentials are needed for
the offline suite; live tests and probes are opt-in and skip themselves when the
corresponding backend CLI is not installed.

Optional end-to-end scenario (offline, uses a temporary git worktree and a fake
backend):

```bash
node e2e/pr-scenario.mjs          # expect: RESULT: PASS (offline)
MOCL_LIVE=1 node e2e/pr-scenario.mjs  # live variant, needs a usable backend
```

Delivery engine (offline, no GitHub token needed):

```bash
node --test orchestrator/test/                        # engine unit tests (node:test)
node orchestrator/cli.mjs deliver --issue 1 --dry-run  # print the full plan, zero side effects
node orchestrator/cli.mjs status --offline --json      # read-only status
```

## 5. Using MOCL from DSH

MOCL is delivered as a DSH plugin that registers two tools:

- `subagent_agent(backend, task, ...)` — dispatch work to one of the four
  backends and receive a child session id;
- `mocl_status(childId?, cursor?)` — query session state/events by cursor.

The repository ships:

- `config.default.json` — fail-closed defaults: every backend disabled,
  `permissionMode: read-only`, dangerous modes disallowed, worktree isolation
  required for writes;
- `config.example.json` — the same shape, safe to copy as a starting point
  (a local configuration file is git-ignored and must never be committed);
- `patch/cordis.patch.yml` — adds the plugin row and disables the legacy
  one-shot `subagent-codex` / `subagent-claude-code` tools.

Enable/rollback steps, the full configuration reference, and the GUI data-plane
notes are in:

- [`docs/integration/01-config-and-enable.md`](docs/integration/01-config-and-enable.md)
- [`docs/integration/00-dsh-integration.md`](docs/integration/00-dsh-integration.md)
- [`docs/integration/02-ui-data-plane.md`](docs/integration/02-ui-data-plane.md)

## 6. How work gets delivered: DSH + GitHub + local agents

This repository is also a working reference implementation of an **agent-run
software delivery process**. The maintainer writes a business requirement as a
GitHub issue; DSH agents plus a local orchestrator carry it through design,
implementation, independent verification, review, merge, release and a delivery
report.

```text
user ──issue (requirement form)──► GitHub
                                      │  labels: agent:ready
                                      ▼
                         orchestrator/cli.mjs watch
                             │                       │
                 dsh headless role agent          CI + process-guard
                 (implementer/verifier/reviewer)  (GitHub Actions)
                             │                       │
                             └────────► PR ◄─────────┘
                                          │
                       merge (release-manager) ──► tag ──► GitHub Release
                                          │
                                          ▼
                       delivery report comment on the issue
```

- **Process OS** — [`docs/process/00-OPERATING-MODEL.md`](docs/process/00-OPERATING-MODEL.md)
  defines gates G0–G7, the RACI matrix, the label state machine and the human
  escalation matrix. The other ten documents cover requirement intake,
  RFC/ADR, implementation, verification, review & merge, release, delivery
  reports, metrics, escalation and the local runtime.
- **Roles** — [`agents/roles/`](agents/roles/) holds eight six-section prompts
  (product-owner, pm, architect, implementer, verifier, reviewer,
  release-manager, scribe) that the runner loads **verbatim** before each
  execution.
- **Engine** — [`orchestrator/`](orchestrator/) is a zero-dependency Node CLI
  (`intake | deliver | verify | watch | status`). It creates an isolated git
  worktree per issue, runs the role prompt through `dsh headless`, executes the
  gates, opens the PR with an evidence table, and writes an auditable run log
  under `.agentspec/`. `--dry-run` and a mock runner make every step testable
  offline.
- **Gates in CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs
  exactly the commands a human would; [`process-guard.yml`](.github/workflows/process-guard.yml)
  rejects PRs without a linked issue, an evidence table or a Conventional
  Commit title.
- **Provisioning** — [`scripts/provision-github.sh`](scripts/provision-github.sh)
  applies labels, merge policy and branch protection so that the gates are
  enforced by GitHub rather than by convention.

The human only does three things: **write the issue, answer escalation
questions, accept the delivery**. The single-account mode (GitHub forbids
approving your own PR, and branch protection is unavailable on private
repositories of free plans) is handled explicitly in
[`docs/process/05-REVIEW-MERGE.md`](docs/process/05-REVIEW-MERGE.md) §4.

## 7. Repository layout

```text
mocl/
├── src/
│   ├── abi/          # ABI v0 types, constants, AJV runtime validation
│   ├── adapters/     # codex, claude-code, kimi, opencode
│   ├── broker/       # session registry, idempotency, concurrency, kill/recover
│   ├── bus/          # event bus, folding, ring buffer, parent delivery
│   ├── facade/       # backend-agnostic facade (config, errors, adapters)
│   └── plugin/       # thin DSH plugin: subagent_agent / mocl_status
├── schema/           # byte-identical copy of docs/abi/schema/*.json
├── fixtures/         # ABI contract fixtures (valid + invalid)
├── tests/            # unit / contract / e2e tests (vitest)
├── tools/            # validate-abi, sync-schema, check_docs, leak-scan, build-plugin
├── scripts/          # codex baseline assert/upgrade, DSH tool assertions
├── e2e/              # offline PR scenario (fake backend + worktree)
├── repro/            # read-only, zero-quota backend probes
├── patch/            # DSH patch files (enable plugin, disable legacy tools)
├── config.default.json / config.example.json
├── orchestrator/     # zero-dependency delivery engine (issue → agent → gates → PR)
├── agents/           # role prompts loaded by the runner + process self-check
├── docs/process/     # delivery process OS (G0–G7, roles, contracts, release)
├── .github/          # CI, PR contract gate, issue forms, labels, CODEOWNERS
├── vitest.config.mjs # vitest scope (the orchestrator suite runs on node:test)
└── docs/             # ABI, architecture, adapters, integration, research, ...
```

## 8. Documentation

| Document | What it covers |
|---|---|
| [`docs/index.md`](docs/index.md) | One-page entry point and reading paths |
| [`docs/abi/abi-v0.md`](docs/abi/abi-v0.md) | ABI v0: capability bits, methods, events, errors, idempotency, limits |
| [`docs/architecture/00-overview.md`](docs/architecture/00-overview.md) | Layering, decision DEC-1, deployment shapes |
| [`docs/architecture/01-layers.md`](docs/architecture/01-layers.md) | L0–L5 contracts, invariants, degradation |
| [`docs/architecture/02-state-machine.md`](docs/architecture/02-state-machine.md) | Session states, transitions, idempotency, cold recovery |
| [`docs/architecture/03-failure-modes.md`](docs/architecture/03-failure-modes.md) | Failure taxonomy, retries, degradation ladder |
| [`docs/adapters/`](docs/adapters/) | Per-backend L1 mappings (handshake, events, permissions, acceptance) |
| [`docs/research/capability-matrix.md`](docs/research/capability-matrix.md) | 4 × 15 capability matrix with evidence |
| [`docs/integration/`](docs/integration/) | DSH integration route, configuration, UI data plane |
| [`docs/risk/00-risk-register.md`](docs/risk/00-risk-register.md) | Risk register |
| [`docs/risk/01-threat-model.md`](docs/risk/01-threat-model.md) | Threat model (credentials, path traversal, sandbox, prompt injection, supply chain) |
| [`docs/test/01-acceptance.md`](docs/test/01-acceptance.md) | Acceptance matrix and commands |
| [`docs/process/`](docs/process/) | Delivery process OS: gates G0–G7, roles, issue/PR contracts, release, metrics |
| [`agents/README.md`](agents/README.md) | Role prompts loaded by the orchestrator, and the process self-check |
| [`orchestrator/README.md`](orchestrator/README.md) | Delivery engine CLI, exit codes, safety rails, troubleshooting |
| [`docs/runbook.md`](docs/runbook.md) | Operations runbook (codex baseline, plugin bootstrap, e2e) |

The documentation set is gate-checked by `tools/check_docs.py` (structure,
required sections, ABI counts, error-code vocabulary, resolvable relative
links). Design documents are Chinese; the README is bilingual.

## 9. Project status and known limitations

Verified in this repository (commands and exit codes are reproducible):

- ABI contract gate: 46 / 34 / 35 / 18 — `node tools/validate-abi.mjs`
- Schema copy gate: `node tools/sync-schema.mjs --check`
- Offline end-to-end scenario: `node e2e/pr-scenario.mjs` → `RESULT: PASS (offline)`

Known limitations (see [`CHANGELOG.md`](CHANGELOG.md)):

- `codex` live turns are environment-limited on the development machine; the
  live e2e run is recorded as `skipped:host-unavailable`.
- `kimi` live smoke consumes reserved quota; default probes are zero-quota and
  read-only.
- `opencode` paid-model credentials are expired; the adapter falls back to the
  free model pool (verified). A new key must be created in the OpenCode Console.
- The DSH host API baseline is **0.2.1-rc.3**; DSH upgrades require re-checking
  `src/plugin/dsh-types.d.ts` and the tool registration signature.
- The official DSH GUI shows external subagents as non-openable leaf rows; use
  `mocl_status` and the session journal for state/progress.
- No npm release; install by cloning this repository.

## 10. Contributing

Contributions are welcome. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Before opening a pull request run
the gates listed in section 4 (`typecheck`, `test`, `validate`, `sync-schema
--check`, `docs:check`, `leak-scan`) plus the engine and process gates:
`node --test orchestrator/test/`, `node agents/verify-agents.mjs` and
`node .github/scripts/verify-github-config.mjs`.

For security issues, do **not** open a public issue — see
[`SECURITY.md`](SECURITY.md).

## 11. License

[MIT](LICENSE) © 2026 lakii2982
