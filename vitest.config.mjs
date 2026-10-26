import { defineConfig } from "vitest/config";

// Vitest only owns the TypeScript contract/unit suite under `tests/`.
// The delivery engine under `orchestrator/` uses the built-in `node:test`
// runner (see `.github/workflows/ci.yml` and `node --test orchestrator/test/`),
// so it must not be collected here — the two runners cannot share a suite.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "orchestrator/**"],
    passWithNoTests: false,
  },
});
