/**
 * Directory entry shim.
 *
 * Node 24 no longer expands a positional directory for `node --test` (it tries
 * to load the directory as a module). The contracted command is
 * `node --test orchestrator/test/`, so this file — resolved as the directory's
 * `index.js` — imports every test module. Equivalent to running each
 * `*.test.mjs` explicitly.
 *
 * Adding a test file? Import it here too (or run `node --test orchestrator/test/*.test.mjs`).
 */

import "./dry-run.test.mjs";
import "./idempotency.test.mjs";
import "./retry-blocked.test.mjs";
import "./watch.test.mjs";
import "./prbody.test.mjs";
import "./runner-cmd.test.mjs";
import "./labels.test.mjs";
import "./exit-codes.test.mjs";
