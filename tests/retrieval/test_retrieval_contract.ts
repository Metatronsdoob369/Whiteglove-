import path from "path";
import { strict as assert } from "assert";
import { LandmarkOrchestrator, type QueryResult } from "../../brain/landmark-orchestrator";

function assertSilenced(result: QueryResult): void {
  assert.equal(result.mode, "retrieve", "expected retrieve mode");
  assert.equal(result.silenced, true, "expected silenced=true on no-match query");
  assert.equal(result.answer, null, "retrieve mode answer must be null");
  assert.equal(result.citations.length, 0, "no-match should return zero citations");
  assert.equal(result.sourceTexts.length, 0, "no-match should return zero source texts");
}

function assertHit(result: QueryResult): void {
  assert.equal(result.mode, "retrieve", "expected retrieve mode");
  assert.equal(result.silenced, false, "expected silenced=false on known-hit query");
  assert.ok(result.citations.length >= 1, "known-hit should return at least one citation");
  assert.ok(result.sourceTexts.length >= 1, "known-hit should return at least one source text");

  const topCitation = result.citations[0];
  assert.equal(topCitation.shardId, "shard_alpha", "expected top citation to be shard_alpha");

  const sourceShard = result.sourceTexts.find((s) => s.shardId === "shard_alpha");
  assert.ok(sourceShard, "expected shard_alpha full text in sourceTexts");
  assert.match(
    sourceShard!.fullText,
    /two signatures for legal escrow release/i,
    "expected exact source phrase in retrieved text"
  );
}

async function main(): Promise<void> {
  const fixtureDir = path.resolve(__dirname, "fixtures");

  const orchestrator = new LandmarkOrchestrator({
    shardDir: fixtureDir,
    // Contract setting for deterministic CI behavior:
    // only exact SimHash matches are stable (hammingRatio must be 0.0).
    queryThreshold: 0,
    maxContextShards: 1,
  });

  await orchestrator.buildIndex();

  const noMatchQuery = "completely unrelated nebula harmonics with zero overlap";
  const noMatchResult = await orchestrator.retrieve(noMatchQuery);
  assertSilenced(noMatchResult);

  const hitQuery = "Alpha protocol requires two signatures for legal escrow release and explicit written consent from both parties.";
  const hitResult = await orchestrator.retrieve(hitQuery);
  assertHit(hitResult);

  console.log("Retrieval contract checks passed.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
