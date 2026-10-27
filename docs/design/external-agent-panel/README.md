# External agent status panel (v1)

A MOCL-owned **client UI plugin** that renders the real runtime state of
codex / claude-code / kimi / opencode subagents inside the DSH Web GUI right
sidebar, without modifying any official DSH package.

Why it exists: the official subagent catalog shows external tasks as
non-navigable leaves **without** an execution status (see
[`docs/integration/02-ui-data-plane.md`](../../integration/02-ui-data-plane.md) §1),
so users had to query `mocl_status` or read files to know what a subagent was
doing. The panel closes that gap.

## Files

| File | Content |
|---|---|
| [`DESIGN.md`](DESIGN.md) | information architecture, component tree, four view states, token mapping, responsive rules, copy |
| [`STATES.md`](STATES.md) | the thirteen-step status precedence table (state / activation / turn.state) and its copy, icon and token per rule |
| [`prototype.html`](prototype.html) | self-contained offline prototype (four states, light/dark, 390/500/560 px) built only on official `--dsw-*` tokens |

## Data plane

The panel is a read-only view of the MOCL facade: `GET /mocl-panel/list`
returns the same `StatusOutcome[]` that `mocl_status` returns (single source of
truth, UI never derives state). `POST /mocl-panel/heartbeat` records mount and
row counts to `<journal.dir>/panel-heartbeat.json` so acceptance can be
machine-checked without screenshots. Refreshing is a 2 s poll that stops on tab
close; no sub-second polling.

## Verification

Acceptance assertions (AC1–AC8) live in the feature issue; the machine gates
are `pnpm typecheck`, `pnpm test`, `node tools/validate-abi.mjs`,
`pnpm docs:check`, `pnpm leak-scan`, plus the panel route parity check against
`MoclFacade.list()` and a headless-Chrome render of the panel in a scratch DSH
profile.
