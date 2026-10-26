/** Absolute locations of the orchestrator's own assets (gates file, templates). */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const ORCHESTRATOR_ROOT = resolve(LIB_DIR, "..");
export const TEMPLATES_DIR = join(ORCHESTRATOR_ROOT, "templates");
export const DEFAULT_GATES_FILE = join(ORCHESTRATOR_ROOT, "gates.default.json");
