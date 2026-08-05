/**
 * husk-tui.ts — interactive shell over LandmarkOrchestrator
 *
 * Run:  SHARD_DIR=/path/to/shattered npx tsx src/husk-tui.ts
 *
 * Zero dependencies beyond Node builtins (airgap-friendly).
 *
 * Commands:
 *   :help                 show commands
 *   :mode retrieve|rag    switch between Faith-Less retrieval and RAG
 *   :threshold <0.0-1.0>  set query Hamming ratio gate (rebuilds index)
 *   :diagnostics          orchestrator diagnostics
 *   :reload               rebuild index from disk
 *   :quit                 exit
 * Anything else is treated as a query.
 */
import * as readline from "node:readline";
import { LandmarkOrchestrator } from "../../brain/landmark-orchestrator.js"; // FIX PATH

const SHARD_DIR = process.env.SHARD_DIR ?? "";

type Mode = "retrieve" | "rag";

interface Session {
  orch: LandmarkOrchestrator;
  mode: Mode;
  threshold?: number;
}

async function buildOrchestrator(threshold?: number): Promise<LandmarkOrchestrator> {
  const orch = new LandmarkOrchestrator({
    ...(SHARD_DIR ? { shardDir: SHARD_DIR } : {}),
    ...(threshold !== undefined ? { queryThreshold: threshold } : {}),
  });
  await orch.buildIndex();
  return orch;
}

// ─── Rendering ───────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const rule = () => dim("─".repeat(60));

function renderSilence(result: any): void {
  console.log("");
  console.log(yellow(bold("  ∅ SILENCE")));
  console.log(
    `  The vault contains no shard within the gate for this query.`
  );
  // If PATCHES.md fix #1 is applied, the closest miss rides in citations:
  if (result.citations?.length) {
    const c = result.citations[0];
    console.log(
      dim(`  Closest miss: ${c.shardId} @ Hamming ${c.hammingRatio.toFixed(4)}`)
    );
  }
  console.log(
    dim(`  Evaluated ${result.metrics.shardsEvaluated} shards in ${result.metrics.indexLookupMs}ms`)
  );
  console.log("");
}

function renderResult(result: any, mode: Mode): void {
  if (result.silenced) return renderSilence(result);

  console.log("");
  if (mode === "rag" && result.answer) {
    console.log(bold("  ANSWER (generated — verify against citations)"));
    console.log(rule());
    console.log(result.answer);
  } else {
    console.log(green(bold("  VERIFIED SOURCE MATERIAL (no generation)")));
    for (const src of result.sourceTexts) {
      console.log(rule());
      console.log(cyan(`  ${src.source} / ${src.shardId}`));
      console.log(src.fullText);
    }
  }
  console.log(rule());
  console.log(bold("  CITATIONS"));
  for (const c of result.citations) {
    console.log(
      `  ${c.shardId}  ${dim(`Hamming ${c.hammingRatio.toFixed(4)}`)}`
    );
  }
  console.log(
    dim(
      `  ${result.metrics.totalMs}ms total · ${result.metrics.shardsEvaluated} evaluated · ${result.metrics.shardsSelected} selected · ${result.metrics.cacheMisses} cache misses`
    )
  );
  console.log("");
}

// ─── Command loop ────────────────────────────────────────────────

const HELP = `
  ${bold("Commands")}
  :mode retrieve      Faith-Less pure retrieval (default)
  :mode rag           retrieve + local model inference
  :threshold <r>      query gate, Hamming ratio 0.0-1.0 (rebuilds index)
  :diagnostics        index/cache/threshold state
  :reload             rebuild index from disk
  :quit               exit
  Anything else is sent as a query.
`;

async function handleCommand(line: string, s: Session): Promise<Session> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "help":
      console.log(HELP);
      return s;
    case "mode": {
      const m = rest[0];
      if (m !== "retrieve" && m !== "rag") {
        console.log(yellow("  usage: :mode retrieve|rag"));
        return s;
      }
      console.log(dim(`  mode → ${m}`));
      return { ...s, mode: m };
    }
    case "threshold": {
      const t = Number(rest[0]);
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        console.log(yellow("  usage: :threshold 0.0-1.0 (Hamming ratio)"));
        return s;
      }
      console.log(dim(`  rebuilding with queryThreshold=${t} ...`));
      const orch = await buildOrchestrator(t);
      return { ...s, orch, threshold: t };
    }
    case "diagnostics":
      console.log(JSON.stringify(s.orch.diagnostics(), null, 2));
      return s;
    case "reload":
      console.log(dim("  rebuilding index ..."));
      return { ...s, orch: await buildOrchestrator(s.threshold) };
    case "quit":
    case "exit":
      process.exit(0);
    default:
      console.log(yellow(`  unknown command :${cmd} — try :help`));
      return s;
  }
}

async function main() {
  console.log(bold("\n  WHITE-GLOVE AGENT HUSK — interactive shell"));
  console.log(dim("  silence-first retrieval · :help for commands\n"));

  let session: Session = {
    orch: await buildOrchestrator(),
    mode: "retrieve",
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.setPrompt(
      dim(`[${session.mode}${session.threshold !== undefined ? ` @${session.threshold}` : ""}] `) + "❯ "
    );
    rl.prompt();
  };

  prompt();
  rl.on("line", async (raw: string) => {
    const line = raw.trim();
    if (!line) return prompt();
    try {
      if (line.startsWith(":")) {
        session = await handleCommand(line, session);
      } else {
        const result =
          session.mode === "rag"
            ? await session.orch.query(line)
            : await session.orch.retrieve(line);
        renderResult(result, session.mode);
      }
    } catch (err) {
      console.error(yellow(`  error: ${err instanceof Error ? err.message : err}`));
    }
    prompt();
  });

  rl.on("close", () => process.exit(0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
