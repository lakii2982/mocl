# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

MOCL is pre-1.0. Security fixes are applied to the latest `0.1.x` line on the
default branch.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Please report vulnerabilities through GitHub's private vulnerability reporting
for this repository (Security tab → "Report a vulnerability"), or by contacting
the maintainer (`@lakii2982`) privately on GitHub. Include:

- affected version/commit and backend (codex, claude-code, kimi, opencode, or core);
- a minimal reproduction (command or script) and the observed impact;
- whether the issue involves credentials, sandbox/permission bypass, path
  traversal, prompt injection, or supply chain.

We aim to acknowledge reports within 5 business days and to publish a fix or a
mitigation plan as soon as practical. Please give us a reasonable window to
address the issue before any public disclosure.

## Scope

MOCL is a compatibility layer that drives locally installed backend agents. In
scope:

- credential leakage (tokens/keys printed to stdout, logs, events or error
  payloads; secrets written into session journals);
- permission/sandbox escape: a delegated subagent performing writes while the
  configured profile is `read-only`, or bypassing the four fail-closed defaults
  (`enabled=false`, `permissionMode=read-only`, `allowDangerousModes=false`,
  `worktreeIsolation=required-for-write`);
- path traversal through session ids, worktree roots or binary paths;
- prompt-injection driven privilege escalation between parent and subagent;
- supply-chain issues in dependencies or in the plugin packaging pipeline.

Out of scope: vulnerabilities in the third-party backends themselves (report
those upstream), and issues that require the operator to explicitly enable
dangerous modes.

## Security design notes

- Fail-closed defaults: the shipped `config.default.json` and
  `config.example.json` keep every backend disabled, read-only permission,
  dangerous modes disallowed and worktree isolation required for writes.
- Credentials are never committed. Adapters forward backend environment
  variables only through an explicit allowlist; probe scripts print key names
  and existence flags, never values.
- Before publishing, run the repository leak gate:

  ```bash
  node tools/leak-scan.mjs
  ```

  It scans every git-tracked file for personal absolute paths, common token
  shapes and internal working-ledger references, and exits non-zero on a hit.

## Disclosure

Security-relevant changes are noted in `CHANGELOG.md` under the `Security`
heading once a fix is available. Credit is given to reporters unless they ask
to remain anonymous.
