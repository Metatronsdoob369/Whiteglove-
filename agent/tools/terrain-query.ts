/**
 * terrain_query — NAICS accessory wired (static 3-D pack via CLI).
 *
 * Pack-first query through spectral-terrain/scripts/query_naics.py.
 * Silence over fabrication when the industry map has no match.
 * Broader temporal terrain (3072-D) remains unwired here.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Tool } from "../types";

const QUERY_SCRIPT = join(
  homedir(),
  "spectral-terrain/scripts/query_naics.py"
);

function runNaics(args: string[]): Promise<{ code: number; json: unknown }> {
  return new Promise((resolve) => {
    const child = spawn("conda", ["run", "-n", "agents", "python", QUERY_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const resolveOnce = (value: { code: number; json: unknown }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const TIMEOUT_MS = 15_000;
    const tid = setTimeout(() => {
      child.kill("SIGKILL");
      resolveOnce({
        code: 1,
        json: { ok: false, silence: true, reason: `naics query timed out after ${TIMEOUT_MS}ms` },
      });
    }, TIMEOUT_MS);

    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });

    child.on("error", (e) => {
      clearTimeout(tid);
      resolveOnce({
        code: 1,
        json: { ok: false, silence: true, reason: `naics query spawn failed: ${e.message}` },
      });
    });

    child.on("close", (code) => {
      clearTimeout(tid);
      const raw = out.trim() || err.trim();
      try {
        resolveOnce({ code: code ?? 1, json: JSON.parse(raw) });
      } catch {
        resolveOnce({
          code: code ?? 1,
          json: { ok: false, silence: true, reason: raw || "naics query failed" },
        });
      }
    });
  });
}

export const terrainQueryTool: Tool<{ query: string }, unknown> = {
  name: "terrain_query",
  description:
    "Query the sealed NAICS 2022 industry terrain (3-D). Resolves industry labels to sectors or returns silence. Not for temporal 3072-D domains.",
  params: [
    {
      name: "query",
      type: "string",
      description: "Industry label, NAICS code, or free-text sector question",
      required: true
    }
  ],
  execute: async (input, _context) => {
    const q = (input?.query ?? "").trim();
    if (!q) {
      return { ok: false, error: "empty query" };
    }
    const { json } = await runNaics(["resolve", q]);
    const payload = json as { ok?: boolean; silence?: boolean; reason?: string };
    if (!payload?.ok || payload.silence) {
      return {
        ok: false,
        error: payload?.reason ?? "silence — no NAICS sector match",
        data: payload
      };
    }
    return { ok: true, data: payload };
  }
};
