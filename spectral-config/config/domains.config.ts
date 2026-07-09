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

export const domains: DomainManifest = {
  manifestVersion: "1.0",
  refinery: "spectral-terrain",
  updated: "2026-07-08",
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
        location: "spectral-heatmap", // [CONFIRM] collection name
        embedModel: "nomic-embed-text", // [CONFIRM] which embed model per-domain
      },
      receptacle: {
        kind: "cli-query",
        ref: "spectral-terrain/engine/query.ts", // [STATED] pipeline manifest
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
      notes: "First proof. Temporal path ONLY valid where sequence = causality.",
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
        embedModel: "temporal-manifold", // [STATED] test payload embed_model
      },
      receptacle: {
        kind: "http-service",
        ref: "http://lawlibra.local:4880/api/legal/query", // [STATED] legal.test.ts
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
      },
      receptacle: {
        kind: "http-service",
        ref: "http://lawlibra.local:4880", // [STATED] legal.test.ts
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
      },
      receptacle: {
        kind: "http-service",
        ref: "arbiterOS backend :4881 → LawLibra :4880", // [STATED] README + test
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
      },
      receptacle: {
        kind: "cli-query",
        ref: "WhiteGlove agent/index.ts", // [STATED]
      },
      silence: {
        enabled: true,
        signal: "hamming",
        threshold: 0.35, // [CONFIRM] smoke-set value only; NOT calibrated
        closerIs: "lower",
        calibration: {
          calibrated: false,
          corpus: "code self-corpus (113 shards)",
          corpusSize: 113,
          date: "2026-07-08",
          note:
            "0.35 came from a 6-query smoke set on a CODE corpus, post " +
            "salt-fix. Real medical corpus + 150-query sweep pending. Do " +
            "not ship this number.",
        },
      },
      notes:
        "Salt-alignment fix applied (query and shards both sign 'corpus'). " +
        "Pre-fix serialized indexes are incompatible — rebuild after upgrade.",
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
        kind: "vault-index",
        location: "vault/index.json",
        embedModel: null,
      },
      receptacle: {
        kind: "cli-query",
        ref: "WhiteGlove agent/index.ts",
      },
      silence: {
        enabled: true,
        signal: "hamming",
        threshold: 0.35, // [CONFIRM] same smoke-set caveat
        closerIs: "lower",
        calibration: {
          calibrated: false,
          corpus: "WhiteGlove code self-corpus (113 shards)",
          corpusSize: 113,
          date: "2026-07-08",
          note: "Same uncalibrated placeholder as medical-corpus.",
        },
      },
      notes:
        "Real-world result: Open Claw source fed through this path surfaced " +
        "vulns it hadn't seen by reading its own source directly. [STATED]",
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
        embedModel: null, // [CONFIRM] GAT produces embeddings; no external model?
      },
      receptacle: {
        kind: "cli-query",
        ref: "property-hydra query", // [STATED]
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
      notes: "Liquidity-pool lab standing up now may add a temporal sibling here.",
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
        location: "spectral-heatmap", // [CONFIRM] shared with roblox or separate?
        embedModel: "nomic-embed-text", // [CONFIRM]
      },
      receptacle: {
        kind: "cli-query",
        ref: "spectral-terrain/engine/navigate-finance.ts", // [STATED] package.json
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
        "navigate:finance, ingest:finance — this path is actively being wired.",
    },
  ],
};

export default domains;
