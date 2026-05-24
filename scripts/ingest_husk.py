#!/usr/bin/env python3
"""
ingest_husk.py — Self-ingest any codebase as a husk-{name} collection on Pi Qdrant.

Every product in the TGIL ecosystem knows itself geometrically.
Run this on any repo to create a self-referential vector collection that
pattern_scan.ts can query for security analysis, self-awareness, and debugging.

Architecture (same as ingest_medical.py):
  source files in repo
      ↓ chunk by function/class/block boundary
  JSON shards
      ↓ manifest diff (skip unchanged files — content hash)
  pending shards only
      ↓ Ollama /api/embed batch (64 texts / call)
  vectors
      ↓ bounded async Qdrant upsert (≤2 in flight)
  husk-{name} collection on Pi Qdrant
      ↓ manifest flush per batch

Restart after any interruption: manifest diff skips already-ingested files.
Never re-embeds source files that haven't changed.

Usage:
    python3 scripts/ingest_husk.py --repo /path/to/repo --name myapp
    python3 scripts/ingest_husk.py --repo /Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk --name whiteglove
    python3 scripts/ingest_husk.py --repo /Users/joewales/arbiterOS-legal-confidant- --name arbiter
    python3 scripts/ingest_husk.py --repo /path/to/repo --name myapp --dry-run
    python3 scripts/ingest_husk.py --repo /path/to/repo --name myapp --batch 32 --limit 100
"""

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

# Add LawLibra scripts to path for manifest module
sys.path.insert(0, str(Path("/Users/joewales/LawLibra/scripts")))
try:
    import ingest_manifest as manifest_mod
    HAS_MANIFEST = True
except ImportError:
    HAS_MANIFEST = False
    print("[husk-ingest] WARNING: ingest_manifest not found — manifest tracking disabled")

QDRANT_URL  = os.environ.get("QDRANT_PI_URL", "http://100.113.215.46:6333")
OLLAMA_URL  = os.environ.get("OLLAMA_URL",    "http://100.113.215.46:11434")
MODEL       = "nomic-embed-text"
VECTOR_SIZE = 768
MAX_CHARS   = 2048
MAX_UPSERTS_IN_FLIGHT = 2

# Source file extensions to ingest
SOURCE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx",       # TypeScript / JavaScript
    ".py",                               # Python
    ".go",                               # Go
    ".rs",                               # Rust
    ".lua",                              # Lua / Roblox
    ".sol",                              # Solidity
    ".java", ".kt",                      # JVM
    ".cs",                               # C#
    ".cpp", ".cc", ".c", ".h", ".hpp",  # C/C++
    ".rb",                               # Ruby
    ".swift",                            # Swift
    ".sh", ".bash",                      # Shell
}

# Directories to skip
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".next", "dist", "build",
    "coverage", ".turbo", ".cache", "vendor", "venv", ".venv",
    "target",  # Rust
    "shards",  # Don't ingest shard data
}

CHUNK_SIZE = 120  # lines per chunk


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def chunk_file(file_path: Path, repo_root: Path) -> list[dict]:
    """
    Chunk a source file into overlapping blocks of ~120 lines.
    Returns list of shard dicts ready for embedding.
    """
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    if not text.strip():
        return []

    lines = text.splitlines()
    rel_path = str(file_path.relative_to(repo_root))
    ext = file_path.suffix.lstrip(".")

    shards = []
    step = CHUNK_SIZE // 2  # 50% overlap

    for i in range(0, max(1, len(lines)), step):
        chunk_lines = lines[i: i + CHUNK_SIZE]
        chunk_text = "\n".join(chunk_lines)
        if not chunk_text.strip():
            continue

        chunk_idx = i // step
        shard_id = f"{rel_path.replace('/', '_').replace('.', '_')}__chunk_{chunk_idx:04d}"

        shards.append({
            "id":          shard_id,
            "content":     chunk_text,
            "title":       f"{rel_path} (lines {i+1}–{i+len(chunk_lines)})",
            "source":      rel_path,
            "file_path":   rel_path,
            "language":    ext,
            "line_start":  i + 1,
            "line_end":    i + len(chunk_lines),
            "chunk_index": chunk_idx,
        })

        # If last chunk covers all remaining lines, stop
        if i + CHUNK_SIZE >= len(lines):
            break

    return shards


def collect_shards(repo_root: Path, limit: int | None = None) -> list[dict]:
    """Walk repo, chunk all source files, return shard list."""
    shards = []
    repo_root = repo_root.resolve()

    for root, dirs, files in os.walk(repo_root):
        # Prune skip dirs in-place
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]

        for fname in sorted(files):
            fpath = Path(root) / fname
            if fpath.suffix not in SOURCE_EXTENSIONS:
                continue

            file_shards = chunk_file(fpath, repo_root)
            shards.extend(file_shards)

            if limit and len(shards) >= limit:
                return shards[:limit]

    return shards


# ── Embed ──────────────────────────────────────────────────────────────────────

async def embed_batch(texts: list[str], session: aiohttp.ClientSession) -> list[list[float]]:
    payload = {"model": MODEL, "input": [t[:MAX_CHARS] for t in texts]}
    async with session.post(f"{OLLAMA_URL}/api/embed", json=payload) as resp:
        if resp.status != 200:
            body = await resp.text()
            raise RuntimeError(f"Ollama embed failed {resp.status}: {body[:200]}")
        data = await resp.json()
        embeddings = data.get("embeddings", [])
        if len(embeddings) != len(texts):
            raise RuntimeError(f"Ollama count mismatch: got {len(embeddings)}, expected {len(texts)}")
        return embeddings


# ── Qdrant helpers ─────────────────────────────────────────────────────────────

def ensure_collection(qdrant: QdrantClient, collection: str) -> None:
    cols = [c.name for c in qdrant.get_collections().collections]
    if collection not in cols:
        qdrant.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
        print(f"[husk-ingest] Created '{collection}'")
    else:
        count = qdrant.get_collection(collection).points_count
        print(f"[husk-ingest] '{collection}' exists ({count} points)")


def build_points(shards: list[dict], vectors: list[list[float]], id_start: int, repo_name: str) -> list[PointStruct]:
    points = []
    for i, (shard, vec) in enumerate(zip(shards, vectors)):
        points.append(PointStruct(
            id=id_start + i,
            vector=vec,
            payload={
                "shard_id":    shard["id"],
                "title":       shard["title"],
                "source":      shard["source"],
                "file_path":   shard["file_path"],
                "language":    shard["language"],
                "line_start":  shard["line_start"],
                "line_end":    shard["line_end"],
                "chunk_index": shard["chunk_index"],
                "full_text":   shard["content"],
                "excerpt":     shard["content"][:500],
                "data_role":   "semantic",
                "domain":      "repo-husk",
                "repo_name":   repo_name,
            },
        ))
    return points


async def bounded_upsert(qdrant: QdrantClient, points: list[PointStruct], collection: str, sem: asyncio.Semaphore) -> None:
    async with sem:
        await asyncio.to_thread(qdrant.upsert, collection_name=collection, points=points, wait=True)


# ── Main pipeline ─────────────────────────────────────────────────────────────

async def run(
    pending: list[dict],
    batch_size: int,
    id_start: int,
    collection: str,
    repo_name: str,
    manifest: dict,
) -> tuple[int, int]:
    qdrant   = QdrantClient(url=QDRANT_URL, timeout=120)
    upserted = 0
    errors   = 0
    total    = len(pending)
    t0       = time.time()
    sem      = asyncio.Semaphore(MAX_UPSERTS_IN_FLIGHT)
    upsert_tasks: list[asyncio.Task] = []

    timeout = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=600)
    conn    = aiohttp.TCPConnector(limit=4)

    async with aiohttp.ClientSession(timeout=timeout, connector=conn) as session:
        try:
            await embed_batch(["warmup"], session)
            print(f"[husk-ingest] Ollama warm")
        except Exception as e:
            print(f"[husk-ingest] WARNING: warmup failed: {e}")

        for i in range(0, total, batch_size):
            batch = pending[i: i + batch_size]
            texts = [f"{s['title']}\n\n{s['content']}" for s in batch]

            upsert_tasks = [t for t in upsert_tasks if not t.done()]

            try:
                vecs = await embed_batch(texts, session)
            except Exception as e:
                print(f"  [embed error] batch {i//batch_size}: {e}", flush=True)
                errors += len(batch)
                continue

            # Record to manifest
            if HAS_MANIFEST:
                for j, shard in enumerate(batch):
                    manifest_mod.record(manifest, shard, id_start + i + j, MODEL, collection)
                manifest_mod.save(collection, manifest)

            points = build_points(batch, vecs, id_start + i, repo_name)
            task = asyncio.create_task(bounded_upsert(qdrant, points, collection, sem))
            upsert_tasks.append(task)
            upserted += len(points)

            elapsed = time.time() - t0
            rate    = upserted / elapsed if elapsed > 0 else 0
            eta     = (total - upserted) / rate if rate > 0 else 0
            print(f"  {upserted}/{total} queued | {errors} errors | {rate:.1f}/s | ETA {eta:.0f}s", flush=True)

        if upsert_tasks:
            results = await asyncio.gather(*upsert_tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    print(f"  [final upsert error]: {r}", flush=True)
                    errors += batch_size

    return upserted, errors


def main():
    parser = argparse.ArgumentParser(description="Ingest any codebase as a husk-{name} collection")
    parser.add_argument("--repo",    required=True, help="Path to the repo to ingest")
    parser.add_argument("--name",    required=True, help="Short name for the husk (e.g. whiteglove, arbiter)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch",   type=int, default=64)
    parser.add_argument("--limit",   type=int, default=None, help="Cap shards for testing")
    args = parser.parse_args()

    repo_root  = Path(args.repo).resolve()
    collection = f"husk-{args.name}"

    if not repo_root.exists():
        print(f"[husk-ingest] ERROR: repo path not found: {repo_root}")
        sys.exit(1)

    print(f"[husk-ingest] Repo:       {repo_root}")
    print(f"[husk-ingest] Collection: {collection}")
    print(f"[husk-ingest] Qdrant:     {QDRANT_URL}")
    print(f"[husk-ingest] Ollama:     {OLLAMA_URL}")

    print(f"[husk-ingest] Scanning source files...")
    shards = collect_shards(repo_root, limit=args.limit)
    print(f"[husk-ingest] Found {len(shards):,} shards from source files")

    if args.dry_run:
        langs = {}
        for s in shards:
            langs[s["language"]] = langs.get(s["language"], 0) + 1
        print(f"[dry-run] Would ingest {len(shards):,} shards")
        for lang, count in sorted(langs.items(), key=lambda x: -x[1]):
            print(f"  {lang:12s} {count:,}")
        return

    # Load manifest for diff
    manifest = manifest_mod.load(collection) if HAS_MANIFEST else {}

    # Diff against manifest — skip unchanged shards
    if HAS_MANIFEST and manifest:
        to_add, to_update, to_skip = manifest_mod.diff(manifest, shards, MODEL)
        pending = to_add + to_update
        print(f"[husk-ingest] manifest: {len(to_skip)} skip | {len(to_add)} add | {len(to_update)} update")
    else:
        pending = shards
        to_skip = []
        print(f"[husk-ingest] No manifest — ingesting all {len(shards):,} shards")

    if not pending:
        print("[husk-ingest] Nothing to do.")
        return

    qdrant = QdrantClient(url=QDRANT_URL, timeout=120)
    ensure_collection(qdrant, collection)

    id_start = len(manifest) if HAS_MANIFEST else 0

    t0 = time.time()
    upserted, errors = asyncio.run(run(pending, args.batch, id_start, collection, args.name, manifest))
    elapsed = time.time() - t0
    rate = upserted / elapsed if elapsed > 0 else 0

    print(f"\n[husk-ingest] Done. {upserted:,} queued, {errors} errors in {elapsed:.1f}s ({rate:.1f}/s)")
    if HAS_MANIFEST:
        print(f"[husk-ingest] manifest: {manifest_mod.stats(collection)}")
    print(f"\nNext: ts-node agent/index.ts --role security 'find auth vulnerabilities'")


if __name__ == "__main__":
    main()
