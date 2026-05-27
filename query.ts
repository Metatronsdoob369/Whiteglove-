/**
 * WHITE-GLOVE AGENT HUSK: CLI ENTRY POINT
 * 
 * Usage:
 *   ts-node query.ts "What is machine learning?"        # Faith-Less retrieve (default)
 *   ts-node query.ts --rag "What is machine learning?"   # RAG mode (requires Q4+ model)
 *   ts-node query.ts --index-only
 *   ts-node query.ts --diagnostics
 */

import { LandmarkOrchestrator } from "./brain/landmark-orchestrator";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log('  ts-node query.ts "your question here"        # Pure retrieval (Faith-Less)');
    console.log('  ts-node query.ts --rag "your question here"   # RAG mode (requires Q4+ model)');
    console.log("  ts-node query.ts --index-only");
    console.log("  ts-node query.ts --diagnostics");
    process.exit(0);
  }

  const orchestrator = new LandmarkOrchestrator();

  if (args[0] === "--index-only") {
    await orchestrator.buildIndex();
    console.log("\n Diagnostics:", orchestrator.diagnostics());
    process.exit(0);
  }

  if (args[0] === "--diagnostics") {
    await orchestrator.buildIndex();
    console.log("\n Diagnostics:", JSON.stringify(orchestrator.diagnostics(), null, 2));
    process.exit(0);
  }

  // Determine mode
  const ragMode = args[0] === "--rag";
  const question = ragMode ? args.slice(1).join(" ") : args.join(" ");

  if (!question) {
    console.log("Error: No question provided.");
    process.exit(1);
  }

  console.log(`\n Query: "${question}"`);
  console.log(` Mode: ${ragMode ? "RAG (retrieve + infer)" : "FAITH-LESS (pure retrieval)"}\n`);

  const result = ragMode
    ? await orchestrator.query(question)
    : await orchestrator.retrieve(question);

  if (result.silenced) {
    console.log(" [FAITH-LESS] No relevant shards found. Agent remains silent.");
    console.log(`   Shards evaluated: ${result.metrics.shardsEvaluated}`);
    console.log(`   Index lookup: ${result.metrics.indexLookupMs}ms`);
    return;
  }

  console.log("═══════════════════════════════════════════════════");

  if (result.mode === "retrieve") {
    console.log("  VERIFIED SOURCE MATERIAL");
    console.log("═══════════════════════════════════════════════════");
    for (const src of result.sourceTexts) {
      console.log(`\n [${src.source} / ${src.shardId}]`);
      console.log("─".repeat(50));
      console.log(src.fullText);
    }
  } else {
    console.log("  GENERATED ANSWER");
    console.log("═══════════════════════════════════════════════════");
    console.log(result.answer);
  }

  console.log("\n───────────────────────────────────────────────────");
  console.log("  CITATIONS");
  console.log("───────────────────────────────────────────────────");
  for (const cite of result.citations) {
    console.log(`   ${cite.shardId} (${cite.source})`);
    console.log(`     Hamming: ${cite.hammingRatio.toFixed(4)}`);
    console.log(`     Preview: ${cite.contentPreview.slice(0, 80)}...`);
    console.log("");
  }
  console.log("───────────────────────────────────────────────────");
  console.log("  METRICS");
  console.log("───────────────────────────────────────────────────");
  console.log(`  Mode:             ${result.mode}`);
  console.log(`  Index lookup:     ${result.metrics.indexLookupMs}ms`);
  if (result.metrics.inferenceMs > 0) {
    console.log(`  Inference:        ${result.metrics.inferenceMs}ms`);
  }
  console.log(`  Total:            ${result.metrics.totalMs}ms`);
  console.log(`  Shards evaluated: ${result.metrics.shardsEvaluated}`);
  console.log(`  Shards selected:  ${result.metrics.shardsSelected}`);
  console.log(`  Cache misses:     ${result.metrics.cacheMisses}`);
  console.log("═══════════════════════════════════════════════════");
}

main().catch(console.error);
