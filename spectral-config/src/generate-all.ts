/**
 * generate-all.ts — one-directional codegen for the x402 kernel.
 *
 * The manifest is the source of truth; these artifacts are derived and never
 * hand-edited (FOLD_SPEC "After the fold"). The kernel reads ONLY these files
 * at runtime — never domains.config.ts — which is also how a CJS/Node-20
 * kernel consumes an ESM/tsx build layer: JSON across the seam.
 *
 * generated.lock carries a digest of every artifact. The kernel re-hashes them
 * at boot and refuses to start on mismatch, so drift is a startup refusal
 * rather than a CI warning.
 *
 * Secrets: payTo, endpoints, and keys are NEVER emitted — only logical refs
 * (same discipline as generate-v2.ts omitting the Pi's Tailscale IP).
 *
 * Usage: npx tsx src/generate-all.ts [--check]
 *   --check regenerates into memory and diffs; exit 1 on drift (CI gate).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "./index.js";
import { auditSealPolicy, type DomainPipeline } from "./manifest.schema.js";
import { canonicalize, cidOfBytes } from "./canon.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(path.join(here, "../../manifests"));
const CHECK = process.argv.includes("--check");

const soldMounts = MANIFEST.pipelines.filter(
  (p): p is DomainPipeline & { commercial: NonNullable<DomainPipeline["commercial"]> } =>
    p.distribution === "sealed-paid" && !!p.commercial && p.commercial.sold
);

// ─── refusals.json — the stable machine-readable error table ──────────────────
// Every transport maps kernel outcomes through this; no transport invents a code.

const REFUSALS = {
  payment_required: { http: 402, retryable: true, meaning: "no usable payment presented; see challenge" },
  payment_invalid: { http: 402, retryable: true, meaning: "payment failed official verification" },
  payment_expired: { http: 402, retryable: true, meaning: "authorization expired before verification" },
  payment_underpaid: { http: 402, retryable: true, meaning: "amount below declared price" },
  payment_wrong_asset: { http: 402, retryable: true, meaning: "asset does not match requirements" },
  payment_wrong_network: { http: 402, retryable: true, meaning: "network does not match requirements" },
  payment_wrong_recipient: { http: 402, retryable: true, meaning: "recipient does not match payTo" },
  settlement_rejected: { http: 402, retryable: false, meaning: "settlement definitively rejected; output locked" },
  payment_id_missing: { http: 402, retryable: true, meaning: "X-Payment-Id header required" },
  payment_id_fingerprint_conflict: { http: 409, retryable: false, meaning: "paymentId already bound to a different request" },
  payment_id_channel_mismatch: { http: 409, retryable: false, meaning: "header paymentId disagrees with extension-carried identifier" },
  call_in_progress: { http: 202, retryable: true, meaning: "a matching request is executing; retry with the same paymentId" },
  entitlement_expired: { http: 410, retryable: false, meaning: "retry entitlement lapsed; issue a new paymentId" },
  settlement_pending_review: { http: 503, retryable: true, meaning: "settlement outcome unresolved; quarantined for operator review" },
  capability_unavailable: { http: 503, retryable: true, meaning: "adapter failed repeatedly; not a payment fault" },
  daily_ceiling_reached: { http: 503, retryable: true, meaning: "operator-declared daily settled-value ceiling reached" },
  tile_not_found: { http: 404, retryable: false, meaning: "unknown cid in this pack (content-address silence)" },
  tile_withdrawn: { http: 451, retryable: false, meaning: "tile withdrawn per the signed status list" },
  status_list_stale: { http: 503, retryable: true, meaning: "revocation status unknown past next_update; failing closed" },
  args_invalid: { http: 400, retryable: false, meaning: "arguments failed strict schema validation" },
  body_too_large: { http: 413, retryable: false, meaning: "request body exceeds the declared cap" },
  rate_limited: { http: 429, retryable: true, meaning: "per-mount rate limit exceeded" },
  tls_required: { http: 400, retryable: false, meaning: "paid route requires https; failing closed" },
  mainnet_gate_unmet: { http: 503, retryable: false, meaning: "mainnet requires a valid signed evidence gate" },
} as const;

// ─── artifacts ────────────────────────────────────────────────────────────────

const GENERATED_NOTE =
  "GENERATED from spectral-config/config/domains.config.ts — do not hand-edit. " +
  "Regenerate with `npm run generate:all` in spectral-config/.";

function routesArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    mounts: soldMounts.map((p) => ({
      mountId: p.id,
      capabilityVersion: p.commercial.capabilityVersion,
      edition: p.commercial.edition,
      effect: p.commercial.effect,
      replaySafe: p.commercial.replaySafe,
      substrate: p.commercial.substrate,
      challengeEpoch: p.commercial.challengeEpoch,
      fingerprintVersion: p.commercial.fingerprintVersion,
      retryEntitlementSeconds: p.commercial.retryEntitlementSeconds,
      resultRetentionSeconds: p.commercial.resultRetentionSeconds,
      limits: p.commercial.limits,
      licenseGate: p.commercial.licenseGate,
      price: {
        scheme: p.commercial.price.scheme,
        networks: p.commercial.price.networks,
        asset: p.commercial.price.asset,
        payToRef: p.commercial.price.payToRef, // logical ref only
      },
      routes: p.commercial.operations.map((op) => ({
        operationId: op.operationId,
        method: "GET",
        pathTemplate:
          op.operationId === "tile_fetch"
            ? `/${p.id}/tile/{cid}`
            : op.operationId === "pack_inclusion_proof"
              ? `/${p.id}/proof/{cid}`
              : `/${p.id}/manifest`,
        resultKind: op.resultKind,
        deadlineMs: op.deadlineMs,
        maxResultBytes: op.maxResultBytes,
        priceAtomic: op.priceAtomic,
      })),
    })),
  };
}

function discoveryArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    x402Version: 2,
    resources: soldMounts.flatMap((p) =>
      p.commercial.operations.map((op) => ({
        resource: `/${p.id}/${op.operationId}`,
        operationId: op.operationId,
        scheme: p.commercial.price.scheme,
        networks: p.commercial.price.networks,
        asset: p.commercial.price.asset,
        priceAtomic: op.priceAtomic,
        challengeEpoch: p.commercial.challengeEpoch,
        replaySafe: p.commercial.replaySafe,
        effect: p.commercial.effect,
        retryEntitlementSeconds: p.commercial.retryEntitlementSeconds,
        compensation: p.commercial.compensation,
      }))
    ),
  };
}

function catalogArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    packs: soldMounts.map((p) => ({
      edition: p.commercial.edition,
      domain: p.id,
      unit: p.commercial.unit,
      geometryProfile: p.commercial.substrate.geometryProfile,
      dims: p.dimensionality.dims,
      temporalAxis: p.dimensionality.temporalAxis,
      description: p.description,
      // What the buyer is told about silence, stated in the gate's own terms.
      gate: p.silence.gate ?? "threshold",
      calibrated: p.silence.calibration.calibrated,
      licenseGate: { denyLicenses: p.commercial.licenseGate.denyLicenses },
      compensation: p.commercial.compensation,
      statusListRef: p.commercial.substrate.statusListRef,
    })),
  };
}

function openapiArtifact() {
  const paths: Record<string, unknown> = {};
  for (const p of soldMounts) {
    for (const r of routesArtifact().mounts.find((m) => m.mountId === p.id)!.routes) {
      const oapiPath = r.pathTemplate.replace(/\{(\w+)\}/g, "{$1}");
      paths[oapiPath] = {
        get: {
          operationId: r.operationId,
          summary: `${r.operationId} (${p.commercial.edition})`,
          parameters: [
            {
              name: "X-Payment-Id",
              in: "header",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
              description:
                "Client identity for one logical paid request across retries. First accepted use binds it to exactly one request fingerprint; reuse with different arguments returns 409.",
            },
            ...(oapiPath.includes("{cid}")
              ? [{ name: "cid", in: "path", required: true, schema: { type: "string", pattern: "^b2-256:[0-9a-f]{64}$" } }]
              : []),
          ],
          responses: {
            "200": { description: "sealed bytes + settlement receipt" },
            "202": { description: "matching request already executing" },
            "402": { description: "x402 v2 payment required / payment fault" },
            "404": { description: "unknown cid (content-address silence)" },
            "409": { description: "paymentId bound to a different request fingerprint" },
            "410": { description: "retry entitlement expired" },
            "503": { description: "settlement pending review, or capability unavailable" },
          },
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Spectral Terrain — paid retrieval",
      version: "1.0.0",
      description: GENERATED_NOTE,
    },
    paths,
  };
}

function mcpToolsArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    tools: soldMounts.flatMap((p) =>
      p.commercial.operations.map((op) => ({
        name: `${p.id.replace(/-/g, "_")}__${op.operationId}`,
        description: `${op.operationId} over sealed pack ${p.commercial.edition} (x402 metered, ${op.priceAtomic} atomic ${p.commercial.price.asset})`,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: op.operationId === "pack_manifest" ? ["paymentId"] : ["paymentId", "cid"],
          properties: {
            paymentId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
            ...(op.operationId === "pack_manifest"
              ? {}
              : { cid: { type: "string", pattern: "^b2-256:[0-9a-f]{64}$" } }),
          },
        },
      }))
    ),
  };
}

function runtimePolicyArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    paid: {
      port: 8787,
      bodyCapBytes: 65536,
      requireTls: true,
      cacheControl: "no-store",
      rateLimit: { windowSeconds: 60, maxRequests: 120, anonymous402MaxRequests: 30 },
    },
    ops: {
      port: 8788,
      loopbackOnly: true,
      bodyCapBytes: 262144,
      auth: "ed25519-request-signature",
      rateLimit: { windowSeconds: 60, maxRequests: 5 },
      reconcileRequiresFlag: "--allow-reconcile",
    },
    ledger: {
      journalMode: "WAL",
      synchronous: "FULL",
      busyTimeoutMs: 5000,
      writeTransaction: "BEGIN IMMEDIATE",
    },
    networks: {
      allowed: [...new Set(soldMounts.flatMap((p) => p.commercial.price.networks))],
      mainnetStartupBlocked: ["eip155:8453"],
      mainnetGateArtifact: "manifests/mainnet-gate.json",
    },
    revocation: { maxStalenessSeconds: 86400, staleBehavior: "fail-closed-unknown" },
    perMount: Object.fromEntries(
      soldMounts.map((p) => [
        p.id,
        {
          deadlineMsByOperation: Object.fromEntries(p.commercial.operations.map((o) => [o.operationId, o.deadlineMs])),
          maxResultBytesByOperation: Object.fromEntries(p.commercial.operations.map((o) => [o.operationId, o.maxResultBytes])),
          limits: p.commercial.limits,
        },
      ])
    ),
  };
}

function fingerprintSpecArtifact() {
  return {
    version: "1.0",
    description: GENERATED_NOTE,
    canonicalization: {
      rule: "jcs-rfc8785 + no-json-floats + nfc-required",
      canonVersion: 1,
      hash: "blake2b-512-truncated-32",
      cidPrefix: "b2-256:",
    },
    // Two fingerprints, deliberately. A single hash over payment nonce/expiry
    // would 409 a client that legitimately re-signs after authorization
    // expiry — the production double-charge hazard documented in ClawRouter's
    // payment-preauth.ts. Every requestFingerprint input is knowable BEFORE
    // any payment payload, which is what makes 409/202/replay/410 all
    // pre-payment admission decisions.
    requestFingerprint: {
      version: soldMounts[0]?.commercial.fingerprintVersion ?? "fp-v1",
      inputs: [
        "operationId",
        "capabilityVersion",
        "adapterVersion",
        "argDigest",
        "scheme",
        "network",
        "asset",
        "amountAtomic",
        "payTo",
        "substratePackId",
      ],
    },
    authorizationFingerprint: {
      version: soldMounts[0]?.commercial.fingerprintVersion ?? "fp-v1",
      inputs: ["requestFingerprint", "paymentNonce", "paymentExpiry", "payer"],
      maxPerPaymentId: 3,
      refusedAtOrAfterState: "settling",
    },
  };
}

function refusalsArtifact() {
  return { version: "1.0", description: GENERATED_NOTE, codes: REFUSALS };
}

// ─── emit + lock ──────────────────────────────────────────────────────────────

const ARTIFACTS: Array<[string, () => unknown]> = [
  ["x402-routes.json", routesArtifact],
  ["openapi.json", openapiArtifact],
  ["discovery.json", discoveryArtifact],
  ["catalog.json", catalogArtifact],
  ["mcp-tools.json", mcpToolsArtifact],
  ["runtime-policy.json", runtimePolicyArtifact],
  ["fingerprint-spec.json", fingerprintSpecArtifact],
  ["refusals.json", refusalsArtifact],
];

function render(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const rendered = new Map<string, string>();
for (const [name, build] of ARTIFACTS) rendered.set(name, render(build()));

// The lock digests the CANONICAL form of each artifact, so the kernel's
// boot-time check cannot be defeated by reformatting.
const lock = {
  version: "1.0",
  description: GENERATED_NOTE,
  canonVersion: 1,
  artifacts: Object.fromEntries(
    [...rendered.entries()].map(([name, text]) => [name, cidOfBytes(canonicalize(JSON.parse(text)))])
  ),
};
rendered.set("generated.lock", render(lock));

if (CHECK) {
  let drift = 0;
  for (const [name, text] of rendered) {
    const p = path.join(OUT_DIR, name);
    const onDisk = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (onDisk === null) {
      console.error(`DRIFT ${name}: missing on disk`);
      drift++;
    } else if (onDisk !== text) {
      console.error(`DRIFT ${name}: on-disk copy differs from the manifest`);
      drift++;
    } else {
      console.log(`ok    ${name}`);
    }
  }
  if (drift > 0) {
    console.error(`\n${drift} artifact(s) drifted — run npm run generate:all`);
    process.exit(1);
  }
  console.log(`\n${rendered.size} generated artifacts match the manifest (no drift)`);
} else {
  for (const [name, text] of rendered) writeFileSync(path.join(OUT_DIR, name), text);
  console.log(`Generated ${rendered.size} artifacts in ${OUT_DIR} from ${MANIFEST.pipelines.length} pipelines (${soldMounts.length} sold).`);
  const flags = auditSealPolicy(MANIFEST);
  if (flags.length > 0) {
    console.log("\nauditSealPolicy (soft — the honest to-do list, not a refusal):");
    for (const f of flags) console.log(`  ${f.id}: ${f.reason}`);
  }
}
