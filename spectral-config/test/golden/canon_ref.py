#!/usr/bin/env python3
"""canon_ref.py - independent Python reference for canon_version 1.

Reads golden/vectors.json (produced by the TypeScript implementation),
re-canonicalizes every body from scratch, recomputes every cid, and fails
on any byte-level disagreement. This differential is the real test: the
highest-probability failure in the whole design is TS and Python silently
disagreeing about canonical bytes.

Normative rules mirrored here:
  - key order: UTF-16 CODE UNITS (JCS). Python's default str sort is by
    code point, which DIVERGES for astral-plane keys - so keys are sorted
    by their UTF-16-BE encoding. vectors.json contains a case that fails
    under a naive sort.
  - no non-integer JSON numbers, refuse |int| > 2^53-1 and bool-as-int mixups.
  - strings must be NFC; C0 (except tab/newline), C1, U+FEFF, and category
    Cf code points are refused.
  - string escaping: json.dumps(s, ensure_ascii=False) - byte-identical to
    JSON.stringify for the admitted string repertoire.
  - cid: "b2-256:" + hex of the FIRST 32 BYTES of unkeyed BLAKE2b-512.
    NOTE: hashlib.blake2b(digest_size=32) is a DIFFERENT function; the
    truncated-512 construction is deliberate (Node has no native b2b-256).
"""
import base64
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

MAX_SAFE = 2**53 - 1


class CanonRefusal(Exception):
    pass


def assert_string_admissible(s: str, path: str) -> None:
    # Python str cannot hold lone surrogates from json.loads of valid JSON,
    # but surrogate escapes can appear via surrogatepass decoding - check anyway.
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        raise CanonRefusal(f"CANON_UNPAIRED_SURROGATE at {path}")
    if not unicodedata.is_normalized("NFC", s):
        raise CanonRefusal(f"CANON_NON_NFC at {path}")
    for ch in s:
        o = ord(ch)
        if o < 0x20 and ch not in ("\t", "\n"):
            raise CanonRefusal(f"CANON_FORBIDDEN_CODEPOINT U+{o:04X} at {path}")
        if 0x80 <= o <= 0x9F or o == 0xFEFF or unicodedata.category(ch) == "Cf":
            raise CanonRefusal(f"CANON_FORBIDDEN_CODEPOINT U+{o:04X} at {path}")


def serialize(value, path: str, out: list) -> None:
    if value is None:
        out.append("null")
    elif isinstance(value, bool):  # MUST precede int check: bool subclasses int
        out.append("true" if value else "false")
    elif isinstance(value, int):
        if abs(value) > MAX_SAFE:
            raise CanonRefusal(f"CANON_INT_RANGE at {path}")
        out.append(str(value))
    elif isinstance(value, float):
        raise CanonRefusal(f"CANON_FLOAT_REFUSED at {path}")
    elif isinstance(value, str):
        assert_string_admissible(value, path)
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, list):
        out.append("[")
        for i, v in enumerate(value):
            if i:
                out.append(",")
            serialize(v, f"{path}/{i}", out)
        out.append("]")
    elif isinstance(value, dict):
        # JCS: sort by UTF-16 code units, not code points.
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        out.append("{")
        for i, k in enumerate(keys):
            if not isinstance(k, str):
                raise CanonRefusal(f"CANON_INVALID_TYPE key at {path}")
            assert_string_admissible(k, f"{path}/{k}")
            if i:
                out.append(",")
            out.append(json.dumps(k, ensure_ascii=False))
            out.append(":")
            serialize(value[k], f"{path}/{k}", out)
        out.append("}")
    else:
        raise CanonRefusal(f"CANON_INVALID_TYPE {type(value).__name__} at {path}")


def canonicalize(value) -> bytes:
    out: list = []
    serialize(value, "", out)
    return "".join(out).encode("utf-8")


def cid_of(value) -> str:
    digest = hashlib.blake2b(canonicalize(value), digest_size=64).digest()
    return "b2-256:" + digest[:32].hex()


def main() -> int:
    vectors_path = Path(__file__).parent / "vectors.json"
    vectors = json.loads(vectors_path.read_text(encoding="utf-8"))
    failed = 0
    for v in vectors:
        try:
            canonical = canonicalize(v["body"])
            cid = cid_of(v["body"])
        except CanonRefusal as e:
            print(f"FAIL {v['name']}: unexpected refusal: {e}")
            failed += 1
            continue
        expected_bytes = base64.b64decode(v["canonical_utf8_b64"])
        if canonical != expected_bytes:
            print(f"FAIL {v['name']}: canonical bytes diverge from TS")
            failed += 1
        elif cid != v["expected_cid"]:
            print(f"FAIL {v['name']}: cid diverges ({cid} != {v['expected_cid']})")
            failed += 1
        else:
            print(f"ok   {v['name']}  {cid[:24]}...")
    if failed:
        print(f"{failed}/{len(vectors)} DIVERGED - cross-language canon is broken; do not seal")
        return 1
    print(f"{len(vectors)}/{len(vectors)} golden vectors verified (Python)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
