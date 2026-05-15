"""
export_training_set.py — WhiteGlove → Training Dataset Exporter

Converts shattered vault shards into a clean, deduplicated JSONL
training dataset compatible with Hugging Face, LLaMA Factory,
Axolotl, and any framework that reads standard JSONL.

Pipeline:
  shattered/*.json
    → SimHash dedup (drop near-duplicates via Hamming ratio)
    → quality filter (min words, content signal score)
    → JSONL export (HF-compatible schema)
    → manifest (provenance, stats, domain tags)

Output files:
  exports/
    train.jsonl          ← 95% split, main training set
    validation.jsonl     ← 5% split, eval set
    manifest.json        ← full provenance + dedup stats
    duplicates.jsonl     ← dropped records (audit trail)
"""

import json
import os
import re
import hashlib
import random
from pathlib import Path
from typing import Iterator

# ── Config ────────────────────────────────────────────────────────────────────

SHARD_DIR    = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered"
OUTPUT_DIR   = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/exports"
DOMAIN       = "medical"
SOURCE_TAG   = "MedlinePlus-2025-01"
LICENSE      = "public-domain"

# SimHash dedup threshold — shards with Hamming ratio BELOW this are near-duplicates
DEDUP_THRESHOLD  = 0.12   # tight: only drop near-identical shards
MIN_WORDS        = 60     # drop fragments shorter than this
TRAIN_SPLIT      = 0.95   # 95% train, 5% validation
RANDOM_SEED      = 42

# HF dataset schema version
SCHEMA_VERSION   = "whiteglove-v1"

# ── SimHash-64 (pure Python, no dependencies) ─────────────────────────────────
# Lightweight version for dedup — not the full 128-bit TS implementation.
# Sufficient for near-duplicate detection across the export pipeline.

def fnv1a_32(data: bytes) -> int:
    h = 0x811c9dc5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def simhash_64(text: str) -> int:
    """64-bit SimHash via FNV-1a word hashing."""
    words = re.findall(r'\w+', text.lower())
    if not words:
        return 0

    buckets = [0] * 64
    for word in words:
        h = fnv1a_32(word.encode())
        # Extend to 64 bits with a second hash (domain-separated)
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
    """Hamming distance as ratio of total bits."""
    xor = a ^ b
    distance = bin(xor).count('1')
    return distance / bits

# ── Quality scorer ────────────────────────────────────────────────────────────

# Signals that indicate low-quality nav/boilerplate fragments
NOISE_PATTERNS = re.compile(
    r'(skip to|click here|sign up|subscribe|newsletter|cookie|privacy policy|'
    r'terms of use|all rights reserved|share this|back to top|breadcrumb|'
    r'search results|page \d+ of \d+)',
    re.IGNORECASE
)

def quality_score(text: str) -> float:
    """
    0.0 = garbage, 1.0 = clean content.
    Heuristic: penalize short text, high noise pattern density,
    low unique word ratio (repetition), high punctuation ratio.
    """
    words = text.split()
    if len(words) < MIN_WORDS:
        return 0.0

    # Unique word ratio — repetitive content scores low
    unique_ratio = len(set(w.lower() for w in words)) / len(words)

    # Noise pattern hits per 100 words
    noise_hits = len(NOISE_PATTERNS.findall(text))
    noise_penalty = min(1.0, noise_hits / max(1, len(words) / 100))

    # Punctuation ratio — nav fragments are often low punctuation
    punct_count = sum(1 for c in text if c in '.!?,;:')
    punct_ratio = punct_count / max(1, len(words))
    punct_score = min(1.0, punct_ratio * 10)  # normalize: ~0.1 punct/word is good

    score = (unique_ratio * 0.5) + (punct_score * 0.3) - (noise_penalty * 0.2)
    return max(0.0, min(1.0, score))

# ── HF-compatible record builder ──────────────────────────────────────────────

def build_record(shard: dict, sig: int, score: float) -> dict:
    """
    Hugging Face-compatible JSONL record.

    Compatible with:
    - datasets.load_dataset('json', ...)
    - LLaMA Factory (text field)
    - Axolotl (text field)
    - TRL SFTTrainer (text field)

    The 'text' field is the primary training signal.
    All metadata preserved for filtering/weighting downstream.
    """
    return {
        # ── Primary training field ──
        "text": shard["content"],

        # ── Instruction format (optional fine-tuning use) ──
        # If you want supervised fine-tuning instead of pretraining,
        # wrap content as an assistant response to a retrieval prompt.
        "instruction": f"Provide accurate medical information about: {shard['title']}",
        "output": shard["content"],

        # ── Provenance ──
        "id":             shard["id"],
        "source":         shard.get("source", "unknown"),
        "source_tag":     SOURCE_TAG,
        "domain":         DOMAIN,
        "license":        LICENSE,
        "title":          shard.get("title", ""),
        "path":           shard.get("path", ""),
        "source_shard_id":shard.get("source_shard_id", ""),
        "chunk_index":    shard.get("chunk_index", 0),
        "total_chunks":   shard.get("total_chunks", 1),

        # ── Quality signals (useful for weighted training) ──
        "word_count":     len(shard["content"].split()),
        "quality_score":  round(score, 4),
        "simhash":        sig,

        # ── Schema ──
        "schema_version": SCHEMA_VERSION,
    }

# ── Dedup engine ──────────────────────────────────────────────────────────────

class DedupIndex:
    def __init__(self, threshold: float):
        self.threshold = threshold
        self.sigs: list[int] = []
        self.dropped = 0
        self.kept = 0

    def is_duplicate(self, sig: int) -> bool:
        """Check if sig is too close to any seen signature."""
        for seen in self.sigs:
            if hamming_ratio(sig, seen) < self.threshold:
                return True
        return False

    def add(self, sig: int):
        self.sigs.append(sig)

# ── Shard loader ──────────────────────────────────────────────────────────────

def load_shards(shard_dir: str) -> Iterator[dict]:
    paths = sorted(Path(shard_dir).glob("med_chunk_*.json"))
    for p in paths:
        try:
            yield json.load(open(p))
        except Exception:
            continue

# ── Main export ───────────────────────────────────────────────────────────────

def export():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    train_path   = os.path.join(OUTPUT_DIR, "train.jsonl")
    val_path     = os.path.join(OUTPUT_DIR, "validation.jsonl")
    dupes_path   = os.path.join(OUTPUT_DIR, "duplicates.jsonl")
    manifest_path= os.path.join(OUTPUT_DIR, "manifest.json")

    dedup    = DedupIndex(DEDUP_THRESHOLD)
    rng      = random.Random(RANDOM_SEED)

    stats = {
        "total_shards":    0,
        "quality_dropped": 0,
        "dedup_dropped":   0,
        "train_records":   0,
        "val_records":     0,
        "total_words":     0,
        "avg_quality":     0.0,
        "domain":          DOMAIN,
        "source_tag":      SOURCE_TAG,
        "license":         LICENSE,
        "dedup_threshold": DEDUP_THRESHOLD,
        "min_words":       MIN_WORDS,
        "schema_version":  SCHEMA_VERSION,
    }

    quality_sum = 0.0

    with open(train_path, "w") as f_train, \
         open(val_path,  "w") as f_val,   \
         open(dupes_path,"w") as f_dupes:

        for shard in load_shards(SHARD_DIR):
            stats["total_shards"] += 1

            content = shard.get("content", "")
            words   = content.split()

            # ── Quality gate ──
            if len(words) < MIN_WORDS:
                stats["quality_dropped"] += 1
                continue

            score = quality_score(content)
            if score < 0.15:
                stats["quality_dropped"] += 1
                f_dupes.write(json.dumps({
                    "id": shard["id"],
                    "reason": "quality",
                    "score": round(score, 4),
                    "word_count": len(words)
                }) + "\n")
                continue

            # ── Dedup gate ──
            sig = simhash_64(content)
            if dedup.is_duplicate(sig):
                stats["dedup_dropped"] += 1
                f_dupes.write(json.dumps({
                    "id": shard["id"],
                    "reason": "duplicate",
                    "simhash": sig
                }) + "\n")
                continue

            dedup.add(sig)

            # ── Build record ──
            record = build_record(shard, sig, score)
            quality_sum += score
            stats["total_words"] += len(words)

            # ── Train/val split ──
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

    # ── Manifest ──
    total_kept = stats["train_records"] + stats["val_records"]
    stats["avg_quality"] = round(quality_sum / max(1, total_kept), 4)
    stats["avg_words_per_record"] = round(stats["total_words"] / max(1, total_kept))
    stats["estimated_tokens"] = stats["total_words"] * 1.3  # rough token estimate
    stats["estimated_tokens_billions"] = round(stats["estimated_tokens"] / 1e9, 4)

    with open(manifest_path, "w") as f:
        json.dump(stats, f, indent=2)

    # ── Summary ──
    print(f"\n{'='*56}")
    print(f"  WhiteGlove Training Export — Complete")
    print(f"{'='*56}")
    print(f"  Scanned:         {stats['total_shards']:,} shards")
    print(f"  Quality dropped: {stats['quality_dropped']:,}")
    print(f"  Dedup dropped:   {stats['dedup_dropped']:,}")
    print(f"  Train records:   {stats['train_records']:,}")
    print(f"  Val records:     {stats['val_records']:,}")
    print(f"  Total words:     {stats['total_words']:,}")
    print(f"  Est. tokens:     {stats['estimated_tokens_billions']:.4f}B")
    print(f"  Avg quality:     {stats['avg_quality']:.4f}")
    print(f"  Output:          {OUTPUT_DIR}")
    print(f"{'='*56}\n")
    print(f"  Load in Python:")
    print(f"    from datasets import load_dataset")
    print(f"    ds = load_dataset('json', data_files={{")
    print(f"      'train': '{train_path}',")
    print(f"      'validation': '{val_path}'")
    print(f"    }})")
    print()

if __name__ == "__main__":
    export()
