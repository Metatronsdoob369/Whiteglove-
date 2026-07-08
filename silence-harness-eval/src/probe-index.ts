import { LandmarkOrchestrator } from "../../brain/landmark-orchestrator.js";

const orch = new LandmarkOrchestrator({
  shardDir: process.env.SHARD_DIR ?? "",
});

async function main(): Promise<void> {
  await orch.buildIndex();
  const result = await orch.retrieve("What does the LFU shard cache do when capacity is exceeded?");
  console.log("silenced:", result.silenced);
  console.log("citations:", result.citations.map((c) => `${c.shardId} @ ${c.hammingRatio.toFixed(4)}`));
  console.log("shardsEvaluated:", result.metrics.shardsEvaluated);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
