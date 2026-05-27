"""
rechunk_domain.py — Domain-agnostic WhiteGlove Rechunker

Reads raw HTML shards from a staging dir, strips markup, splits into
~500-word semantic chunks, writes clean shards to an output dir.

Safe to re-run: skips already-processed source IDs.

Usage:
    python3 brain/indexer/rechunk_domain.py \
        --staging  brain/shards/legal_qa \
        --out      brain/shards/legal_qa_chunked \
        --prefix   law_chunk \
        --source   "Law StackExchange" \
        --domain   legal \
        --tag      "LawSE-2026-02"
"""

import argparse
import json
import os
import re
from pathlib import Path

WORDS_PER_CHUNK = 500
MIN_WORDS       = 40
MAX_SHARD_BYTES = 800_000

# ── HTML stripper ─────────────────────────────────────────────────────────────

TAG_RE     = re.compile(r"<[^>]+>")
SCRIPT_RE  = re.compile(r"<script[^>]*>.*?</script>", re.DOTALL | re.IGNORECASE)
STYLE_RE   = re.compile(r"<style[^>]*>.*?</style>",  re.DOTALL | re.IGNORECASE)
ENTITY_RE  = re.compile(r"&[a-zA-Z]{2,6};|&#\d+;")
WHITESPACE = re.compile(r"\s{2,}")

# Generic boilerplate patterns (Stack Exchange, Gutenberg, gov sites)
BOILERPLATE = [
    r"Skip\s+(to\s+main\s+content|navigation)",
    r"Stack\s+Exchange\s+network\s+consists\s+of.*?communities",
    r"By\s+clicking\s+.Accept\s+all\s+cookies.",
    r"You\s+must\s+log\s+in\s+to\s+answer\s+this\s+question",
    r"Browse\s+other\s+questions\s+tagged",
    r"Not\s+the\s+answer\s+you.re\s+looking\s+for",
    r"Hot\s+Network\s+Questions",
    r"Question\s+feed",
    r"Project\s+Gutenberg.*?eBook",
    r"This\s+eBook\s+is\s+for\s+the\s+use\s+of\s+anyone",
    r"An\s+official\s+website\s+of\s+the\s+United\s+States\s+government",
    r"The\s+\.gov\s+means\s+it.s\s+official",
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

def chunk_text(text: str) -> list[str]:
    words = text.split()
    chunks = []
    for i in range(0, len(words), WORDS_PER_CHUNK):
        chunk = " ".join(words[i : i + WORDS_PER_CHUNK])
        if len(chunk.split()) >= MIN_WORDS:
            chunks.append(chunk)
    return chunks

# ── Already processed? ────────────────────────────────────────────────────────

def load_processed_ids(output_dir: str, prefix: str) -> set[str]:
    processed = set()
    for f in os.scandir(output_dir):
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

def rechunk(staging_dir, output_dir, prefix, source_name, domain, source_tag):
    os.makedirs(output_dir, exist_ok=True)

    staging_files = sorted(Path(staging_dir).glob("*.json"))
    total = len(staging_files)
    print(f"Staging shards found: {total:,}")

    processed_ids = load_processed_ids(output_dir, prefix)
    print(f"Already chunked:      {len(processed_ids):,}")

    # Pick up shard counter where we left off
    existing = [f.name for f in Path(output_dir).glob(f"{prefix}_*.json")]
    shard_counter = 0
    if existing:
        nums = [int(re.search(r"(\d+)\.json$", f).group(1)) for f in existing if re.search(r"(\d+)\.json$", f)]
        shard_counter = max(nums) + 1 if nums else 0

    skipped = written = too_short = 0

    for idx, staging_path in enumerate(staging_files):
        source_id = staging_path.stem

        if source_id in processed_ids:
            skipped += 1
            continue

        try:
            with open(staging_path) as f:
                raw = json.load(f)
        except Exception as e:
            print(f"  Could not read {staging_path.name}: {e}")
            continue

        html_content = raw.get("content", "")
        title        = raw.get("title", "Unknown")
        path_ref     = raw.get("path", "")

        plain = strip_html(html_content)
        if not plain:
            skipped += 1
            continue

        chunks = chunk_text(plain)
        if not chunks:
            too_short += 1
            continue

        for chunk_idx, chunk_content in enumerate(chunks):
            shard_id   = f"{prefix}_{shard_counter:06d}"
            shard_path = os.path.join(output_dir, f"{shard_id}.json")

            shard = {
                "id": shard_id,
                "source": source_name,
                "source_tag": source_tag,
                "domain": domain,
                "license": "public-domain",
                "title": title,
                "path": path_ref,
                "source_shard_id": source_id,
                "chunk_index": chunk_idx,
                "total_chunks": len(chunks),
                "content": chunk_content,
                "word_count": len(chunk_content.split()),
            }

            if len(json.dumps(shard).encode()) > MAX_SHARD_BYTES:
                print(f"  Chunk too large — skipping")
                continue

            with open(shard_path, "w") as f:
                json.dump(shard, f)

            shard_counter += 1
            written += 1

        if (idx + 1) % 500 == 0:
            print(f"  [{idx+1:,}/{total:,}] written={written:,} skipped={skipped:,}")

    print(f"\nRechunk complete.")
    print(f"  Written:   {written:,} clean shards")
    print(f"  Skipped:   {skipped:,}")
    print(f"  Too short: {too_short:,}")
    print(f"  Output:    {output_dir}")


if __name__ == "__main__":
    ROOT = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk"
    parser = argparse.ArgumentParser()
    parser.add_argument("--staging",  required=True,          help="Input shard directory")
    parser.add_argument("--out",      required=True,          help="Output chunked shard directory")
    parser.add_argument("--prefix",   default="chunk",        help="Shard ID prefix")
    parser.add_argument("--source",   default="Unknown",      help="Source name for metadata")
    parser.add_argument("--domain",   default="general",      help="Domain tag (legal, medical, code, etc.)")
    parser.add_argument("--tag",      default="unknown",      help="Source tag (e.g. LawSE-2026-02)")
    args = parser.parse_args()
    rechunk(args.staging, args.out, args.prefix, args.source, args.domain, args.tag)
