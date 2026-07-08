import { readFileSync } from "node:fs";
import type { EvalQuery } from "./types.js";

/**
 * Loads a JSONL query set. One EvalQuery per line.
 * Fails loudly on malformed lines — a silent skip here would
 * quietly bias the benchmark.
 */
export function loadQueries(path: string): EvalQuery[] {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line, i) => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON`);
    }
    const q = obj as Partial<EvalQuery>;
    if (!q.id || !q.text || !q.class) {
      throw new Error(`${path}:${i + 1} missing id/text/class`);
    }
    if (q.class === "grounded" && (!q.expectedEvidence || q.expectedEvidence.length === 0)) {
      throw new Error(
        `${path}:${i + 1} grounded query "${q.id}" has no expectedEvidence — cannot be scored offline`
      );
    }
    return q as EvalQuery;
  });
}
