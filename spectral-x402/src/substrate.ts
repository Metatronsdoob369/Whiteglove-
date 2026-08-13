/**
 * substrate.ts — sealed pack loading, verification, and O(log n) lookup.
 *
 * A pack is verified ONCE at boot (merkle root + detached seal) and held in
 * memory for the process lifetime. Per-call cost is a binary search over
 * fixed-width keys plus a Buffer.subarray — no parse, no copy, no I/O.
 * That is what makes micro-pricing honest: the marginal cost of a paid call
 * is dominated by the ledger fsyncs we deliberately chose, not by the data path.
 *
 * On-disk layout:
 *   <pack>.idx  — u32 count, then count × (32-byte cid digest | u64 offset | u32 len), sorted by digest
 *   <pack>.dat  — concatenated canonical tile bytes
 *   <pack>.manifest.json — terrain-pack-v1 body
 *   <pack>.seal.json     — detached Ed25519 seal over the manifest cid
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash, verify as edVerify } from "node:crypto";

const REC = 44; // 32 digest + 8 offset + 4 len

export class SubstrateRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SubstrateRefusal";
  }
}

function b2_256(bytes: Buffer): Buffer {
  return Buffer.from(createHash("blake2b512").update(bytes).digest().subarray(0, 32));
}

/** JCS-canonical bytes with integer-only numbers (mirrors spectral-config/canon.ts). */
export function canonicalize(value: unknown): Buffer {
  const out: string[] = [];
  const ser = (v: unknown): void => {
    if (v === null) return void out.push("null");
    if (typeof v === "boolean") return void out.push(v ? "true" : "false");
    if (typeof v === "number") {
      if (!Number.isInteger(v) || Object.is(v, -0)) {
        throw new SubstrateRefusal("CANON_FLOAT", "non-integer JSON number in a hashed payload");
      }
      return void out.push(String(v));
    }
    if (typeof v === "string") return void out.push(JSON.stringify(v));
    if (Array.isArray(v)) {
      out.push("[");
      v.forEach((x, i) => {
        if (i) out.push(",");
        ser(x);
      });
      return void out.push("]");
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.push("{");
      keys.forEach((k, i) => {
        if (i) out.push(",");
        out.push(JSON.stringify(k), ":");
        ser((v as Record<string, unknown>)[k]);
      });
      return void out.push("}");
    }
    throw new SubstrateRefusal("CANON_TYPE", `unserializable: ${typeof v}`);
  };
  ser(value);
  return Buffer.from(out.join(""), "utf8");
}

export function cidOf(value: unknown): string {
  return `b2-256:${b2_256(canonicalize(value)).toString("hex")}`;
}

/** RFC 6962 merkle root. Odd nodes are PROMOTED, never duplicated (CVE-2012-2459). */
export function merkleRoot(leafDigests: Buffer[]): Buffer {
  if (leafDigests.length === 0) return Buffer.alloc(32);
  let level: Buffer[] = leafDigests.map((d) =>
    Buffer.from(createHash("blake2b512").update(Buffer.concat([Buffer.from([0]), d])).digest().subarray(0, 32))
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]); // promote, do not duplicate
      } else {
        next.push(
          Buffer.from(
            createHash("blake2b512")
              .update(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]]))
              .digest()
              .subarray(0, 32)
          )
        );
      }
    }
    level = next;
  }
  return level[0];
}

export function inclusionProof(leafDigests: Buffer[], index: number): Array<{ side: "L" | "R"; hash: string }> {
  const path: Array<{ side: "L" | "R"; hash: string }> = [];
  let level: Buffer[] = leafDigests.map((d) =>
    Buffer.from(createHash("blake2b512").update(Buffer.concat([Buffer.from([0]), d])).digest().subarray(0, 32))
  );
  let idx = index;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        if (i === idx) idx = next.length;
        next.push(level[i]);
      } else {
        if (i === idx) path.push({ side: "R", hash: level[i + 1].toString("hex") });
        else if (i + 1 === idx) path.push({ side: "L", hash: level[i].toString("hex") });
        if (i === idx || i + 1 === idx) idx = next.length;
        next.push(
          Buffer.from(
            createHash("blake2b512")
              .update(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]]))
              .digest()
              .subarray(0, 32)
          )
        );
      }
    }
    level = next;
  }
  return path;
}

export interface TrustEntry {
  public_key_b64: string;
  valid_from: string;
  valid_until: string | null;
  status: "active" | "retired" | "revoked";
  scopes: Array<"tile" | "pack" | "status">;
}

/** Ed25519 raw 32-byte key → SPKI DER, so node:crypto can import it. */
export function rawEd25519ToSpki(raw: Buffer): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
}

export class Substrate {
  private idx: Buffer;
  private dat: Buffer;
  private count: number;
  readonly packId: string;
  readonly merkleRootHex: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestCid: string;
  /**
   * Declared media type of the payloads in this pack. The kernel is payload-
   * agnostic — it addresses opaque bytes by content hash and never parses
   * them — so this is the only thing that has to be stated, and it is stated
   * once, in the sealed (therefore signed) manifest.
   */
  readonly payloadContentType: string;

  private constructor(a: {
    idx: Buffer;
    dat: Buffer;
    count: number;
    packId: string;
    merkleRootHex: string;
    manifest: Record<string, unknown>;
    manifestCid: string;
    payloadContentType: string;
  }) {
    this.idx = a.idx;
    this.dat = a.dat;
    this.count = a.count;
    this.packId = a.packId;
    this.merkleRootHex = a.merkleRootHex;
    this.manifest = a.manifest;
    this.manifestCid = a.manifestCid;
    this.payloadContentType = a.payloadContentType;
  }

  /**
   * Load and verify. Every failure here is a startup refusal — a pack that
   * cannot prove itself never gets to serve a paid byte.
   */
  static load(basePath: string, trustStore: Record<string, TrustEntry>): Substrate {
    for (const ext of [".idx", ".dat", ".manifest.json", ".seal.json"]) {
      if (!existsSync(basePath + ext)) {
        throw new SubstrateRefusal("PACK_INCOMPLETE", `missing ${basePath}${ext}`);
      }
    }
    const idx = readFileSync(basePath + ".idx");
    const dat = readFileSync(basePath + ".dat");
    const manifest = JSON.parse(readFileSync(basePath + ".manifest.json", "utf8")) as Record<string, unknown>;
    const seal = JSON.parse(readFileSync(basePath + ".seal.json", "utf8")) as Record<string, string>;

    const count = idx.readUInt32LE(0);
    if (idx.length !== 4 + count * REC) {
      throw new SubstrateRefusal("IDX_MALFORMED", "index length disagrees with its declared count");
    }

    // Index must be sorted — the binary search depends on it, and a manifest
    // whose tile order differs would hash differently.
    const digests: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const d = idx.subarray(4 + i * REC, 4 + i * REC + 32);
      if (i > 0 && Buffer.compare(digests[i - 1], d) >= 0) {
        throw new SubstrateRefusal("IDX_UNSORTED", `index not strictly sorted at record ${i}`);
      }
      digests.push(d);
    }

    // Every stored tile must hash to the cid that names it. This is the check
    // that makes the manifest attest to CONTENT rather than to a list of names.
    for (let i = 0; i < count; i++) {
      const off = Number(idx.readBigUInt64LE(4 + i * REC + 32));
      const len = idx.readUInt32LE(4 + i * REC + 40);
      const actual = b2_256(dat.subarray(off, off + len));
      if (!actual.equals(digests[i])) {
        throw new SubstrateRefusal("TILE_DIGEST_MISMATCH", `tile ${i} content does not match its cid`);
      }
    }

    const root = merkleRoot(digests);
    const declaredRoot = manifest.merkle_root as string;
    if (root.toString("hex") !== declaredRoot) {
      throw new SubstrateRefusal("MERKLE_MISMATCH", "computed merkle root differs from the manifest");
    }

    // Detached seal: signature is over the manifest's cid digest bytes with a
    // domain-separation prefix, and the key comes from the LOCAL trust store —
    // never from a reference inside the document.
    const { seal: _omit, ...body } = manifest as Record<string, unknown> & { seal?: unknown };
    const manifestCid = cidOf(body);
    const signer = seal.signer;
    const entry = trustStore[signer];
    if (!entry) throw new SubstrateRefusal("UNKNOWN_SIGNER", `signer "${signer}" is not in the local trust store`);
    if (entry.status === "revoked") throw new SubstrateRefusal("SIGNER_REVOKED", `signer "${signer}" is revoked`);
    if (!entry.scopes.includes("pack")) throw new SubstrateRefusal("SCOPE_REFUSED", `signer "${signer}" may not sign packs`);
    if (seal.cid !== manifestCid) throw new SubstrateRefusal("SEAL_SUBJECT_MISMATCH", "seal names a different cid than the manifest hashes to");

    const message = Buffer.concat([
      Buffer.from("terrain-seal-v1", "utf8"),
      Buffer.from([0]),
      Buffer.from(manifestCid.slice("b2-256:".length), "hex"),
    ]);
    const ok = edVerify(
      null,
      message,
      { key: rawEd25519ToSpki(Buffer.from(entry.public_key_b64, "base64")), format: "der", type: "spki" },
      Buffer.from(seal.sig, "base64")
    );
    if (!ok) throw new SubstrateRefusal("SEAL_INVALID", "detached seal failed verification");

    return new Substrate({
      idx,
      dat,
      count,
      packId: manifest.edition as string,
      merkleRootHex: declaredRoot,
      manifest,
      manifestCid,
      // Default keeps every existing pack valid; new packs declare their own.
      payloadContentType: (manifest.payload_content_type as string) ?? "application/json",
    });
  }

  get tileCount(): number {
    return this.count;
  }

  /** Binary search over 32-byte keys. O(log n), zero allocation beyond the view. */
  private indexOf(cid: string): number {
    if (!/^b2-256:[0-9a-f]{64}$/.test(cid)) return -1;
    const target = Buffer.from(cid.slice(7), "hex");
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = Buffer.compare(this.idx.subarray(4 + mid * REC, 4 + mid * REC + 32), target);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Canonical tile bytes, verbatim from the pack. No parse, no copy. */
  getTile(cid: string): Buffer | null {
    const i = this.indexOf(cid);
    if (i < 0) return null;
    const off = Number(this.idx.readBigUInt64LE(4 + i * REC + 32));
    const len = this.idx.readUInt32LE(4 + i * REC + 40);
    return this.dat.subarray(off, off + len);
  }

  getInclusionProof(cid: string): { cid: string; index: number; merkleRoot: string; path: Array<{ side: string; hash: string }> } | null {
    const i = this.indexOf(cid);
    if (i < 0) return null;
    const digests: Buffer[] = [];
    for (let k = 0; k < this.count; k++) digests.push(this.idx.subarray(4 + k * REC, 4 + k * REC + 32));
    return { cid, index: i, merkleRoot: this.merkleRootHex, path: inclusionProof(digests, i) };
  }

  getManifest(): Record<string, unknown> {
    return this.manifest;
  }
}
