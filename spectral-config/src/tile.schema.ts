/**
 * tile.schema.ts — terrain-tile-v1 artifact schemas.
 *
 * Spec: docs/superpowers/specs/2026-08-05-terrain-tile-v1-design.md
 *
 * Working tile: mutable authoring shape. Never signed, never sold, no hash.
 * Sealed tile: immutable content-addressed body. The only thing a paid
 * endpoint serves. Strict at every level — unknown keys are refused, and
 * SEALED_FORBIDDEN_KEYS is checked at every depth before schema validation.
 */

import { z } from "zod";
import { CID_RE, isDecimalString } from "./canon.js";

// ─── forbidden keys (licensing gate) ─────────────────────────────────────────

/**
 * SEALED_FORBIDDEN_KEYS@1 — normalized form (lowercase, "-"/"_" stripped).
 * Match rule: exact match after normalization, at any depth. A sealed tile
 * containing any of these keys is refused before schema validation runs.
 */
export const SEALED_FORBIDDEN_KEYS_VERSION = "SEALED_FORBIDDEN_KEYS@1";

const FORBIDDEN_NORMALIZED = new Set([
  "source", "sourcetext", "scripts", "rawsnapshot",
  "sourceref", "repourl", "commitsha", "path",
  "scriptname", "file", "symbol", "deltatarget",
  "firstseen", "lastseen", "updatedat", "ingestedat", "generatedat",
  "packid", "editionid",
  "tileneighbors", "neighbors", "adjacency",
  "tilehash", "cid", "hash", "blake2b16",
  "sig", "signature", "signaturealgorithm", "alg", "publickeyref",
  "redactionsummary", "confidence", "confidencescore",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export interface ForbiddenKeyHit {
  path: string;
  key: string;
}

/** Walk any JSON value; report every forbidden key at any depth. */
export function findForbiddenKeys(value: unknown, path = ""): ForbiddenKeyHit[] {
  const hits: ForbiddenKeyHit[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}/${i}`)));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}/${k}`;
      if (FORBIDDEN_NORMALIZED.has(normalizeKey(k))) hits.push({ path: p, key: k });
      hits.push(...findForbiddenKeys(v, p));
    }
  }
  return hits;
}

// ─── shared field types ──────────────────────────────────────────────────────

export const cidString = z.string().regex(CID_RE, "expected b2-256:<64 hex>");

export const decimalString = z
  .string()
  .refine(isDecimalString, "expected a finite decimal string (no -0)");

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const uuid4 = z.string().uuid();
const rfc3339 = z.string().datetime({ offset: false });

export const VecrefSchema = z
  .object({
    dtype: z.enum(["f64le", "f32le"]),
    count: z.number().int().positive(),
    b64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

// ─── domain enums ────────────────────────────────────────────────────────────

export const RedactionCategory = z.enum([
  "source_text_withheld",
  "source_locator_withheld",
  "identifier_withheld",
  "constraint_names_generalized",
  "unicode_stripped",
  "unicode_normalized",
  "embedding_downcast",
  "neighbor_ref_withheld",
]);
export type RedactionCategory = z.infer<typeof RedactionCategory>;

export const RedactionLedger = z
  .record(RedactionCategory, z.number().int().nonnegative())
  .refine((r) => Object.keys(r).length > 0, "redaction ledger must be present (zero counts may be omitted, object may not)");

export const ConstraintClass = z.enum([
  "weld", "hinge", "rope", "rod", "spring", "motor",
  "ballsocket", "prismatic", "cylindrical", "alignment", "vector-force", "other",
]);

export const DisallowedGlobal = z.enum(["require", "loadstring", "pcall", "xpcall"]);

export const HighRiskPattern = z.enum([
  "WeldConstraint",
  "RunService.Heartbeat",
  "Instance.new",
  "workspace:FindPartOnRay",
]);

export const NoveltyMetric = z.enum(["l2-concat", "cosine-concat", "hamming-128"]);

export const GeometryProfile = z.enum(["transition-only", "full-concat"]);
export type GeometryProfile = z.infer<typeof GeometryProfile>;

export const NoteCode = z.enum([
  "degraded-constraints-dropped",
  "degraded-iteration-cap",
  "reseal-of-defect",
  "genesis-import",
]);

// ─── observation (one point of the closed window) ────────────────────────────

export const ObservationSchema = z
  .object({
    tick: decimalString,
    epoch_ms: z.number().int().nonnegative(),
    vec: VecrefSchema.optional(),
    state_digest: hex64,
    constraint_classes: z.array(ConstraintClass),
    script_count: z.number().int().nonnegative(),
  })
  .strict();

// ─── sealed tile ─────────────────────────────────────────────────────────────

const sortedUnique = (vals: string[]) =>
  vals.every((v, i) => i === 0 || vals[i - 1] < v);

export const SealedTileSchema = z
  .object({
    schema: z.literal("terrain-tile-v1"),
    canon_version: z.literal(1),
    domain: z.literal("roblox-luau"),
    lineage_id: uuid4,
    prev_cid: cidString.nullable(),
    geometry_profile: GeometryProfile,
    norm_convention: z.literal("per-third-unit-kahan"),
    embed: z
      .object({
        model: z.literal("mxbai-embed-large"),
        dim_per_third: z.literal(1024),
        concat_dim: z.literal(3072),
        concat_norm: z.literal("1.7320508075688772"),
      })
      .strict(),
    window: z
      .object({
        t_minus1: ObservationSchema,
        t_now: ObservationSchema,
        t_plus1: ObservationSchema,
      })
      .strict(),
    physics: z
      .object({
        method: z.literal("physics-deterministic"),
        engine_version: z.string().min(1),
        delta_ms: decimalString,
        determinism_class: z.enum(["engine-exact", "engine-exact-degraded"]),
      })
      .strict(),
    transition: z
      .object({
        residual_now_prev: VecrefSchema,
        residual_next_now: VecrefSchema,
        cframe_delta: z
          .object({
            position: z.tuple([decimalString, decimalString, decimalString]),
            rotation: z.array(decimalString).length(9),
          })
          .strict()
          .nullable(),
        velocity_delta: z.tuple([decimalString, decimalString, decimalString]).nullable(),
        memory_delta_kb: decimalString,
        curvature: decimalString,
      })
      .strict(),
    scores: z
      .object({
        shatter: decimalString,
        shatter_scale: z.literal("concat-sqrt3-l2"),
        heat: decimalString,
        knn_margin: decimalString,
        corpus_support: z.number().int().nonnegative(),
        centroid_cid: cidString,
      })
      .strict(),
    fingerprint: z
      .object({
        family: z.literal("simhash128-fnv1a"),
        bits: z.literal(128),
        hex: z.string().regex(/^[0-9a-f]{32}$/, "zero-padded 32 hex chars"),
      })
      .strict()
      .optional(),
    admission: z
      .object({
        contract_version: z.string().min(1),
        disallowed_globals_hit: z
          .array(DisallowedGlobal)
          .refine(sortedUnique, "sorted, deduplicated"),
        high_risk_patterns_hit: z
          .array(HighRiskPattern)
          .refine(sortedUnique, "sorted, deduplicated"),
        memory_safe: z.boolean(),
      })
      .strict(),
    novelty: z
      .object({
        vs_prev_cid: cidString.nullable(),
        metric: NoveltyMetric,
        value: decimalString.nullable(),
      })
      .strict(),
    license: z
      .object({
        spdx: z.string().min(1),
        source_class: z.enum(["public-repo", "synthetic", "owner-authored"]),
        derivative_release: z.enum(["geometry-only", "geometry-and-embeddings"]),
      })
      .strict(),
    commitments: z
      .object({
        source_mac_key_id: z.string().min(1),
        source_mac: hex64,
        locator_mac_key_id: z.string().min(1),
        locator_mac: hex64,
      })
      .strict(),
    redaction: RedactionLedger,
    notes: z.array(NoteCode).optional(),
  })
  .strict()
  .superRefine((tile, ctx) => {
    if (tile.novelty.vs_prev_cid !== tile.prev_cid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["novelty", "vs_prev_cid"],
        message: "must equal prev_cid (auditable redundancy)",
      });
    }
    if ((tile.novelty.value === null) !== (tile.prev_cid === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["novelty", "value"],
        message: "null iff genesis (prev_cid null)",
      });
    }
    const wantVec = tile.geometry_profile === "full-concat";
    for (const t of ["t_minus1", "t_now", "t_plus1"] as const) {
      const hasVec = tile.window[t].vec !== undefined;
      if (hasVec !== wantVec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["window", t, "vec"],
          message: wantVec
            ? "full-concat requires vec on every observation"
            : "transition-only must not carry raw embeddings",
        });
      }
      if (wantVec && tile.window[t].vec && tile.window[t].vec!.count !== 1024) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["window", t, "vec"],
          message: "each third is 1024-D",
        });
      }
    }
    if (
      tile.license.derivative_release === "geometry-only" &&
      tile.geometry_profile === "full-concat"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["license", "derivative_release"],
        message: "tile cannot carry embeddings it is not licensed to carry",
      });
    }
    if (tile.transition.residual_now_prev.count !== 1024 ||
        tile.transition.residual_next_now.count !== 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transition"],
        message: "residuals are per-third (1024-D)",
      });
    }
  });

export type SealedTile = z.infer<typeof SealedTileSchema>;

/** Licenses that refuse at seal time (cannot warrant what you cannot license). */
export const SEAL_DENY_LICENSES = new Set(["NOASSERTION", "LicenseRef-Proprietary"]);

// ─── working tile (authoring layer; never sold) ──────────────────────────────

const WorkingObservation = ObservationSchema.extend({
  // Authoring always carries the raw third — the sealer computes residuals
  // from these and drops them unless the profile is full-concat.
  vec: VecrefSchema,
});

export const WorkingTileSchema = z.object({
  schema: z.literal("terrain-tile-working.v1"),
  lineage_id: uuid4,
  domain: z.literal("roblox-luau"),
  first_seen: rfc3339,
  last_seen: rfc3339,
  observation_count: z.number().int().positive(),
  source_text: z.string(),
  source_ref: z.object({
    repo_url: z.string().url(),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
    path: z.string().min(1),
    retrieved_at: rfc3339,
    license_spdx: z.string().min(1),
  }),
  script_name: z.string().min(1),
  window: z.object({
    t_minus1: WorkingObservation,
    t_now: WorkingObservation,
    t_plus1: WorkingObservation,
  }),
  physics: z.object({
    method: z.enum(["physics-deterministic", "placeholder"]), // placeholder REFUSED at seal
    engine_version: z.string().min(1),
    delta_ms: decimalString,
    determinism_class: z.enum(["engine-exact", "engine-exact-degraded"]),
  }),
  admission: z.object({
    contract_version: z.string().min(1),
    disallowed_globals_hit: z.array(DisallowedGlobal),
    high_risk_patterns_hit: z.array(HighRiskPattern),
    memory_safe: z.boolean(),
  }),
  fingerprint_hex_unpadded: z.string().regex(/^[0-9a-f]{1,32}$/).optional(),
  derived_from_seal: cidString.nullable(),
});

export type WorkingTile = z.infer<typeof WorkingTileSchema>;

// ─── detached seal ───────────────────────────────────────────────────────────

export const SealSchema = z
  .object({
    seal_schema: z.literal("terrain-seal-v1"),
    cid: cidString,
    canon_version: z.literal(1),
    signer: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    sig: z.string().refine(
      (s) => {
        try {
          return Buffer.from(s, "base64").length === 64;
        } catch {
          return false;
        }
      },
      { message: "64-byte Ed25519 signature, base64" }
    ),
    signed_at: rfc3339,
    sig_scope: z.enum(["tile", "pack", "status"]),
  })
  .strict();

export type Seal = z.infer<typeof SealSchema>;

/** Domain-separation prefix: sign over prefix || 0x00 || 32 raw cid digest bytes. */
export const SEAL_SIGN_PREFIX = "terrain-seal-v1";

// ─── pack manifest ───────────────────────────────────────────────────────────

const PackSilence = z.discriminatedUnion("gate", [
  z
    .object({
      gate: z.literal("exact-match"),
      signal: z.literal("content-address"),
    })
    .strict(),
  z
    .object({
      gate: z.literal("threshold"),
      signal: z.enum(["knn-temporal", "hamming", "cosine", "l2-to-centroid"]),
      threshold: decimalString,
      closer_is: z.enum(["lower", "higher"]),
      calibration: z
        .object({
          calibrated: z.literal(true),
          corpus: z.string().min(1),
          corpusSize: z.number().int().positive(),
          date: rfc3339,
          note: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export const PackSchema = z
  .object({
    schema: z.literal("terrain-pack-v1"),
    canon_version: z.literal(1),
    pack_exclusions: z.tuple([z.literal("/seal")]),
    domain: z.literal("roblox-luau"),
    edition: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    snapshot: z
      .object({
        cut_at: rfc3339,
        window_from: rfc3339,
        window_to: rfc3339,
      })
      .strict(),
    prev_pack_cid: cidString.nullable(),
    tiles: z.array(cidString).min(1),
    tile_count: z.number().int().positive(),
    merkle_root: hex64,
    geometry: z
      .object({
        profile: GeometryProfile,
        embed_model: z.literal("mxbai-embed-large"),
        dim_per_third: z.literal(1024),
        concat_dim: z.literal(3072),
        norm_convention: z.literal("per-third-unit-kahan"),
        shatter_scale: z.literal("concat-sqrt3-l2"),
      })
      .strict(),
    centroid: z
      .object({
        centroid_cid: cidString,
        corpus_size: z.number().int().positive(),
        stability: decimalString.nullable(), // null = genesis, NEVER 0
        stability_target: decimalString,
      })
      .strict(),
    silence: PackSilence,
    confidence_model: z
      .object({
        id: z.string().min(1),
        inputs: z.array(z.string().min(1)).min(1),
        shatter_ref: z.record(z.string(), decimalString),
        weights: z.record(z.string(), decimalString),
        form: z.string().min(1),
        clamp: z.tuple([decimalString, decimalString]),
      })
      .strict()
      .nullable(), // null until the shatter-scale contradiction is resolved
    knn: z
      .object({
        k: z.number().int().positive(),
        metric: z.literal("l2-concat-sqrt3"),
        edges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), decimalString])),
      })
      .strict()
      .nullable(),
    license_summary: z
      .object({
        spdx_counts: z.record(z.string(), z.number().int().positive()),
        derivative_release: z.enum(["geometry-only", "geometry-and-embeddings"]),
      })
      .strict(),
    redaction_totals: RedactionLedger,
    status_list_ref: z.string().min(1), // local logical name, never a URL
    carrier_note: z.string().optional(),
    seal: SealSchema.optional(), // the single excluded pointer
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (!sortedUnique(pack.tiles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles"],
        message: "cids must be lexicographically sorted and unique",
      });
    }
    if (pack.tile_count !== pack.tiles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tile_count"],
        message: `declared ${pack.tile_count}, actual ${pack.tiles.length}`,
      });
    }
    if (pack.seal && pack.seal.sig_scope !== "pack") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seal", "sig_scope"],
        message: 'pack seal must have sig_scope "pack"',
      });
    }
    if (pack.knn) {
      const n = pack.tiles.length;
      let prev: readonly [number, number] | null = null;
      for (let e = 0; e < pack.knn.edges.length; e++) {
        const [i, j] = pack.knn.edges[e];
        if (i >= j) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["knn", "edges", e],
            message: "undirected edges stored once with i < j",
          });
        }
        if (j >= n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["knn", "edges", e],
            message: "index out of range",
          });
        }
        if (prev && (prev[0] > i || (prev[0] === i && prev[1] >= j))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["knn", "edges", e],
            message: "edges must be sorted by (i, j) without duplicates",
          });
        }
        prev = [i, j];
      }
    }
  });

export type Pack = z.infer<typeof PackSchema>;

// ─── status / revocation list ────────────────────────────────────────────────

export const StatusReasonCode = z.enum([
  "license-reassessed",
  "source-takedown",
  "centroid-invalid",
  "threshold-uncalibrated",
  "engine-version-mismatch",
  "canonicalization-defect",
  "key-compromise",
  "superseded-by-snapshot",
]);

export const StatusEntrySchema = z
  .object({
    subject_cid: cidString,
    subject_kind: z.enum(["tile", "pack"]),
    status: z.enum(["superseded", "withdrawn-license", "withdrawn-defect", "key-compromised"]),
    reason_code: StatusReasonCode,
    effective_at: rfc3339,
    replacement_cid: cidString.optional(),
  })
  .strict();

export const StatusListSchema = z
  .object({
    schema: z.literal("terrain-status-v1"),
    domain: z.literal("roblox-luau"),
    sequence: z.number().int().nonnegative(), // strictly monotonic across issues
    issued_at: rfc3339,
    next_update: rfc3339, // past this, status is UNKNOWN (fail closed), not active
    entries: z.array(StatusEntrySchema),
    seal: SealSchema.optional(),
  })
  .strict()
  .superRefine((list, ctx) => {
    const cids = list.entries.map((e) => e.subject_cid);
    if (!sortedUnique(cids)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "entries sorted by subject_cid, one entry per subject",
      });
    }
    if (list.seal && list.seal.sig_scope !== "status") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seal", "sig_scope"],
        message: 'status seal must have sig_scope "status"',
      });
    }
  });

export type StatusList = z.infer<typeof StatusListSchema>;

// ─── trust store ─────────────────────────────────────────────────────────────

export const TrustStoreSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  z
    .object({
      public_key_b64: z.string().refine(
        (s) => {
          try {
            return Buffer.from(s, "base64").length === 32;
          } catch {
            return false;
          }
        },
        { message: "32-byte Ed25519 public key, base64" }
      ),
      valid_from: rfc3339,
      valid_until: rfc3339.nullable(),
      status: z.enum(["active", "retired", "revoked"]),
      scopes: z.array(z.enum(["tile", "pack", "status"])).min(1),
    })
    .strict()
);

export type TrustStore = z.infer<typeof TrustStoreSchema>;

// ─── seal admission (the full gate, in order) ────────────────────────────────

export interface SealRefusal {
  code:
    | "FORBIDDEN_KEY"
    | "SCHEMA_INVALID"
    | "LICENSE_DENIED"
    | "PROFILE_LICENSE_CONFLICT";
  detail: string;
}

/**
 * Validate a candidate sealed-tile body. Order matters: the forbidden-key
 * walk runs BEFORE schema validation so a smuggled key is reported as the
 * licensing violation it is, not as an "unknown key" schema nit.
 */
export function admitSealedTile(candidate: unknown): { ok: true; tile: SealedTile } | { ok: false; refusals: SealRefusal[] } {
  const refusals: SealRefusal[] = [];
  for (const hit of findForbiddenKeys(candidate)) {
    refusals.push({ code: "FORBIDDEN_KEY", detail: `${hit.key} at ${hit.path} (${SEALED_FORBIDDEN_KEYS_VERSION})` });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const parsed = SealedTileSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      refusals.push({ code: "SCHEMA_INVALID", detail: `${issue.path.join("/")}: ${issue.message}` });
    }
    return { ok: false, refusals };
  }

  if (SEAL_DENY_LICENSES.has(parsed.data.license.spdx)) {
    refusals.push({ code: "LICENSE_DENIED", detail: `license ${parsed.data.license.spdx} cannot be warranted for sale` });
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, tile: parsed.data };
}
