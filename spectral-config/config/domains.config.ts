/**
 * SPECTRAL-TERRAIN — DOMAINS CONFIG (the one source of truth)
 *
 * Loaded by any agent, script, or receptacle to know — without reading
 * prose — how a given data type is refined and served. Validated at
 * load by manifest.schema.ts.
 *
 * ── CONFIDENCE MARKERS ──────────────────────────────────────────────
 *  [STATED]  encoded directly from TGIL_VISION.md / your own words.
 *  [CONFIRM] my inference — plausible but you must verify before trust.
 *  Every threshold marked calibrated:false is a placeholder until a
 *  real sweep sets it. No magic constants ship as truth.
 * ────────────────────────────────────────────────────────────────────
 */

import type { DomainManifest } from "../src/manifest.schema.js";

/**
 * WIRE endpoints resolve from env — this repo is PUBLIC, so store-endpoint
 * literals (the Pi's Tailscale IP, LawLibra host) must not be committed
 * (FOLD_SPEC "Secrets / public-repo caution"). Set QDRANT_PI_URL /
 * LAWLIBRA_URL in a gitignored .env or the shell. `null` here means
 * "endpoint exists but not provided in this environment" — NOT "no endpoint".
 * Env names match scripts/ingest_husk.py for consistency.
 */
const QDRANT_PI_URL = process.env.QDRANT_PI_URL ?? null;
const LAWLIBRA_URL = process.env.LAWLIBRA_URL ?? null;

export const domains: DomainManifest = {
  manifestVersion: "1.0",
  refinery: "spectral-terrain",
  updated: "2026-07-26",
  principle:
    "The refinery knows nothing downstream. Crude in, refined fuel out, " +
    "sorted by intended application. The agent/receptacle is the vehicle " +
    "built to run on that fuel. Silence over fabrication, always.",

  dimensionPolicy: {
    rule:
      "3072-D is RESERVED for the temporal/causal path only ([v_t-1|v_t|" +
      "v_t+1] where sequence encodes causality — Roblox, finance/mempool). " +
      "Static data (legal, medical, property, husks) uses the LOWEST dims " +
      "that still route through the heat mapper. Legal is 768-D today with " +
      "intent to drop well below. Anything static above maxStaticDims is " +
      "running hot and flagged by auditDimensions().",
    maxStaticDims: 768,
    temporalDims: 3072,
  },

  pipelines: [
    // ─── PROVEN: the original temporal proof ──────────────────────────
    {
      id: "roblox-luau",
      description:
        "Roblox game state as temporal geometry. Frame N causally shaped " +
        "by N-1. Agent dropped into terrain predicts state without training.",
      status: "proven", // [STATED] "This is the proof of concept. It worked."
      dataType: "roblox-luau-gamestate",
      geometry: "temporal",
      processor: "temporal-concat",
      dimensionality: {
        dims: 3072,
        rationale:
          "[v_t-1 | v_t | v_t+1] concatenation — time as a dimension, " +
          "not linear. Sequence encodes physics-deterministic causality.",
        temporalAxis: true,
      },
      store: {
        kind: "qdrant",
        location: "spectral-heatmap", // [CONFIRM→v2 AGREES] same collection in pipeline.json
        embedModel: "mxbai-embed-large", // [VERIFIED] all ingest scripts hardcode mxbai-embed-large
        endpoint: QDRANT_PI_URL, // folded from v2 qdrant field
        // distanceMetric omitted — v2 doesn't record it (FOLD_SPEC "?"); Joe confirms
      },
      ingest: {
        script: "ingest:roblox", // FOLD_SPEC — npm script in spectral-terrain's package.json
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "spectral-terrain/engine/query.ts", // [STATED] pipeline manifest
        tools: ["terrain_query"], // folded from v2 receptacle field
      },
      silence: {
        enabled: true,
        signal: "knn-temporal",
        threshold: 0, // placeholder
        closerIs: "lower",
        calibration: {
          calibrated: false,
          corpus: null,
          corpusSize: null,
          date: null,
          note: "temporal KNN gate not yet calibrated in this manifest",
        },
      },
      notes:
        "First proof. Temporal path ONLY valid where sequence = causality. " +
        "FOLD DISAGREEMENT #1 RESOLVED (arbitration, PR #26): mxbai-embed-large — " +
        "both embed models are active on the Pi, but every ingest script " +
        "hardcodes mxbai-embed-large.",

      // Paid mount (x402 kernel). Sold ops are content-addressed ONLY —
      // the kNN gate above stays uncalibrated and is deliberately NOT sold;
      // auditSealPolicy flags that gap until Track C closes it.
      distribution: "sealed-paid",
      commercial: {
        sold: true,
        unit: "tile",
        edition: "roblox-luau-2026-08",
        effect: "read_only",
        replaySafe: true,
        capabilityVersion: "1.0.0",
        // pathTemplate is DECLARED per operation, never inferred from the
        // operationId. Generation refuses two operations of one mount whose
        // shapes a first-match resolver cannot tell apart (src/route-collision.ts).
        operations: [
          { operationId: "tile_fetch", pathTemplate: "/roblox-luau/tile/{cid}", resultKind: "pack-bytes", deadlineMs: 5, maxResultBytes: 65536, priceAtomic: "500" },
          { operationId: "pack_inclusion_proof", pathTemplate: "/roblox-luau/proof/{cid}", resultKind: "proof-json", deadlineMs: 5, maxResultBytes: 16384, priceAtomic: "200" },
          { operationId: "pack_manifest", pathTemplate: "/roblox-luau/manifest", resultKind: "manifest-json", deadlineMs: 5, maxResultBytes: 2097152, priceAtomic: "1000" },
        ],
        substrate: {
          kind: "sealed-pack",
          packRef: "roblox-luau-2026-08",
          trustStoreRef: "terrain-keys",
          statusListRef: "roblox-luau-status",
          geometryProfile: "transition-only",
        },
        price: {
          scheme: "exact",
          networks: ["eip155:84532"], // Base Sepolia; eip155:8453 only via the signed mainnet gate
          asset: "USDC",
          payToRef: "roblox-luau-payto",
        },
        challengeEpoch: "2026-08-05.1",
        retryEntitlementSeconds: 86400,
        resultRetentionSeconds: 86400,
        fingerprintVersion: "fp-v1",
        limits: {
          maxPricePerCallAtomic: "1000",
          dailySettledValueCeilingAtomic: "50000000", // $50/day at USDC 6 decimals — chosen in advance
        },
        licenseGate: {
          denyLicenses: ["NOASSERTION", "LicenseRef-Proprietary"],
          forbiddenKeysVersion: "SEALED_FORBIDDEN_KEYS@1",
          commitmentKeyId: "nodeout-prov-2026a",
        },
        compensation: {
          entitlementExtension: true,
          makeGood: true,
          onchainRefund: false,
          policyRef: "compensation-policy-v1",
          disputeChannel: "mailto:preston@marshpress.co",
        },
      },
    },

    // ─── OPERATIONAL: legal corpus, topological ───────────────────────
    {
      id: "legal-corpus",
      description:
        "Legal doctrine as topology — settled vs contested regions via " +
        "heat-kernel diffusion. NOT temporal: 1875 and 2024 statutes are " +
        "equally valid, no sequence axis.",
      status: "operational", // [STATED] legal_heatmap.py built, domain-agnostic
      dataType: "legal-doctrine",
      geometry: "topological",
      processor: "laplacian-heatmap",
      dimensionality: {
        dims: 768,
        rationale:
          "[STATED] Static doctrinal data uses lowest dims that route " +
          "through the heat mapper. 768-D TODAY, with a fast schedule to " +
          "drop WAY DOWN. Over-embedding static data was the key mistake " +
          "caught — 3072-D is temporal-only and does not belong here.",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "legal-heatmap", // [STATED] confirmed by legal.test.ts payload
        embedModel: "temporal-manifold", // [STATED] test payload embed_model (v2 claims nomic-embed-text — the target-side value; see liveVsTarget)
        endpoint: QDRANT_PI_URL, // folded from v2 qdrant field
        distanceMetric: "cosine", // FOLD_SPEC "cosine?" — test scores are high-is-closer; [CONFIRM] against live Qdrant config
      },
      ingest: {
        script: "legal_heatmap.py", // FOLD_SPEC — heat-kernel refinery stage; the low-D re-ingest points here
        refineryStage: null,
      },
      receptacle: {
        kind: "http-service",
        ref: "http://lawlibra.local:4880/api/legal/query", // [STATED] legal.test.ts
        tools: ["legal_retrieve"], // folded from v2 receptacle field; LawLibra's HTTP endpoints live on the lawlibra entry
      },
      silence: {
        enabled: true,
        signal: "cosine", // [STATED] test scores are high-is-closer (0.9912)
        threshold: 0, // placeholder
        closerIs: "higher",
        calibration: {
          calibrated: false,
          corpus: "legal-heatmap (27,797 shards)",
          corpusSize: 27797,
          date: null,
          note:
            "LawLibra returns a 'confidence' field (high/…) and a cosine " +
            "score. Whether silence is thresholded on score or delegated to " +
            "LawLibra is unconfirmed — see arbiter-legalengine entry.",
        },
      },
      liveVsTarget: {
        live: "3072-D, embed_model='temporal-manifold', cosine, collection='legal-heatmap'",
        target: "768-D topological NOW, dropping WAY DOWN on a fast schedule (static → lowest possible per dimensionPolicy)",
        evidence: "legal.test.ts mocked payload: vector_dims:3072, embed_model:'temporal-manifold', collection:'legal-heatmap'",
        resolved: false,
      },
      notes:
        "CONFLICT: production is running HOT at 3072-D (violates the " +
        "dimensionPolicy — 3072 is temporal-only). Target is 768-D now, " +
        "then lower. The legal-heatmap collection needs re-ingest at low-D. " +
        "This is a corpus fix, not a manifest fix — the manifest is " +
        "correctly recording that live violates the rule.",
    },

    // ─── OPERATIONAL: LawLibra — the legal receptacle/service ─────────
    {
      id: "lawlibra",
      description:
        "The HTTP service that fronts the legal corpus. ArbiterOS and any " +
        "other consumer query THIS, never Qdrant directly. Returns citation, " +
        "spectral_band, corpus_heat, drift, confidence per hit.",
      status: "operational", // [STATED] legal.test.ts exercises its endpoints
      dataType: "legal-doctrine",
      geometry: "topological",
      processor: "laplacian-heatmap",
      dimensionality: {
        dims: 3072, // [STATED] test payload; see legal-corpus liveVsTarget conflict
        rationale:
          "Mirrors legal-corpus. Carries the same 3072-vs-768 conflict — " +
          "LawLibra serves whatever the collection was built at.",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "legal-heatmap",
        embedModel: "temporal-manifold",
        endpoint: LAWLIBRA_URL, // FOLD_SPEC ":4880 base" — the seam consumers actually reach; Pi Qdrant sits behind it (legal-corpus entry)
        distanceMetric: null, // FOLD_SPEC "—": the seam serves whatever the collection was built with
      },
      receptacle: {
        kind: "http-service",
        ref: "http://lawlibra.local:4880", // [STATED] legal.test.ts
        tools: ["/health", "/api/legal/query"], // folded per FOLD_SPEC — endpoints proven by legal.test.ts
      },
      silence: {
        enabled: true,
        signal: "cosine",
        threshold: 0,
        closerIs: "higher",
        calibration: {
          calibrated: false,
          corpus: "legal-heatmap (27,797 shards)",
          corpusSize: 27797,
          date: null,
          note: "This service owns the actual gate. Threshold lives here, not in ArbiterOS.",
        },
      },
      notes:
        "Endpoints proven by test: GET /health, POST /api/legal/query. " +
        "Frontend is walled off from Qdrant by design — LawLibra is the seam.",
    },

    // ─── OPERATIONAL: ArbiterOS — the public product (a consumer) ─────
    {
      id: "arbiter-legalengine",
      description:
        "ArbiterOS: the shippable public product. Archer-personality legal " +
        "confidant. Retrieves via LawLibra; validates every AI in/out through " +
        "Zod schemas (the 'chastity belt'). Two silence layers stack here.",
      status: "operational", // [STATED] README + passing e2e/legal/memory tests
      dataType: "legal-consumer-app",
      geometry: "topological", // inherits the corpus geometry via LawLibra
      processor: "laplacian-heatmap", // upstream; ArbiterOS itself refines nothing
      dimensionality: {
        dims: 3072, // inherited from LawLibra; not ArbiterOS's own choice
        rationale:
          "ArbiterOS does not embed anything. Dims are whatever LawLibra " +
          "serves. Recorded for traceability only.",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "legal-heatmap (via LawLibra)",
        embedModel: "temporal-manifold",
        endpoint: null, // pure consumer — store reached only through LawLibra's seam (FOLD_SPEC ":4881→:4880" chain is the receptacle ref)
        distanceMetric: null, // FOLD_SPEC "—": inherits whatever LawLibra serves
      },
      receptacle: {
        kind: "http-service",
        ref: "arbiterOS backend :4881 → LawLibra :4880", // [STATED] README + test
        tools: [
          // the 6 verification tools, verbatim from the ArbiterOS README
          "consult_statute",
          "verify_negotiability",
          "analyze_clause_risks",
          "draft_verified_form",
          "verify_necessary",
          "verify_ordinary",
        ],
      },
      silence: {
        enabled: true,
        signal: "contract-schema",
        threshold: 0, // schema-refusal is boolean, not distance — 0 = n/a
        closerIs: "lower",
        calibration: {
          calibrated: true, // contract silence needs no numeric calibration
          corpus: "legalSchemas.ts + legalEngine.ts (UCC/IRC/FTC)",
          corpusSize: null,
          date: "2026-07-08",
          note:
            "Contract silence: the AI cannot assert a statute not present in " +
            "the typed schema/engine. Boolean guarantee, no threshold. This " +
            "STACKS on LawLibra's distance silence upstream.",
        },
      },
      notes:
        "THE PRODUCT. Ships independent of the 768-vs-3072 corpus question " +
        "because it only speaks to LawLibra's HTTP seam. Swap the corpus " +
        "underneath without touching the app. Third silence type " +
        "(contract-schema) is the real IP and the cleanest sales story.",
    },

    // ─── OPERATIONAL: medical vault, fingerprint ──────────────────────
    {
      id: "medical-corpus",
      description:
        "Medical corpus via SimHash-128 fingerprint. Faith-Less: silence " +
        "when no shard is within Hamming threshold.",
      status: "operational", // [STATED] "medical role live"
      dataType: "medical-corpus",
      geometry: "fingerprint",
      processor: "simhash-128",
      dimensionality: {
        dims: 128,
        rationale:
          "SimHash-128 bitwise signature. Hamming distance replaces " +
          "float cosine for CPU-bound / airgapped retrieval.",
        temporalAxis: false,
      },
      store: {
        kind: "vault-index",
        location: "vault/index.json", // [STATED]
        embedModel: null, // text-path SimHash needs no embed model
        endpoint: null, // local-file store (FOLD_SPEC "vault path→null")
        distanceMetric: null, // hamming index, not a vector-store metric
      },
      ingest: {
        script: "brain/indexer/rechunk_medical.py", // FOLD_SPEC — rebuilds the medical shard corpus
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "WhiteGlove agent/index.ts", // [STATED]
        tools: ["vault_retrieve"], // folded from v2 receptacle field
      },
      silence: {
        enabled: true,
        signal: "hamming",
        threshold: 0.35, // placeholder — NOT calibrated for the medical corpus
        closerIs: "lower",
        calibration: {
          calibrated: false,
          corpus: null,
          corpusSize: null,
          date: null,
          note:
            "The gate MECHANISM is proven and calibrated on repo-husk " +
            "(0.325, 2026-07-10, tokenizer+IDF stack), but this domain's " +
            "corpus has never been swept — run the 150-query harness " +
            "against the real medical vault on the Pi before shipping any " +
            "number here. Do not ship this placeholder. Note: " +
            "broseidon-indexer.ts and medical-test.ts still pin 0.45 from " +
            "the pre-fix era.",
        },
      },
      notes:
        "Salt-alignment fix applied (query and shards both sign 'corpus'). " +
        "Pre-fix serialized indexes are incompatible — rebuild after upgrade. " +
        "FOLD RESOLVED (arbitration, PR #26): the Pi backup exists (collection " +
        "medical-heatmap, 29,333 points, nomic-embed-text, 768-D) and stays a " +
        "backup; the local vault remains this pipeline's store.",
      provenance: "pipeline-test-fixture", // data run to validate mapping, not a canonical corpus
    },

    // ─── OPERATIONAL: repo husk, fingerprint ──────────────────────────
    {
      id: "repo-husk",
      description:
        "A repo's self-knowledge as geometry. Ingest a codebase into its " +
        "own SimHash vault; an agent entering the repo queries the husk and " +
        "arrives already knowing how to operate it.",
      status: "operational", // [STATED] husk pattern working; Open Claw found vulns
      dataType: "source-code-self",
      geometry: "fingerprint",
      processor: "simhash-128",
      dimensionality: {
        dims: 128,
        rationale: "Same SimHash-128 fingerprint path as medical vault.",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "husk-whiteglove",
        embedModel: null,
        endpoint: QDRANT_PI_URL,
        distanceMetric: null,
      },
      secondaryStore: {
        kind: "vault-index",
        location: "vault/index.json",
        embedModel: null,
        role: "local-fast-path",
      },
      ingest: {
        script: "scripts/ingest_husk.py", // builds the CANONICAL store (Qdrant husk-whiteglove) — v2's fact for the husk path
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "WhiteGlove agent/index.ts",
        tools: ["pattern_scan"], // folded from v2 receptacle field
      },
      silence: {
        enabled: true,
        signal: "hamming",
        threshold: 0.325, // last zero-false-answer point on the calibration sweep
        closerIs: "lower",
        calibration: {
          calibrated: true,
          corpus: "WhiteGlove code self-corpus (131 shards, 162-query set: 56 grounded / 50 ungrounded / 56 adversarial)",
          corpusSize: 131,
          date: "2026-07-10",
          note:
            "Calibrated with code-aware tokenizer + set semantics + corpus-IDF " +
            "vote weighting (known-issue #4 fix). Sweep: FA 0% / TS 100% at " +
            "0.325; the closest unanswerable query lands at 0.3281, so the " +
            "margin is thin — re-sweep after any corpus or tokenizer change. " +
            "0.35 trades 10.4% FA for 2x true answers if a deployment prefers " +
            "recall. Full curve: silence-harness-eval/results/CHECKPOINT.md.",
        },
      },
      provenance: "pipeline-test-fixture", // WhiteGlove-resident legal data is a test fixture validating the mapping process, not a canonical domain corpus.
      notes:
        "Real-world result: Open Claw source fed through this path surfaced " +
        "vulns it hadn't seen by reading its own source directly. [STATED] " +
        "FOLD DISAGREEMENT #3 RESOLVED (arbitration, PR #26): Qdrant " +
        "husk-whiteglove is the canonical store; the local vault-index is the " +
        "secondaryStore (local-fast-path). ingest.script builds the canonical " +
        "store (scripts/ingest_husk.py); the secondary vault is rebuilt by " +
        "brain/indexer/build-index.ts.",
    },

    // ─── PROVEN (static low-dim): NAICS industry terrain ───────────────
    {
      id: "naics-2022",
      description:
        "US NAICS 2022 sector taxonomy as sealed static terrain. " +
        "20 official sectors → industry fingerprint 20-D → PCA display 3-D. " +
        "No DNA extract — procedural taxonomy, not authorial voice. " +
        "Agents mount the pack (or Qdrant naics-heatmap-3) to tell industries apart.",
      status: "proven",
      dataType: "naics-sector-taxonomy",
      geometry: "static-heatmap",
      processor: "industry-signal-pca",
      dimensionality: {
        dims: 3,
        rationale:
          "Static taxonomy. Compute stays at 20-D industry fingerprint; " +
          "display/navigation is PCA-3 (heat_cv≈0.26). Obeys dimensionPolicy " +
          "(static → lowest dims that still route heat).",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "naics-heatmap-3",
        embedModel: null, // sealed pack coords — no embed at query time
        endpoint: QDRANT_PI_URL,
      },
      ingest: {
        script: "spectral-terrain/scripts/build_naics_3d_pack.py",
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "spectral-terrain/scripts/query_naics.py",
        tools: ["terrain_query"], // the registered tool; "naics_query" exists nowhere
      },
      silence: {
        enabled: true,
        signal: "title-overlap-or-code",
        threshold: 0.34,
        closerIs: "higher",
        calibration: {
          calibrated: true,
          corpus: "naics-2022-3d.pack.json",
          corpusSize: 20,
          date: "2026-07-26",
          note: "resolve() silences below 0.34 overlap or on ambiguous top-2.",
        },
      },
      notes:
        "Pack: spectral-terrain/store/naics-2022-3d.pack.json (blake2b sealed). " +
        "Upsert: scripts/upsert_naics_3d_qdrant.py. Hydra holder_naics overlay " +
        "is the operational $ path; this domain is the industry map accessory.",
    },

    // ─── OPERATIONAL: property/financial graph ────────────────────────
    {
      id: "property-data",
      description:
        "Property / financial records as a graph — GAT attention over " +
        "entity relationships (Eve v2).",
      status: "operational", // [STATED] "Eve v2 ... built and working"
      dataType: "property-financial-records",
      geometry: "graph",
      processor: "eve-v2-gat",
      dimensionality: {
        dims: 3072,
        rationale:
          "[CONFIRM — RUNNING HOT] TGIL lists 3072-D GAT. Under the " +
          "dimensionPolicy this VIOLATES the rule unless property graphs " +
          "have a causal/temporal axis (they may not). Either GAT genuinely " +
          "needs the width, or this is another over-embed to drop. YOUR CALL.",
        temporalAxis: false,
      },
      store: {
        kind: "qdrant",
        location: "hydra-unclaimed", // [STATED] TGIL manifest
        embedModel: null, // [CONFIRM→v2 AGREES] v2 also records no embed_model for this domain
        endpoint: QDRANT_PI_URL, // folded from v2 qdrant field
        // distanceMetric omitted — v2 doesn't record it (FOLD_SPEC "?"); Joe confirms
      },
      ingest: {
        script: "agents/ingest_eve.py", // [VERIFIED] runs in property-hydra repo
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "property-hydra query", // [STATED]
        tools: ["terrain_query"], // folded from v2 receptacle field (FOLD_SPEC cell said "property-hydra q" — v2 fact wins, divergence flagged)
      },
      silence: {
        enabled: true,
        signal: "cosine", // [CONFIRM] what's the graph-path gate signal?
        threshold: 0,
        closerIs: "higher",
        calibration: {
          calibrated: false,
          corpus: null,
          corpusSize: null,
          date: null,
          note: "[CONFIRM] gate signal + threshold for the GAT path unknown to me.",
        },
      },
      notes:
        "Liquidity-pool lab standing up now may add a temporal sibling here. " +
        "FOLD RESOLVED (arbitration, PR #26): operational confirmed — " +
        "hydra-unclaimed exists on the Pi (3072-D, 500 points); v2's 'Not yet " +
        "wired' note was stale. v2 receptacle terrain_query kept.",
    },

    // ─── WIRING: finance/crypto temporal (the live lab) ───────────────
    {
      id: "finance-crypto",
      description:
        "Crypto/mempool/liquidity as temporal geometry — the domain where " +
        "sequence genuinely encodes causality (arbitrage windows, flash loans).",
      status: "wiring", // [CONFIRM] package.json has refinery:finance scripts
      dataType: "finance-crypto-timeseries",
      geometry: "temporal",
      processor: "temporal-concat",
      dimensionality: {
        dims: 3072,
        rationale:
          "Temporal concat — valid here because mempool/liquidity sequence " +
          "IS causal. This is the correct home for the temporal path.",
        temporalAxis: true,
      },
      store: {
        kind: "qdrant",
        location: "spectral-heatmap", // [CONFIRM→v2 AGREES it's shared] v2 also points finance at spectral-heatmap
        embedModel: "mxbai-embed-large", // [VERIFIED] all ingest scripts hardcode mxbai-embed-large
        endpoint: QDRANT_PI_URL, // folded from v2 qdrant field
        // distanceMetric omitted — v2 doesn't record it (FOLD_SPEC "?"); Joe confirms
      },
      ingest: {
        script: "scripts/ingest-finance-heatmap.ts", // FOLD_SPEC §ingest example — the live-lab ingest path
        refineryStage: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "spectral-terrain/engine/navigate-finance.ts", // [STATED] package.json
        tools: ["terrain_query"], // folded from v2 receptacle field
      },
      silence: {
        enabled: true,
        signal: "knn-temporal",
        threshold: 0,
        closerIs: "lower",
        calibration: {
          calibrated: false,
          corpus: null,
          corpusSize: null,
          date: null,
          note: "Live lab. Calibrate once ingest:finance produces a terrain.",
        },
      },
      notes:
        "package.json shows refinery:finance, calibrate:finance, " +
        "navigate:finance, ingest:finance — this path is actively being wired. " +
        "FOLD DISAGREEMENT #1 sibling RESOLVED (arbitration, PR #26): " +
        "mxbai-embed-large, same verification as roblox-luau.",
    },

    // ─── SOLD: MedlinePlus static terrain, content-addressed ──────────────
    // Distinct from `medical-corpus`, which is the 128-D SimHash vault path
    // and is marked pipeline-test-fixture. This one is the 768-D nomic
    // projection that actually ships: MedlinePlus is US federal public
    // domain, so the retrievable text may cross the paid boundary — which
    // for a retrieval endpoint IS the product.
    {
      id: "medical-medlineplus",
      description:
        "MedlinePlus static terrain sold by content address. Mapped position " +
        "plus geometric scores plus the retrievable text. Public domain, so " +
        "no licensing gate beyond locator suppression.",
      status: "operational",
      dataType: "medical-medlineplus-chunks",
      geometry: "topological",
      processor: "terrain-tile-seal",
      dimensionality: {
        dims: 768,
        rationale:
          "nomic-embed-text native 768-D. Static domain — a single vector, " +
          "no temporal concatenation, at the dimension policy ceiling.",
        temporalAxis: false,
      },
      store: {
        kind: "sealed-tile-pack",
        location: "medical-medlineplus-2026-08",
        embedModel: "nomic-embed-text",
        endpoint: null, // sealed pack on local disk — immutable, hence replay-safe
        distanceMetric: null,
      },
      ingest: {
        script: "spectral-terrain/engine/pack-emitter.ts --profile static",
        refineryStage: "terrain-tile-seal",
      },
      receptacle: {
        kind: "http-service",
        ref: "spectral-x402/src/server.ts",
        tools: ["tile_fetch", "pack_inclusion_proof", "pack_manifest"],
      },
      silence: {
        enabled: true,
        // Exact cid match: silence is a 404 on an unknown address. No
        // distance, so no threshold and no calibration claim — the gate
        // discriminant exists precisely so this cannot ship a placeholder 0.
        gate: "exact-match",
        signal: "content-address",
        calibration: {
          calibrated: true,
          corpus: "MedlinePlus 2026-08 sealed pack",
          corpusSize: 1999,
          date: "2026-08-06",
          note:
            "Content-addressed retrieval needs no swept threshold: a cid " +
            "either resolves in the sealed pack or it does not. Verified by " +
            "egress digest check on every paid call.",
        },
      },
      provenance: "production",
      distribution: "sealed-paid",
      commercial: {
        sold: true,
        unit: "tile",
        edition: "medical-medlineplus-2026-08",
        effect: "read_only",
        replaySafe: true,
        capabilityVersion: "1.0.0",
        // Declared, not inferred — see the roblox-luau mount above.
        operations: [
          { operationId: "tile_fetch", pathTemplate: "/medical-medlineplus/tile/{cid}", resultKind: "pack-bytes", deadlineMs: 5, maxResultBytes: 131072, priceAtomic: "300" },
          { operationId: "pack_inclusion_proof", pathTemplate: "/medical-medlineplus/proof/{cid}", resultKind: "proof-json", deadlineMs: 5, maxResultBytes: 16384, priceAtomic: "150" },
          { operationId: "pack_manifest", pathTemplate: "/medical-medlineplus/manifest", resultKind: "manifest-json", deadlineMs: 5, maxResultBytes: 4194304, priceAtomic: "1000" },
        ],
        substrate: {
          kind: "sealed-pack",
          packRef: "medical-medlineplus-2026-08",
          trustStoreRef: "terrain-keys",
          statusListRef: "medical-medlineplus-status",
          geometryProfile: "static-position",
        },
        price: {
          scheme: "exact",
          networks: ["eip155:84532"],
          asset: "USDC",
          payToRef: "medical-medlineplus-payto",
        },
        challengeEpoch: "2026-08-06.1",
        retryEntitlementSeconds: 86400,
        resultRetentionSeconds: 86400,
        fingerprintVersion: "fp-v1",
        limits: {
          maxPricePerCallAtomic: "1000",
          dailySettledValueCeilingAtomic: "50000000",
        },
        licenseGate: {
          denyLicenses: ["NOASSERTION", "LicenseRef-Proprietary"],
          forbiddenKeysVersion: "SEALED_FORBIDDEN_KEYS@1",
          commitmentKeyId: "nodeout-prov-2026a",
        },
        compensation: {
          entitlementExtension: true,
          makeGood: true,
          onchainRefund: false,
          policyRef: "compensation-policy-v1",
          disputeChannel: "mailto:preston@marshpress.co",
        },
      },
    },

    // ─── SOLD: financial-intel paper-arena record, content-addressed ──────
    // Hermes-Spectral Mission 1. First-party output of the financial-intel
    // loop: closed trades, per-strategy performance, portfolio snapshot —
    // cut into a sealed pack by spectral-x402/scripts/cut-fintel-pack.ts.
    // No third-party source text, so no locator suppression is needed;
    // the record is published exactly as the arena wrote it.
    {
      id: "fintel-paper-arena",
      description:
        "Paper-arena trading record sold by content address: closed trades, " +
        "per-strategy performance, and the portfolio snapshot. First-party " +
        "data generated by the financial-intel loop itself.",
      status: "operational",
      dataType: "fintel-paper-arena-records",
      geometry: "graph",
      processor: "terrain-tile-seal",
      dimensionality: {
        dims: 1,
        rationale:
          "Content-addressed records with no embedding axis; retrieval is " +
          "exact cid match, so the geometric dimension is the null placeholder.",
        temporalAxis: false,
      },
      store: {
        kind: "sealed-tile-pack",
        location: "fintel-paper-arena-2026-08",
        embedModel: null,
        endpoint: null, // sealed pack on local disk — immutable, hence replay-safe
        distanceMetric: null,
      },
      ingest: {
        script: "spectral-x402/scripts/cut-fintel-pack.ts",
        refineryStage: "terrain-tile-seal",
      },
      receptacle: {
        kind: "http-service",
        ref: "spectral-x402/src/server.ts",
        tools: ["tile_fetch", "pack_inclusion_proof", "pack_manifest"],
      },
      silence: {
        enabled: true,
        gate: "exact-match",
        signal: "content-address",
        calibration: {
          calibrated: true,
          corpus: "fintel-paper-arena-2026-08 sealed pack",
          corpusSize: 16,
          date: "2026-08-11",
          note:
            "Content-addressed retrieval needs no swept threshold: a cid " +
            "either resolves in the sealed pack or it does not. Verified by " +
            "egress digest check on every paid call.",
        },
      },
      provenance: "production",
      distribution: "sealed-paid",
      commercial: {
        sold: true,
        unit: "tile",
        edition: "fintel-paper-arena-2026-08",
        effect: "read_only",
        replaySafe: true,
        capabilityVersion: "1.0.0",
        operations: [
          { operationId: "tile_fetch", pathTemplate: "/fintel-paper-arena/tile/{cid}", resultKind: "pack-bytes", deadlineMs: 5, maxResultBytes: 131072, priceAtomic: "200" },
          { operationId: "pack_inclusion_proof", pathTemplate: "/fintel-paper-arena/proof/{cid}", resultKind: "proof-json", deadlineMs: 5, maxResultBytes: 16384, priceAtomic: "100" },
          { operationId: "pack_manifest", pathTemplate: "/fintel-paper-arena/manifest", resultKind: "manifest-json", deadlineMs: 5, maxResultBytes: 4194304, priceAtomic: "800" },
        ],
        substrate: {
          kind: "sealed-pack",
          packRef: "fintel-paper-arena-2026-08",
          trustStoreRef: "terrain-keys",
          statusListRef: "fintel-paper-arena-status",
          geometryProfile: "static-position",
        },
        price: {
          scheme: "exact",
          networks: ["eip155:84532"],
          asset: "USDC",
          payToRef: "fintel-paper-arena-payto",
        },
        challengeEpoch: "2026-08-11.1",
        retryEntitlementSeconds: 86400,
        resultRetentionSeconds: 86400,
        fingerprintVersion: "fp-v1",
        limits: {
          maxPricePerCallAtomic: "800",
          dailySettledValueCeilingAtomic: "50000000",
        },
        licenseGate: {
          denyLicenses: ["NOASSERTION", "LicenseRef-Proprietary"],
          forbiddenKeysVersion: "SEALED_FORBIDDEN_KEYS@1",
          commitmentKeyId: "nodeout-prov-2026a",
        },
        compensation: {
          entitlementExtension: true,
          makeGood: true,
          onchainRefund: false,
          policyRef: "compensation-policy-v1",
          disputeChannel: "mailto:preston@marshpress.co",
        },
      },
    },
  ],
};

export default domains;
