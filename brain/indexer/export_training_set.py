"""
export_training_set.py — WhiteGlove → Training Dataset Exporter

Converts shattered vault shards into a clean, deduplicated JSONL
training dataset compatible with Hugging Face, LLaMA Factory,
Axolotl, and any framework that reads standard JSONL.

Pipeline:
  <shard_dir>/*.json
    → SimHash dedup (drop near-duplicates via Hamming ratio)
    → quality filter (min words, content signal score)
    → JSONL export (HF-compatible schema)
    → manifest (provenance, stats, domain tags)

Usage (medical — original):
    python3 brain/indexer/export_training_set.py

Usage (any domain):
    python3 brain/indexer/export_training_set.py \
        --shards  brain/shards/legal_qa_chunked \
        --out     exports/legal \
        --domain  legal \
        --tag     "LawSE-2026-02" \
        --source  "Law StackExchange" \
        --license public-domain \
        --glob    "law_chunk_*.json"

Output files (in --out dir):
    train.jsonl
    validation.jsonl
    manifest.json
    duplicates.jsonl
"""

import argparse
import json
import os
import re
import random
from pathlib import Path
from typing import Iterator

# ── Defaults (medical, backward-compatible) ───────────────────────────────────

ROOT         = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk"
DEFAULT_SHARDS  = f"{ROOT}/brain/shards/shattered"
DEFAULT_OUT     = f"{ROOT}/exports"
DEFAULT_DOMAIN  = "medical"
DEFAULT_TAG     = "MedlinePlus-2025-01"
DEFAULT_SOURCE  = "MedlinePlus"
DEFAULT_LICENSE = "public-domain"
DEFAULT_GLOB    = "med_chunk_*.json"

DEDUP_THRESHOLD = 0.12
MIN_WORDS       = 60
TRAIN_SPLIT     = 0.95
RANDOM_SEED     = 42
SCHEMA_VERSION  = "whiteglove-v1"

# ── SimHash-64 (pure Python, no dependencies) ─────────────────────────────────

def fnv1a_32(data: bytes) -> int:
    h = 0x811c9dc5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def simhash_64(text: str) -> int:
    words = re.findall(r'\w+', text.lower())
    if not words:
        return 0
    buckets = [0] * 64
    for word in words:
        h  = fnv1a_32(word.encode())
        h2 = fnv1a_32((word + "_b").encode())
        combined = (h2 << 32) | h
        for bit in range(64):
            if combined & (1 << bit):
                buckets[bit] += 1
            else:
                buckets[bit] -= 1
    sig = 0
    for bit in range(64):
        if buckets[bit] > 0:
            sig |= (1 << bit)
    return sig

def hamming_ratio(a: int, b: int, bits: int = 64) -> float:
    return bin(a ^ b).count('1') / bits

# ── Quality scorer ────────────────────────────────────────────────────────────

NOISE_PATTERNS = re.compile(
    r'(skip to|click here|sign up|subscribe|newsletter|cookie|privacy policy|'
    r'terms of use|all rights reserved|share this|back to top|breadcrumb|'
    r'search results|page \d+ of \d+|log in to answer|browse other questions)',
    re.IGNORECASE
)

def quality_score(text: str) -> float:
    words = text.split()
    if len(words) < MIN_WORDS:
        return 0.0
    unique_ratio  = len(set(w.lower() for w in words)) / len(words)
    noise_hits    = len(NOISE_PATTERNS.findall(text))
    noise_penalty = min(1.0, noise_hits / max(1, len(words) / 100))
    punct_count   = sum(1 for c in text if c in '.!?,;:')
    punct_score   = min(1.0, (punct_count / max(1, len(words))) * 10)
    score = (unique_ratio * 0.5) + (punct_score * 0.3) - (noise_penalty * 0.2)
    return max(0.0, min(1.0, score))

# ── HF-compatible record builder ──────────────────────────────────────────────

def build_record(shard: dict, sig: int, score: float,
                 domain: str, source_tag: str, license_: str) -> dict:
    title = shard.get("title", "")
    return {
        "text":           shard["content"],
        "instruction":    f"Provide accurate information about: {title}",
        "output":         shard["content"],
        "id":             shard["id"],
        "source":         shard.get("source", "unknown"),
        "source_tag":     source_tag,
        "domain":         domain,
        "license":        license_,
        "title":          title,
        "path":           shard.get("path", ""),
        "source_shard_id":shard.get("source_shard_id", ""),
        "chunk_index":    shard.get("chunk_index", 0),
        "total_chunks":   shard.get("total_chunks", 1),
        "word_count":     len(shard["content"].split()),
        "quality_score":  round(score, 4),
        "simhash":        sig,
        "schema_version": SCHEMA_VERSION,
    }

# ── Dedup engine ──────────────────────────────────────────────────────────────

class DedupIndex:
    def __init__(self, threshold: float):
        self.threshold = threshold
        self.sigs: list[int] = []

    def is_duplicate(self, sig: int) -> bool:
        for seen in self.sigs:
            if hamming_ratio(sig, seen) < self.threshold:
                return True
        return False

    def add(self, sig: int):
        self.sigs.append(sig)

# ── Shard loader ──────────────────────────────────────────────────────────────

def load_shards(shard_dir: str, glob_pattern: str) -> Iterator[dict]:
    paths = sorted(Path(shard_dir).glob(glob_pattern))
    for p in paths:
        try:
            yield json.load(open(p))
        except Exception:
            continue

# ── Main export ───────────────────────────────────────────────────────────────

def export(shard_dir, output_dir, domain, source_tag, source_name, license_, glob_pattern):
    os.makedirs(output_dir, exist_ok=True)

    train_path    = os.path.join(output_dir, "train.jsonl")
    val_path      = os.path.join(output_dir, "validation.jsonl")
    dupes_path    = os.path.join(output_dir, "duplicates.jsonl")
    manifest_path = os.path.join(output_dir, "manifest.json")

    dedup = DedupIndex(DEDUP_THRESHOLD)
    rng   = random.Random(RANDOM_SEED)

    stats = {
        "total_shards":    0,
        "quality_dropped": 0,
        "dedup_dropped":   0,
        "train_records":   0,
        "val_records":     0,
        "total_words":     0,
        "avg_quality":     0.0,
        "domain":          domain,
        "source_tag":      source_tag,
        "license":         license_,
        "dedup_threshold": DEDUP_THRESHOLD,
        "min_words":       MIN_WORDS,
        "schema_version":  SCHEMA_VERSION,
    }

    quality_sum = 0.0

    with open(train_path, "w") as f_train, \
         open(val_path,   "w") as f_val,   \
         open(dupes_path, "w") as f_dupes:

        for shard in load_shards(shard_dir, glob_pattern):
            stats["total_shards"] += 1
            content = shard.get("content", "")
            words   = content.split()

            if len(words) < MIN_WORDS:
                stats["quality_dropped"] += 1
                continue

            score = quality_score(content)
            if score < 0.15:
                stats["quality_dropped"] += 1
                f_dupes.write(json.dumps({
                    "id": shard["id"], "reason": "quality",
                    "score": round(score, 4), "word_count": len(words)
                }) + "\n")
                continue

            sig = simhash_64(content)
            if dedup.is_duplicate(sig):
                stats["dedup_dropped"] += 1
                f_dupes.write(json.dumps({
                    "id": shard["id"], "reason": "duplicate", "simhash": sig
                }) + "\n")
                continue

            dedup.add(sig)
            record = build_record(shard, sig, score, domain, source_tag, license_)
            quality_sum          += score
            stats["total_words"] += len(words)

            if rng.random() < TRAIN_SPLIT:
                f_train.write(json.dumps(record) + "\n")
                stats["train_records"] += 1
            else:
                f_val.write(json.dumps(record) + "\n")
                stats["val_records"] += 1

            total_kept = stats["train_records"] + stats["val_records"]
            if total_kept % 2000 == 0:
                print(f"  [{stats['total_shards']:,} scanned] "
                      f"kept={total_kept:,} "
                      f"dedup_dropped={stats['dedup_dropped']:,} "
                      f"quality_dropped={stats['quality_dropped']:,}")

    total_kept = stats["train_records"] + stats["val_records"]
    stats["avg_quality"]          = round(quality_sum / max(1, total_kept), 4)
    stats["avg_words_per_record"] = round(stats["total_words"] / max(1, total_kept))
    stats["estimated_tokens"]     = stats["total_words"] * 1.3
    stats["estimated_tokens_billions"] = round(stats["estimated_tokens"] / 1e9, 4)

    with open(manifest_path, "w") as f:
        json.dump(stats, f, indent=2)

    print(f"\n{'='*56}")
    print(f"  WhiteGlove Export — {domain.upper()} — Complete")
    print(f"{'='*56}")
    print(f"  Scanned:         {stats['total_shards']:,} shards")
    print(f"  Quality dropped: {stats['quality_dropped']:,}")
    print(f"  Dedup dropped:   {stats['dedup_dropped']:,}")
    print(f"  Train records:   {stats['train_records']:,}")
    print(f"  Val records:     {stats['val_records']:,}")
    print(f"  Est. tokens:     {stats['estimated_tokens_billions']:.4f}B")
    print(f"  Avg quality:     {stats['avg_quality']:.4f}")
    print(f"  Output:          {output_dir}")
    print(f"{'='*56}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards",  default=DEFAULT_SHARDS,  help="Chunked shard directory")
    parser.add_argument("--out",     default=DEFAULT_OUT,     help="Output directory")
    parser.add_argument("--domain",  default=DEFAULT_DOMAIN,  help="Domain tag (medical, legal, code)")
    parser.add_argument("--tag",     default=DEFAULT_TAG,     help="Source tag (e.g. LawSE-2026-02)")
    parser.add_argument("--source",  default=DEFAULT_SOURCE,  help="Source name")
    parser.add_argument("--license", default=DEFAULT_LICENSE, help="License string")
    parser.add_argument("--glob",    default=DEFAULT_GLOB,    help="Glob pattern for shard files")
    args = parser.parse_args()
    export(args.shards, args.out, args.domain, args.tag, args.source, args.license, args.glob)
