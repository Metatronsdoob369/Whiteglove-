/**
 * SPECTRAL-TERRAIN — DOMAIN MANIFEST SCHEMA
 *
 * The one source of truth for how data flows through the refinery.
 * data type → processor → dimensionality → collection → receptacle.
 *
 * This schema IS the standardization. If an ingestion doesn't fit the
 * schema, it's not a valid pipeline — the config won't parse, and the
 * refinery refuses it rather than guessing. That refusal is the point:
 * it's how the vision stops fragmenting. An agent loads domains.config,
 * gets a validated map, and runs. No prose to re-read, no convincing.
 *
 * Author: Joe Wales / NODE OUT
 */

import { z } from "zod";

/**
 * The four geometries from TGIL_VISION. Each matches a data type whose
 * natural structure it encodes. Adding a fifth means adding it here
 * first — the schema forces the taxonomy to stay explicit.
 */
export const GeometryKind = z.enum([
  "temporal",     // sequence encodes causality: game state, mempool, liquidity
  "topological",  // settled vs contested regions: legal doctrine, medical corpus
  "fingerprint",  // similarity + silence-over-fabrication: repo husks
  "graph",        // entity relationships: property/financial records (GAT)
]);
export type GeometryKind = z.infer<typeof GeometryKind>;

/** The processors that live in the refinery. */
export const Processor = z.enum([
  "temporal-concat",   // engine/embed.ts — [v_t-1 | v_t | v_t+1]
  "laplacian-heatmap", // legal_heatmap.py — heat kernel diffusion
  "simhash-128",       // simhash-guard.ts — bitwise fingerprint index
  "eve-v2-gat",        // eve_v2.py — GAT + spectral over graphs
]);
export type Processor = z.infer<typeof Processor>;

/** Where refined product lands. */
export const StoreKind = z.enum([
  "qdrant",       // vector collection, cosine
  "faiss-pack",   // signed terrain pack, L2-to-centroid (Zone 2 kernel)
  "vault-index",  // vault/index.json — SimHash Hamming index
]);
export type StoreKind = z.infer<typeof StoreKind>;

/**
 * The retrieval signal the receptacle uses. Explicit because two
 * "vector" paths can differ here — cosine similarity vs. L2-distance-
 * to-centroid are NOT the same gate, and conflating them is exactly
 * the ambiguity that muddied the canonical docs.
 */
export const RetrievalSignal = z.enum([
  "cosine",            // similarity in vector space
  "l2-to-centroid",    // shatter score: distance from Diamond-Stable centroid
  "hamming",           // bitwise drift on SimHash signatures
  "knn-temporal",      // nearest neighbor in temporal-concat space
  "contract-schema",   // Zod schema-refusal: "if it ain't in the schema it ain't real"
  "none",              // pure consumer — silence delegated to an upstream receptacle
]);
export type RetrievalSignal = z.infer<typeof RetrievalSignal>;

/**
 * Silence policy — the Faith-Less guarantee, made per-domain because
 * the threshold semantics differ by signal. A hamming ratio of 0.35
 * and an L2 shatter of 0.15 are not comparable numbers; each domain
 * carries its own, with provenance.
 */
export const SilencePolicy = z.object({
  enabled: z.boolean(),
  signal: RetrievalSignal,
  /** The gate. Lower-is-closer for hamming/l2/cosine-distance. */
  threshold: z.number().min(0),
  /** Direction guard so no one misreads the threshold. */
  closerIs: z.enum(["lower", "higher"]),
  /** Where this number came from — refuses "magic constant" drift. */
  calibration: z.object({
    calibrated: z.boolean(),
    corpus: z.string().nullable(),
    corpusSize: z.number().int().positive().nullable(),
    date: z.string().nullable(),
    note: z.string().nullable(),
  }),
});
export type SilencePolicy = z.infer<typeof SilencePolicy>;

/**
 * Dimensionality carries a rationale, because "why this many dims" is
 * the hardest-won lesson on the project (over-embedding static data).
 * The schema makes you state it, so the mistake can't silently return.
 */
export const Dimensionality = z.object({
  dims: z.number().int().positive(),
  rationale: z.string().min(1),
  /** true only where sequence encodes causality (temporal path). */
  temporalAxis: z.boolean(),
});
export type Dimensionality = z.infer<typeof Dimensionality>;

/** A single pipeline: one data type, refined one way, served one way. */
export const DomainPipeline = z.object({
  /** Stable key an agent selects by, e.g. "legal-corpus". */
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  description: z.string().min(1),
  status: z.enum(["proven", "operational", "wiring", "planned"]),

  dataType: z.string().min(1),
  geometry: GeometryKind,
  processor: Processor,
  dimensionality: Dimensionality,

  store: z.object({
    kind: StoreKind,
    /** collection name / index path / pack id */
    location: z.string().min(1),
    /** embedding model if the store needs one; null for simhash/faiss-fingerprint */
    embedModel: z.string().nullable(),
    /**
     * WIRE (folded from v2 pipeline.json). The reachable endpoint of the
     * store. null when the store is a local file (vault-index, faiss-pack).
     * Example: "http://100.113.215.46:6333" for a Qdrant collection.
     * This is infra fact — only Joe can verify it.
     */
    endpoint: z.string().url().nullable().optional(),
    /**
     * WIRE. Vector distance metric the store is configured with, if it's a
     * vector store. Distinct from silence.signal: this is how the STORE
     * indexes, silence.signal is how the RECEPTACLE gates. They usually
     * agree, but recording both catches the case where they don't.
     */
    distanceMetric: z.enum(["cosine", "dot", "euclid"]).nullable().optional(),
  }),

  /**
   * WIRE (folded from v2). How this pipeline's corpus is (re)built. Lets an
   * agent regenerate a collection without hunting for the script — and is
   * exactly what the three HOT pipelines need pointed at a low-D re-ingest.
   */
  ingest: z
    .object({
      /** script/command that ingests this domain, e.g. "scripts/ingest-finance-heatmap.ts" */
      script: z.string().min(1),
      /** processor/refinery entrypoint if different from the script */
      refineryStage: z.string().nullable(),
    })
    .optional(),

  /** The vehicle built to run on this fuel. */
  receptacle: z.object({
    /** what consumes it: a query entrypoint, an MCP, an A2A endpoint */
    kind: z.enum(["cli-query", "http-service", "mcp", "a2a", "harness-tui"]),
    /** path or URL — where the receptacle lives */
    ref: z.string().min(1),
    /**
     * WIRE (folded from v2). Named tools/endpoints this receptacle exposes,
     * e.g. ["consult_statute","verify_negotiability"] for ArbiterOS, or
     * ["/health","/api/legal/query"] for LawLibra. Omitted = not yet folded
     * from v2 (distinct from [] which means "confirmed none").
     */
    tools: z.array(z.string()).optional(),
  }),

  silence: SilencePolicy,

  /**
   * When what's RUNNING differs from what's INTENDED, record both instead
   * of picking one. This is the anti-fragmentation field: it stops the
   * next agent from "resolving" a conflict by guessing. Populated only
   * where a live artifact (test, payload, running service) contradicts
   * the design intent.
   */
  liveVsTarget: z
    .object({
      live: z.string().min(1),   // what a real artifact proves is running now
      target: z.string().min(1), // what the design intends
      evidence: z.string().min(1), // the artifact that proves 'live'
      resolved: z.boolean(),
    })
    .optional(),

  /** free-form provenance so an agent knows how alive this path is */
  notes: z.string().optional(),
});
export type DomainPipeline = z.infer<typeof DomainPipeline>;

/** The manifest: every pipeline, plus top-level metadata. */
export const DomainManifest = z.object({
  manifestVersion: z.literal("1.0"),
  refinery: z.string().min(1),
  updated: z.string().min(1),
  /** The invariant that defines the whole system, stated once. */
  principle: z.string().min(1),
  /**
   * The dimensionality rule, machine-checkable. 3072-D is reserved for
   * the temporal/causal path; static data uses the lowest dims that
   * still route correctly through the heat mapper. Encoded so an agent
   * can enforce it, not just read it.
   */
  dimensionPolicy: z.object({
    rule: z.string().min(1),
    maxStaticDims: z.number().int().positive(),
    temporalDims: z.number().int().positive(),
  }),
  pipelines: z.array(DomainPipeline).min(1),
});
export type DomainManifest = z.infer<typeof DomainManifest>;

/**
 * Enforce the dimension policy: any static (non-temporal) pipeline above
 * maxStaticDims is a violation. Returns the offenders rather than
 * throwing, so an agent can report "running hot" without refusing to load.
 */
export function auditDimensions(m: DomainManifest): Array<{ id: string; dims: number; reason: string }> {
  const out: Array<{ id: string; dims: number; reason: string }> = [];
  for (const p of m.pipelines) {
    if (!p.dimensionality.temporalAxis && p.dimensionality.dims > m.dimensionPolicy.maxStaticDims) {
      out.push({
        id: p.id,
        dims: p.dimensionality.dims,
        reason: `static pipeline at ${p.dimensionality.dims}-D exceeds maxStaticDims ${m.dimensionPolicy.maxStaticDims}`,
      });
    }
  }
  return out;
}

/**
 * Parse + validate a manifest object. Throws a readable error if any
 * pipeline is malformed — that throw is the refinery refusing bad fuel.
 */
export function parseManifest(raw: unknown): DomainManifest {
  return DomainManifest.parse(raw);
}

/** Look up one pipeline by id, or throw with the list of valid ids. */
export function selectPipeline(m: DomainManifest, id: string): DomainPipeline {
  const hit = m.pipelines.find((p) => p.id === id);
  if (!hit) {
    const ids = m.pipelines.map((p) => p.id).join(", ");
    throw new Error(`No pipeline "${id}". Known: ${ids}`);
  }
  return hit;
}
