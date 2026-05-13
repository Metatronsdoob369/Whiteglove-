/**
 * WHITEGOLVE AGENT FRAMEWORK — Entry Point
 *
 * Usage:
 *   ts-node agent/index.ts "What are the symptoms of anaphylaxis?"
 *   ts-node agent/index.ts --role medical "What is the dose for epinephrine?"
 *   ts-node agent/index.ts --list-roles
 *   ts-node agent/index.ts --list-tools
 */

import { AgentLoop } from "./loop/agent-loop";
import { buildDefaultRegistry } from "./tool-registry";
import { MedicalRole } from "./roles";
import type { RoleContract } from "./types";

const ROLES: Record<string, RoleContract> = {
  medical: MedicalRole
};

const DEFAULT_ROLE = "medical";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log(`
WhiteGlove Agent Framework

Usage:
  ts-node agent/index.ts "your question"
  ts-node agent/index.ts --role <role> "your question"
  ts-node agent/index.ts --list-roles
  ts-node agent/index.ts --list-tools

Roles:
${Object.keys(ROLES).map(r => `  ${r}`).join("\n")}
`);
    process.exit(0);
  }

  if (args[0] === "--list-roles") {
    console.log("\nAvailable roles:");
    for (const [id, role] of Object.entries(ROLES)) {
      console.log(`  ${id.padEnd(20)} ${role.name} [${role.sector}] — ${role.silencePolicy} silence`);
    }
    process.exit(0);
  }

  const registry = buildDefaultRegistry();

  if (args[0] === "--list-tools") {
    console.log("\nRegistered tools:");
    registry.list().forEach(t => console.log(`  ${t}`));
    process.exit(0);
  }

  // Parse role flag
  let roleId = DEFAULT_ROLE;
  let questionArgs = args;

  if (args[0] === "--role") {
    roleId = args[1];
    questionArgs = args.slice(2);
  }

  const role = ROLES[roleId];
  if (!role) {
    console.error(`Unknown role: "${roleId}". Run --list-roles to see options.`);
    process.exit(1);
  }

  const question = questionArgs.join(" ");
  if (!question) {
    console.error("No question provided.");
    process.exit(1);
  }

  console.log(`\n🧠 Role:    ${role.name} [${role.sector}]`);
  console.log(`🔍 Query:   "${question}"`);
  console.log(`🔒 Silence: ${role.silencePolicy}\n`);

  const loop = new AgentLoop(registry);
  console.log("⏳ Initializing vault index...");
  await loop.init();

  console.log("💬 Running agent...\n");
  const result = await loop.run(question, role);

  console.log("═".repeat(60));

  if (result.silenced) {
    console.log("🔇 SILENCED — No verified information found in vault.");
    console.log("   The agent stays silent rather than fabricate an answer.");
  } else {
    console.log("  RESPONSE");
    console.log("═".repeat(60));
    console.log(result.finalResponse);
    console.log("\n" + "─".repeat(60));
    console.log("  CITATIONS");
    console.log("─".repeat(60));
    const retrieveStep = result.steps.find(s => s.type === "retrieve");
    if (retrieveStep?.citations) {
      for (const c of retrieveStep.citations) {
        console.log(`  📄 ${c.shardId} (${c.source})`);
        console.log(`     Hamming: ${c.hammingRatio.toFixed(4)}`);
        console.log(`     ${c.preview.slice(0, 80)}...`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log("  METRICS");
  console.log("─".repeat(60));
  console.log(`  Session:  ${result.sessionId}`);
  console.log(`  Role:     ${result.role}`);
  console.log(`  Steps:    ${result.steps.length}`);
  console.log(`  Total:    ${result.totalMs}ms`);
  console.log("═".repeat(60));
}

main().catch(console.error);
