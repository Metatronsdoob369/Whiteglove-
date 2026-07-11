/**
 * pattern_scan — STUB (not wired)
 *
 * Placeholder so the repo typechecks: `tool-registry.ts` imports this module,
 * but the real implementation lives in the uncommitted spectral-terrain WIP
 * (`husk-production-scaffold/`). When that lands, it replaces this file
 * wholesale — same path, same export name.
 *
 * No role contract allows "pattern_scan" yet, so nothing can invoke it; if
 * something does anyway, it fails closed with an honest error rather than
 * fabricating scan results.
 */

import type { Tool } from "../types";

export const patternScanTool: Tool<{ pattern: string }, unknown> = {
  name: "pattern_scan",
  description:
    "Scan the spectral terrain for a pattern (NOT WIRED — awaiting the spectral-terrain implementation from husk-production-scaffold)",
  params: [
    { name: "pattern", type: "string", description: "The pattern to scan for", required: true }
  ],
  execute: async (_input, _context) => {
    return {
      ok: false,
      error:
        "pattern_scan is not wired yet: the spectral-terrain implementation has not landed in this repo. Silence over fabrication."
    };
  }
};
