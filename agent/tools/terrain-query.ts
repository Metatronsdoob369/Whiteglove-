/**
 * terrain_query — STUB (not wired)
 *
 * Placeholder so the repo typechecks: `tool-registry.ts` imports this module,
 * but the real implementation lives in the uncommitted spectral-terrain WIP
 * (`husk-production-scaffold/`). When that lands, it replaces this file
 * wholesale — same path, same export name.
 *
 * No role contract allows "terrain_query" yet, so nothing can invoke it; if
 * something does anyway, it fails closed with an honest error rather than
 * fabricating terrain results.
 */

import type { Tool } from "../types";

export const terrainQueryTool: Tool<{ query: string }, unknown> = {
  name: "terrain_query",
  description:
    "Query the spectral-terrain heatmap (NOT WIRED — awaiting the spectral-terrain implementation from husk-production-scaffold)",
  params: [
    { name: "query", type: "string", description: "The terrain query", required: true }
  ],
  execute: async (_input, _context) => {
    return {
      ok: false,
      error:
        "terrain_query is not wired yet: the spectral-terrain implementation has not landed in this repo. Silence over fabrication."
    };
  }
};
