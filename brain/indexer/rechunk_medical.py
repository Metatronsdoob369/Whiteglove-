"""
rechunk_medical.py — MedlinePlus Staging → Shattered

Reads raw HTML shards from staging/, strips markup, splits into
~500-word semantic chunks, writes clean shards to shattered/.

Safe to re-run: skips already-shattered source IDs.
"""

import json
import os
import re
import hashlib
from pathlib import Path

STAGING_DIR  = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/staging"
OUTPUT_DIR   = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered"
WORDS_PER_CHUNK = 500
MIN_WORDS       = 40       # Discard chunks shorter than this (nav fragments, etc.)
MAX_SHARD_BYTES = 800_000  # 800KB safety cap on output shard

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── HTML stripper ─────────────────────────────────────────────────────────────

TAG_RE     = re.compile(r"<[^>]+>")
SCRIPT_RE  = re.compile(r"<script[^>]*>.*?</script>", re.DOTALL | re.IGNORECASE)
STYLE_RE   = re.compile(r"<style[^>]*>.*?</style>",  re.DOTALL | re.IGNORECASE)
ENTITY_RE  = re.compile(r"&[a-zA-Z]{2,6};|&#\d+;")
WHITESPACE = re.compile(r"\s{2,}")

# Boilerplate that appears on every MedlinePlus page — strip before chunking
BOILERPLATE = [
    r"Skip\s+(to\s+main\s+content|navigation)",
    r"The\s+\.gov\s+means\s+it.s\s+official\..*?Here.s\s+how\s+you\s+know",
    r"Here.s\s+how\s+you\s+know.*?site",
    r"An\s+official\s+website\s+of\s+the\s+United\s+States\s+government",
    r"Official\s+websites\s+use\s+\.gov",
    r"Secure\s+\.gov\s+websites\s+use\s+HTTPS",
    r"A\s+lock\s+.*?means\s+you.ve\s+safely\s+connected",
    r"U\.S\.\s+National\s+Library\s+of\s+Medicine\s+8600\s+Rockville\s+Pike.*",
]
BOILERPLATE_RE = re.compile("|".join(BOILERPLATE), re.IGNORECASE | re.DOTALL)

def strip_html(html: str) -> str:
    text = SCRIPT_RE.sub(" ", html)
    text = STYLE_RE.sub(" ", text)
    text = TAG_RE.sub(" ", text)
    text = ENTITY_RE.sub(" ", text)
    text = BOILERPLATE_RE.sub(" ", text)
    text = WHITESPACE.sub(" ", text)
    return text.strip()

# ── Chunker ───────────────────────────────────────────────────────────────────

def chunk_text(text: str, words_per_chunk: int) -> list[str]:
    words = text.split()
    chunks = []
    for i in range(0, len(words), words_per_chunk):
        chunk = " ".join(words[i : i + words_per_chunk])
        if len(chunk.split()) >= MIN_WORDS:
            chunks.append(chunk)
    return chunks

# ── Already processed? ────────────────────────────────────────────────────────
# Scan existing shattered/ for med_* source IDs so we don't rechunk twice.

def load_processed_ids() -> set[str]:
    processed = set()
    for f in os.scandir(OUTPUT_DIR):
        if not f.name.endswith(".json"):
            continue
        try:
            with open(f.path) as fh:
                d = json.load(fh)
            src_id = d.get("source_shard_id")
            if src_id:
                processed.add(src_id)
        except Exception:
            pass
    return processed

# ── Main ──────────────────────────────────────────────────────────────────────

def rechunk():
    staging_files = sorted(Path(STAGING_DIR).glob("med_*.json"))
    total = len(staging_files)
    print(f"📦 Staging shards found: {total:,}")

    processed_ids = load_processed_ids()
    print(f"✅ Already shattered:    {len(processed_ids):,}")

    shard_counter = 0
    # Start shard IDs after existing med_ shards in output to avoid collisions
    existing = [f.name for f in Path(OUTPUT_DIR).glob("med_chunk_*.json")]
    if existing:
        nums = [int(re.search(r"(\d+)\.json$", f).group(1)) for f in existing if re.search(r"(\d+)\.json$", f)]
        shard_counter = max(nums) + 1 if nums else 0

    skipped   = 0
    written   = 0
    too_short = 0

    for idx, staging_path in enumerate(staging_files):
        source_id = staging_path.stem  # e.g. med_000000

        if source_id in processed_ids:
            skipped += 1
            continue

        try:
            with open(staging_path) as f:
                raw = json.load(f)
        except Exception as e:
            print(f"  ⚠️  Could not read {staging_path.name}: {e}")
            continue

        html_content = raw.get("content", "")
        title        = raw.get("title", "Unknown")
        source       = raw.get("source", "MedlinePlus")
        path_ref     = raw.get("path", "")

        plain = strip_html(html_content)
        if not plain:
            skipped += 1
            continue

        chunks = chunk_text(plain, WORDS_PER_CHUNK)
        if not chunks:
            too_short += 1
            continue

        for chunk_idx, chunk_text_content in enumerate(chunks):
            shard_id   = f"med_chunk_{shard_counter:06d}"
            shard_path = os.path.join(OUTPUT_DIR, f"{shard_id}.json")

            shard = {
                "id": shard_id,
                "source": source,
                "title": title,
                "path": path_ref,
                "source_shard_id": source_id,
                "chunk_index": chunk_idx,
                "total_chunks": len(chunks),
                "content": chunk_text_content,
                "word_count": len(chunk_text_content.split()),
            }

            shard_bytes = json.dumps(shard).encode()
            if len(shard_bytes) > MAX_SHARD_BYTES:
                print(f"  ⚠️  Chunk too large even after stripping ({len(shard_bytes):,}B) — skipping")
                continue

            with open(shard_path, "w") as f:
                json.dump(shard, f)

            shard_counter += 1
            written += 1

        if (idx + 1) % 500 == 0:
            print(f"  [{idx+1:,}/{total:,}] written={written:,} skipped={skipped:,}")

    print(f"\n💎 Rechunk complete.")
    print(f"   Written:   {written:,} clean shards")
    print(f"   Skipped:   {skipped:,} (already done or empty)")
    print(f"   Too short: {too_short:,}")
    print(f"   Output:    {OUTPUT_DIR}")


if __name__ == "__main__":
    rechunk()
