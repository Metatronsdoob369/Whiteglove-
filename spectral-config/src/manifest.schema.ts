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
 * The geometries from TGIL_VISION. Each matches a data type whose
 * natural structure it encodes. Adding another means adding it here
 * first — the schema forces the taxonomy to stay explicit.
 */
export const GeometryKind = z.enum([
  "temporal",       // sequence encodes causality: game state, mempool, liquidity
  "topological",    // settled vs contested regions: legal doctrine, medical corpus
  "fingerprint",    // similarity + silence-over-fabrication: repo husks
  "graph",          // entity relationships: property/financial records (GAT)
  "static-heatmap", // sealed taxonomy, no drift and no re-embed: NAICS sectors
]);
export type GeometryKind = z.infer<typeof GeometryKind>;

/** The processors that live in the refinery. */
export const Processor = z.enum([
  "temporal-concat",    // engine/embed.ts — [v_t-1 | v_t | v_t+1]
  "laplacian-heatmap",  // legal_heatmap.py — heat kernel diffusion
  "simhash-128",        // simhash-guard.ts — bitwise fingerprint index
  "eve-v2-gat",         // eve_v2.py — GAT + spectral over graphs
  "industry-signal-pca", // build_naics_3d_pack.py — 20-D fingerprint → PCA-3 display
  "terrain-tile-seal",  // tile.schema.ts — working tiles in, sealed tiles + pack out
]);
export type Processor = z.infer<typeof Processor>;

/** Where refined product lands. */
export const StoreKind = z.enum([
  "qdrant",           // vector collection, cosine
  "faiss-pack",       // signed terrain pack, L2-to-centroid (Zone 2 kernel)
  "vault-index",      // vault/index.json — SimHash Hamming index
  "sealed-tile-pack", // content-addressed signed tiles + merkle manifest (terrain-pack-v1)
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
  "title-overlap-or-code", // sealed taxonomy: label overlap, or an exact code hit
  "content-address",   // exact cid match; silence = 404 on unknown cid
  "none",              // pure consumer — silence delegated to an upstream receptacle
]);
export type RetrievalSignal = z.infer<typeof RetrievalSignal>;

/**
 * Silence policy — the Faith-Less guarantee, made per-domain because
 * the threshold semantics differ by signal. A hamming ratio of 0.35
 * and an L2 shatter of 0.15 are not comparable numbers; each domain
 * carries its own, with provenance.
 */
export const SilencePolicy = z
  .object({
    enabled: z.boolean(),
    /**
     * Gate discriminant. Absent means "threshold" (every pre-existing
     * pipeline). Non-threshold gates (content-address exact match, Zod
     * schema refusal) have NO distance — for those, threshold/closerIs
     * must be ABSENT rather than a placeholder 0, which is exactly the
     * "magic constant wearing a value's clothes" this schema refuses.
     */
    gate: z.enum(["threshold", "exact-match", "schema-refusal"]).optional(),
    signal: RetrievalSignal,
    /** The gate value. Lower-is-closer for hamming/l2/cosine-distance. */
    threshold: z.number().min(0).optional(),
    /** Direction guard so no one misreads the threshold. */
    closerIs: z.enum(["lower", "higher"]).optional(),
    /** Where this number came from — refuses "magic constant" drift. */
    calibration: z.object({
      calibrated: z.boolean(),
      corpus: z.string().nullable(),
      corpusSize: z.number().int().positive().nullable(),
      date: z.string().nullable(),
      note: z.string().nullable(),
    }),
  })
  .superRefine((s, ctx) => {
    const gate = s.gate ?? "threshold";
    if (gate === "threshold") {
      if (s.threshold === undefined || s.closerIs === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "threshold gate requires threshold and closerIs",
        });
      }
    } else if (s.threshold !== undefined || s.closerIs !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${gate} gate has no distance — threshold/closerIs must be absent, not zero`,
      });
    }
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

/**
 * Local logical name — resolved by the consumer from its own config.
 * NEVER a URL: a reference the signed document controls is a document
 * vouching for its own authority (the public_key_ref-as-URL defect).
 */
const logicalRef = z
  .string()
  .min(1)
  .refine((s) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(s), "logical name, not a URL");

/**
 * Commercial mount declaration for the x402 kernel. The kernel never reads
 * this at runtime — codegen (generate:all) turns it into x402-routes.json
 * and friends, and the kernel boots from those generated artifacts only.
 * Spec: docs/superpowers/specs/2026-08-05-x402-mount-kernel-design.md
 */
export const CommercialBlock = z.object({
  sold: z.boolean(),
  unit: z.enum(["pack", "tile"]),
  edition: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  /**
   * Full enum kept deliberately so the kernel's startup refusal of
   * non-read_only mounts is TESTABLE (child doc: "kernel rejects startup").
   * The manifest-level refusal below makes it unrepresentable in a shipped
   * config; the kernel re-asserts at boot.
   */
  effect: z.enum(["read_only", "state_changing", "irreversible"]),
  replaySafe: z.boolean(),
  capabilityVersion: z.string().min(1),
  operations: z
    .array(
      z.object({
        operationId: z.string().regex(/^[a-z][a-z0-9_]*$/),
        resultKind: z.enum(["pack-bytes", "manifest-json", "proof-json"]),
        deadlineMs: z.number().int().positive().max(1000),
        maxResultBytes: z.number().int().positive(),
        /** price per call in atomic units of price.asset, decimal-integer string */
        priceAtomic: z.string().regex(/^[1-9][0-9]*$/),
      })
    )
    .min(1),
  substrate: z.object({
    kind: z.literal("sealed-pack"),
    /** logical pack name resolved by the kernel's SubstrateRegistry */
    packRef: logicalRef,
    trustStoreRef: logicalRef,
    statusListRef: logicalRef,
    geometryProfile: z.enum(["transition-only", "full-concat"]),
  }),
  price: z.object({
    scheme: z.literal("exact"), // batch/auth-capture/upto refused by construction
    networks: z.array(z.string().regex(/^eip155:[0-9]+$/)).min(1),
    asset: z.string().min(1),
    /** logical name resolved from the runtime secret store — never a literal address */
    payToRef: logicalRef,
  }),
  challengeEpoch: z.string().min(1),
  retryEntitlementSeconds: z.number().int().positive(),
  resultRetentionSeconds: z.number().int().positive(),
  fingerprintVersion: z.string().min(1),
  limits: z.object({
    maxPricePerCallAtomic: z.string().regex(/^[1-9][0-9]*$/),
    dailySettledValueCeilingAtomic: z.string().regex(/^[1-9][0-9]*$/),
  }),
  licenseGate: z.object({
    denyLicenses: z.array(z.string()).min(1),
    forbiddenKeysVersion: z.literal("SEALED_FORBIDDEN_KEYS@1"),
    commitmentKeyId: z.string().min(1),
  }),
  compensation: z.object({
    entitlementExtension: z.boolean(),
    makeGood: z.boolean(),
    onchainRefund: z.literal(false), // Phase 1 has no onchain refund; say so machine-readably
    policyRef: logicalRef,
    disputeChannel: z.string().min(1),
  }),
});
export type CommercialBlock = z.infer<typeof CommercialBlock>;

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

  /**
   * Secondary store for dual-store pipelines. Canonical store lives in
   * `store`; if a mirror/backup/local-fast-path also exists, record it
   * here so agents know both exist without guessing which is primary.
   */
  secondaryStore: z
    .object({
      kind: StoreKind,
      location: z.string().min(1),
      embedModel: z.string().nullable(),
      role: z.string().min(1), // e.g. "local-fast-path", "backup", "mirror"
    })
    .optional(),

  /**
   * Distinguishes test-fixture data from production corpora. Pipelines
   * whose data exists only to validate the mapping process — not as
   * canonical domain knowledge — are marked here so no agent mistakes
   * a validation artifact for a shipping corpus.
   */
  provenance: z
    .enum([
      "production",            // canonical domain corpus, ships
      "pipeline-test-fixture", // data run to validate the mapping, not the domain
    ])
    .optional(),

  /** free-form provenance so an agent knows how alive this path is */
  notes: z.string().optional(),

  /**
   * Distribution posture — orthogonal to `provenance` (data origin).
   * Absent means internal-only. "sealed-paid" without a `commercial`
   * block is refused at manifest level: no selling without a declared gate.
   */
  distribution: z.enum(["internal-only", "sealed-public", "sealed-paid"]).optional(),

  /** Commercial mount declaration — consumed by codegen into x402 artifacts. */
  commercial: CommercialBlock.optional(),
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
}).superRefine((m, ctx) => {
  // L1 commercial refusals — fire only where a pipeline declares commerce.
  // A config that fails here is not a valid manifest; the refinery refuses
  // it rather than guessing (the founding rule of this file).
  m.pipelines.forEach((p, i) => {
    const at = (field: string) => ["pipelines", i, ...field.split(".")];
    if (p.distribution === "sealed-paid" && !p.commercial) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("distribution"),
        message: `"${p.id}": sealed-paid without a commercial block — no selling without a declared gate`,
      });
    }
    const c = p.commercial;
    if (!c) return;
    if (c.effect !== "read_only") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("commercial.effect"),
        message: `"${p.id}": payment alone can never authorize state-changing or irreversible work`,
      });
    }
    if (c.replaySafe !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("commercial.replaySafe"),
        message: `"${p.id}": a paid mount must be replay-safe — the same payment retried returns identical bytes`,
      });
    }
    if (c.substrate.geometryProfile === "full-concat") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("commercial.substrate.geometryProfile"),
        message: `"${p.id}": full-concat ships raw embeddings of third-party source — refused in Phase 1`,
      });
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(c.price.payToRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("commercial.price.payToRef"),
        message: `"${p.id}": payToRef is a logical name resolved from the secret store, never a literal address`,
      });
    }
    // Dimensionality is a property of input style, frozen at the paid
    // boundary (locked 2026-08-05). Non-commercial pipelines get the soft
    // auditDimensions flag; paid mounts get refusal.
    const d = p.dimensionality;
    if (d.temporalAxis && d.dims !== m.dimensionPolicy.temporalDims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("dimensionality.dims"),
        message: `"${p.id}": paid temporal mount must be ${m.dimensionPolicy.temporalDims}-D`,
      });
    }
    if (!d.temporalAxis && d.dims > m.dimensionPolicy.maxStaticDims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("dimensionality.dims"),
        message: `"${p.id}": paid static mount above maxStaticDims ${m.dimensionPolicy.maxStaticDims}`,
      });
    }
    if (c.limits && BigInt(c.limits.maxPricePerCallAtomic) > BigInt(c.limits.dailySettledValueCeilingAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("commercial.limits"),
        message: `"${p.id}": per-call price exceeds the daily ceiling`,
      });
    }
  });
});
export type DomainManifest = z.infer<typeof DomainManifest>;

/**
 * Enforce the dimension policy: any static (non-temporal) pipeline above
 * maxStaticDims is a violation. Returns the offenders rather than
 * throwing, so an agent can report "running hot" without refusing to load.
 *
 * A HOT flag on a pre-cutover static pipeline is INTENDED — it reads as
 * "scheduled migration (NOMIC_768_PRIMARY), not yet cut over," not as an
 * error (PIPELINE.md Locked Decision #8; maxStaticDims is the target state).
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
 * Layer-2 seal-policy audit — flags, never refuses (same philosophy as
 * auditDimensions). A structurally valid paid pipeline with an honest gap
 * parses fine AND shows up here as the to-do list.
 */
export function auditSealPolicy(m: DomainManifest): Array<{ id: string; reason: string }> {
  const out: Array<{ id: string; reason: string }> = [];
  for (const p of m.pipelines) {
    if (p.distribution !== "sealed-paid") continue;
    const gate = p.silence.gate ?? "threshold";
    if (gate === "threshold" && !p.silence.calibration.calibrated) {
      out.push({
        id: p.id,
        reason:
          "sealed-paid behind an uncalibrated threshold gate — sell content-addressed ops only until calibration closes",
      });
    }
    if (gate === "threshold" && p.silence.threshold === 0) {
      out.push({ id: p.id, reason: "placeholder threshold (0) on a paid path" });
    }
    if (
      p.commercial &&
      p.commercial.substrate.geometryProfile === "full-concat" &&
      !p.commercial.licenseGate.denyLicenses.includes("NOASSERTION")
    ) {
      out.push({ id: p.id, reason: "shipping embeddings without denying unlicensed sources" });
    }
    if (p.commercial && p.dimensionality.temporalAxis && p.commercial.unit === "tile" && p.store.kind === "qdrant" && !p.secondaryStore) {
      out.push({
        id: p.id,
        reason: "paid substrate must be a sealed pack; authoring store is qdrant with no sealed secondaryStore declared",
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
