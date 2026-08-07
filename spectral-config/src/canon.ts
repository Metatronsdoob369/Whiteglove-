/**
 * canon.ts — terrain canonicalization, canon_version 1.
 *
 * Rule id: "jcs-rfc8785 + no-json-floats + nfc-required" (spec:
 * docs/superpowers/specs/2026-08-05-terrain-tile-v1-design.md).
 *
 * RFC 8785 (JCS) with one deliberate narrowing: no non-integer JSON number
 * is ever admitted, so the ECMAScript shortest-round-trip number rule —
 * the one place JCS implementations diverge across languages — never
 * executes. Non-integer reals travel as decimal strings; vectors travel
 * as vecref (raw IEEE-754 bytes, base64).
 *
 * cid construction (normative): "b2-256:" + hex of the FIRST 32 BYTES of
 * an unkeyed BLAKE2b-512 digest. Node has no native BLAKE2b-256, and
 * Python's blake2b(digest_size=32) is a DIFFERENT function than truncated
 * blake2b512 — truncation is the one construction both languages compute
 * natively and identically. Python reference: test/golden/canon_ref.py.
 *
 * Key ordering (normative): UTF-16 code units per JCS. Python code-point
 * sort disagrees for astral-plane keys; the reference sorts on UTF-16-BE
 * bytes and the golden vectors include a case that catches the divergence.
 */

import { createHash } from "node:crypto";

export const CANON_VERSION = 1;

export type CanonRefusalCode =
  | "CANON_INVALID_TYPE"
  | "CANON_FLOAT_REFUSED"
  | "CANON_INT_RANGE"
  | "CANON_NEG_ZERO"
  | "CANON_NON_NFC"
  | "CANON_UNPAIRED_SURROGATE"
  | "CANON_FORBIDDEN_CODEPOINT";

export class CanonRefusal extends Error {
  constructor(
    public readonly code: CanonRefusalCode,
    public readonly path: string,
    detail: string
  ) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "CanonRefusal";
  }
}

const MAX_SAFE = 9007199254740991; // 2^53 - 1

// Refused as content: C0 except \t \n, C1, U+FEFF, and all of category Cf
// (bidi overrides, zero-width joiners — smuggling vectors in public-repo text).
const FORBIDDEN_RE =
  /[\u0000-\u0008\u000B-\u001F\u0080-\u009F\uFEFF]|\p{Cf}/u;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertStringAdmissible(s: string, path: string): void {
  if (hasLoneSurrogate(s)) {
    throw new CanonRefusal("CANON_UNPAIRED_SURROGATE", path, "lone surrogate");
  }
  if (s.normalize("NFC") !== s) {
    throw new CanonRefusal(
      "CANON_NON_NFC",
      path,
      "not NFC; normalize in the working layer, never at seal"
    );
  }
  const m = FORBIDDEN_RE.exec(s);
  if (m) {
    throw new CanonRefusal(
      "CANON_FORBIDDEN_CODEPOINT",
      path,
      `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    );
  }
}

/** UTF-16 code-unit comparison — exactly ECMAScript's default string <. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number": {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new CanonRefusal(
          "CANON_FLOAT_REFUSED",
          path,
          "non-integer JSON numbers never appear in hashed payloads; use a decimal string or vecref"
        );
      }
      if (Object.is(value, -0)) {
        throw new CanonRefusal("CANON_NEG_ZERO", path, "-0 refused");
      }
      if (Math.abs(value) > MAX_SAFE) {
        throw new CanonRefusal("CANON_INT_RANGE", path, "outside ±(2^53−1)");
      }
      out.push(String(value));
      return;
    }
    case "string":
      assertStringAdmissible(value, path);
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          serialize(value[i], `${path}/${i}`, out);
        }
        out.push("]");
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonRefusal("CANON_INVALID_TYPE", path, "non-plain object");
      }
      const keys = Object.keys(value as Record<string, unknown>).sort(compareUtf16);
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        assertStringAdmissible(k, `${path}/${k}`);
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        serialize((value as Record<string, unknown>)[k], `${path}/${k}`, out);
      }
      out.push("}");
      return;
    }
    default:
      throw new CanonRefusal("CANON_INVALID_TYPE", path, `typeof ${typeof value}`);
  }
}

/** Canonical bytes of a value under canon_version 1. Refuses, never repairs. */
export function canonicalize(value: unknown): Buffer {
  const out: string[] = [];
  serialize(value, "", out);
  return Buffer.from(out.join(""), "utf8");
}

/** "b2-256:" + hex of the first 32 bytes of BLAKE2b-512 over the bytes. */
export function cidOfBytes(bytes: Buffer): string {
  const digest = createHash("blake2b512").update(bytes).digest();
  return `b2-256:${digest.subarray(0, 32).toString("hex")}`;
}

/** cid of a value: canonicalize, then hash. */
export function cidOf(value: unknown): string {
  return cidOfBytes(canonicalize(value));
}

export const CID_RE = /^b2-256:[0-9a-f]{64}$/;

// ─── decimal strings ─────────────────────────────────────────────────────────

export const DECIMAL_STRING_RE =
  /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;

export function isDecimalString(s: string): boolean {
  if (!DECIMAL_STRING_RE.test(s)) return false;
  if (s.startsWith("-") && Number(s) === 0) return false; // -0 in any spelling
  return Number.isFinite(Number(s));
}

// ─── vecref ──────────────────────────────────────────────────────────────────

export type VecDtype = "f64le" | "f32le";

export interface Vecref {
  dtype: VecDtype;
  count: number;
  b64: string;
}

const DTYPE_BYTES: Record<VecDtype, number> = { f64le: 8, f32le: 4 };

export function encodeVecref(values: ArrayLike<number>, dtype: VecDtype): Vecref {
  const n = values.length;
  const buf = Buffer.alloc(n * DTYPE_BYTES[dtype]);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      throw new CanonRefusal("CANON_FLOAT_REFUSED", `/vecref/${i}`, "non-finite component");
    }
    if (dtype === "f64le") buf.writeDoubleLE(v, i * 8);
    else buf.writeFloatLE(Math.fround(v), i * 4);
  }
  return { dtype, count: n, b64: buf.toString("base64") };
}

export function decodeVecref(ref: Vecref): Float64Array {
  const buf = Buffer.from(ref.b64, "base64");
  if (buf.length !== ref.count * DTYPE_BYTES[ref.dtype]) {
    throw new CanonRefusal(
      "CANON_INVALID_TYPE",
      "/vecref",
      "byte length disagrees with count×dtype"
    );
  }
  const outArr = new Float64Array(ref.count);
  for (let i = 0; i < ref.count; i++) {
    outArr[i] = ref.dtype === "f64le" ? buf.readDoubleLE(i * 8) : buf.readFloatLE(i * 4);
  }
  return outArr;
}
