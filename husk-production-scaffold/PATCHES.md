# Suggested one-line patches to landmark-orchestrator.ts

## 1. Best score on silence (unlocks the sweep curve)

In retrieve(), the silenced return currently reports no distance.
`ranked` is already sorted; add the closest failed match:

```ts
if (selected.length === 0) {
  return {
    answer: null,
    citations: ranked[0] ? [{
      shardId: ranked[0].entry.shardId,
      source: ranked[0].entry.source,
      hammingRatio: ranked[0].drift.hammingRatio,   // <-- closest miss
      contentPreview: ranked[0].entry.contentPreview
    }] : [],
    ...
```

Then in the adapter's silenced branch, read bestScore from that citation.

## 2. Salt alignment (the substantive fix)

buildIndex() signs shards with schema = shard.source; retrieve() signs
the query with schema = "query_". Different schema → different BLAKE/FNV
salt → uncorrelated signatures, so query-shard Hamming is ~random and
the 0.45 gate passes ~10-15% of shards by chance.

Fix: one corpus-wide schema for all retrieval signatures:

```ts
// buildIndex():
const signature = this.guard.simHash128FromText(shard.content, "corpus");
// retrieve():
const querySignature = this.guard.simHash128FromText(question, "corpus");
```

Keep per-source schemas only where you compare shard-to-shard within
the same source (the drift guard use case). After this change,
re-calibrate: expect genuinely-related query-shard pairs well below
0.45 and unrelated ones near 0.5, i.e. actual separation to gate on.
Run the harness before and after — the before/after table is itself
good launch material.
