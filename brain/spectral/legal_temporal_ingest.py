"""
legal_temporal_ingest.py — T || T-1 || T-start Temporal Legal Corpus Ingest
=============================================================================

Applies the OMC temporal concatenation architecture to the legal corpus.
Each shard is embedded as a 3072-D vector:

    vec[0..1023]    = T        — current shard (mxbai-embed-large, 1024-D)
    vec[1024..2047] = T-1      — previous shard embedding (drift axis)
    vec[2048..3071] = T-start  — first shard anchor (origin of manifold)

The temporal sequence is determined by:
    - Law StackExchange: chunk_index within source document (causal order)
    - Project Gutenberg: publication date → chunk_index (doctrinal history)

Sequence ordering: Gutenberg by publication year first (oldest doctrine →
newest), then Law SE ordered by source document. This puts Blackstone 1765
at T-start and 2025 Law SE questions at the far T end of the manifold.

The legal corpus then has genuine temporal geometry:
    - Z-axis (T-start) = distance from foundational doctrine
    - Y-axis (T-1)     = local drift — how much this shard moved from the last
    - X-axis (T)       = current doctrinal content

This is NOT metadata. Time is baked into the geometry of the embedding.

Stores into Qdrant collection: legal-heatmap (3072-D, Cosine)
Each point payload also carries the spectral heat score from legal_heatmap.json.

Usage (on Pi, inside kos-venv):
    python3 brain/spectral/legal_temporal_ingest.py \
        --shards  ~/whiteglove/brain/shards/legal \
        --heatmap ~/whiteglove/vault/legal_heatmap.json \
        --qdrant  http://localhost:6340 \
        --ollama  http://localhost:11434 \
        --batch   100
"""

import argparse
import json
import time
import re
import math
import os
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error

# ── Ollama embed ──────────────────────────────────────────────────────────────

def embed_chunk(text: str, ollama_url: str, model: str = 'mxbai-embed-large') -> list[float]:
    # mxbai-embed-large context: 512 tokens ≈ 1500 chars; truncate to avoid 500 errors
    payload = json.dumps({'model': model, 'prompt': text[:1500]}).encode()
    req = urllib.request.Request(
        f'{ollama_url}/api/embeddings',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())['embedding']


def embed_with_max_magnitude_pool(text: str, ollama_url: str,
                                   chunk_size: int = 1400, overlap: int = 200) -> list[float]:
    """
    Embed text via max-magnitude pooling across chunks.
    mxbai-embed-large: 512-token context ≈ 1500 chars.
    Shards <= 1400 chars: single embed call (fast path).
    Longer shards: chunk and pool via max-magnitude per dimension.
    Preserves spectral density — same as OMC lab-mapping-orchestrator.
    """
    # Fast path: fits in a single call
    if len(text) <= chunk_size:
        try:
            return embed_chunk(text, ollama_url)
        except Exception as e:
            print(f'      ⚠ embed failed: {e}')
            return [0.0] * 1024

    chunks = []
    for i in range(0, len(text), chunk_size - overlap):
        chunk = text[i:i + chunk_size]
        if chunk.strip():
            chunks.append(chunk)

    if not chunks:
        return [0.0] * 1024

    embeddings = []
    for chunk in chunks:
        try:
            embeddings.append(embed_chunk(chunk, ollama_url))
        except Exception as e:
            print(f'      ⚠ chunk embed failed: {e}')

    if not embeddings:
        return [0.0] * 1024

    dim = len(embeddings[0])
    pooled = [0.0] * dim
    for i in range(dim):
        max_mag = 0.0
        val = 0.0
        for emb in embeddings:
            if abs(emb[i]) > max_mag:
                max_mag = abs(emb[i])
                val = emb[i]
        pooled[i] = val

    return pooled


# ── Temporal Concatenation ────────────────────────────────────────────────────

def temporal_cat(t: list[float], t_minus1: list[float], t_start: list[float]) -> list[float]:
    """
    T || T-1 || T-start → 3072-D sovereign temporal vector.
    Dimensions:
        [0..1023]    T        current shard content
        [1024..2047] T-1      previous shard (drift)
        [2048..3071] T-start  anchor / origin
    """
    dim = 1024
    vec = [0.0] * (dim * 3)
    for i in range(dim):
        vec[i]          = t[i]          if i < len(t)          else 0.0
        vec[i + dim]    = t_minus1[i]   if i < len(t_minus1)   else 0.0
        vec[i + dim*2]  = t_start[i]    if i < len(t_start)    else 0.0
    return vec


def manhattan_heat(vec: list[float]) -> float:
    """Manhattan resonance from zero — normalized to ~0..1."""
    return sum(abs(v) for v in vec) / (len(vec) * 10)


def position_3d(vec: list[float]) -> list[float]:
    """
    3D projection from the three temporal axes.
    X = T[0]       — current content signal
    Y = T-1[0]     — drift signal
    Z = T-start[0] — origin distance
    """
    scale = 20.0
    return [
        vec[0]    * scale,   # X: T
        vec[1024] * scale,   # Y: T-1 (drift)
        vec[2048] * scale,   # Z: T-start (origin distance = doctrinal age)
    ]


# ── Temporal Sequence Ordering ────────────────────────────────────────────────

GUTENBERG_YEARS = {
    # Publication years for known Gutenberg works in corpus
    'blackstone':        1765,
    'magna carta':       1215,
    'visigothic':        1910,  # Forum Judicum translation
    'aethelbert':        1840,  # Our Legal Heritage translation
    'grotius':           1625,  # Rights of War and Peace
    'oppenheim':         1905,
    'nuremberg':         1947,
    'nuremberg military': 1947,
    'constitution':      1787,
    'essays on the constitution': 1787,
    'tribal custom':     1905,
    'medical jurisprudence': 1894,
    'atrocious judges':  1856,
    'marital power':     1866,
    'areopagitica':      1644,
    'public domain':     2011,
    'copyright law':     1909,
    'international law': 1905,
    'race distinctions': 1910,
    'selection of cases': 1874,
    'lectures on the constitution': 1794,
    'arguments before the committee': 1906,
}

def gutenberg_year(title: str) -> int:
    """Estimate publication year from title for temporal ordering."""
    title_lower = title.lower()
    for key, year in sorted(GUTENBERG_YEARS.items(), key=lambda x: -len(x[0])):
        if key in title_lower:
            return year
    return 1900  # default for unknown Gutenberg works


def sort_key(shard: dict) -> tuple:
    """
    Sort shards for temporal sequencing:
    1. Gutenberg by publication year (oldest first → T-start anchor)
    2. Law SE by source document + chunk_index (causal order within document)
    """
    source = shard.get('source', '')
    chunk_idx = shard.get('chunk_index', 0)

    if 'Gutenberg' in source:
        year = gutenberg_year(shard.get('title', ''))
        return (0, year, chunk_idx)  # Gutenberg first, oldest first
    else:
        # Law SE: group by source document path, then chunk order
        path = shard.get('path', '')
        return (1, path, chunk_idx)


# ── Qdrant ────────────────────────────────────────────────────────────────────

def qdrant_create_collection(qdrant_url: str, collection: str, dim: int = 3072):
    # Only create if collection does not already exist — never delete
    try:
        check = urllib.request.Request(
            f'{qdrant_url}/collections/{collection}',
            method='GET'
        )
        with urllib.request.urlopen(check, timeout=10) as resp:
            info = json.loads(resp.read())
            existing = info.get('result', {}).get('vectors_count') or info.get('result', {}).get('points_count')
            print(f'  Collection exists ({existing} points). Appending.')
            return info
    except Exception:
        pass  # doesn't exist yet, create it

    payload = json.dumps({
        'vectors': {'size': dim, 'distance': 'Cosine'}
    }).encode()
    req = urllib.request.Request(
        f'{qdrant_url}/collections/{collection}',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        print(f'  Collection created.')
        return json.loads(resp.read())


def qdrant_upsert_batch(qdrant_url: str, collection: str, points: list):
    payload = json.dumps({'points': points}).encode()
    req = urllib.request.Request(
        f'{qdrant_url}/collections/{collection}/points',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shards',  required=True, help='Path to shard .json files')
    parser.add_argument('--heatmap', required=True, help='Path to legal_heatmap.json')
    parser.add_argument('--qdrant',  default='http://localhost:6340')
    parser.add_argument('--ollama',  default='http://localhost:11434')
    parser.add_argument('--collection', default='legal-heatmap')
    parser.add_argument('--batch',   type=int, default=50, help='Qdrant upsert batch size')
    parser.add_argument('--resume',  type=int, default=0,  help='Resume from shard index N')
    parser.add_argument('--end',     type=int, default=None, help='Stop after shard index N (exclusive)')
    parser.add_argument('--emit-jsonl', default=None,
                        help='Optional path to write generated points as JSONL artifacts')
    parser.add_argument('--append-jsonl', action='store_true',
                        help='Append to existing --emit-jsonl file instead of truncating')
    parser.add_argument('--emit-manifest', default=None,
                        help='Optional path to write artifact run manifest JSON')
    parser.add_argument('--emit-only', action='store_true',
                        help='Generate artifacts only (skip all Qdrant writes)')
    args = parser.parse_args()

    # Load heat map scores for payload enrichment
    print('Loading heat map scores...')
    heatmap_data = json.loads(Path(args.heatmap).read_text())
    heat_by_id = {s['id']: s for s in heatmap_data['shards']}
    print(f'  {len(heat_by_id):,} heat scores loaded')

    # Load all shards
    print('Loading shards...')
    shard_dir = Path(args.shards)
    shards = []
    for path in sorted(shard_dir.glob('*.json')):
        try:
            shards.append(json.loads(path.read_text()))
        except Exception:
            continue
    print(f'  {len(shards):,} shards loaded')

    # Sort by temporal sequence
    print('Ordering shards temporally (Gutenberg oldest → Law SE causal)...')
    shards.sort(key=sort_key)

    # Show first and last for verification
    print(f'  T-start anchor: [{shards[0]["source"]}] {shards[0].get("title","")[:60]}')
    print(f'  T-end:          [{shards[-1]["source"]}] {shards[-1].get("title","")[:60]}')

    qdrant_enabled = not args.emit_only
    if qdrant_enabled:
        # Create Qdrant collection (no-op if already exists)
        print(f'\nEnsuring Qdrant collection: {args.collection} (3072-D Cosine)...')
        qdrant_create_collection(args.qdrant, args.collection)
        print('  Collection ready.')
    else:
        print('\n[emit-only] Qdrant writes disabled; generating portable point artifacts only.')

    emit_fp = None
    emitted_points = 0
    if args.emit_jsonl:
        emit_path = Path(args.emit_jsonl)
        emit_path.parent.mkdir(parents=True, exist_ok=True)
        mode = 'a' if args.append_jsonl else 'w'
        if mode == 'a':
            print(f'Artifact sink: append {emit_path}')
        else:
            print(f'Artifact sink: write {emit_path}')
        emit_fp = emit_path.open(mode, encoding='utf-8')

    # Temporal state
    t_start: Optional[list[float]] = None
    t_prev:  Optional[list[float]] = None

    batch_points = []
    total_ingested = 0
    t0 = time.time()

    print(f'\nIngesting {len(shards):,} shards with T||T-1||T-start embedding...')
    print(f'  Ollama: {args.ollama}  |  Model: mxbai-embed-large')
    if qdrant_enabled:
        print(f'  Qdrant: {args.qdrant}/{args.collection}')
    print(f'  Artifact JSONL: {args.emit_jsonl or "(disabled)"}\n')

    for i, shard in enumerate(shards):
        if i < args.resume:
            continue
        if args.end is not None and i >= args.end:
            print(f'\n[end] Reached shard {i}, stopping as requested.')
            break

        shard_id = shard.get('id', f'shard_{i}')
        text = shard.get('content', shard.get('text', ''))
        title = shard.get('title', '')
        source = shard.get('source', '')

        elapsed = time.time() - t0
        rate = (i - args.resume + 1) / max(elapsed, 1)
        eta = (len(shards) - i) / max(rate, 0.001)
        print(f'  [{i+1:>6}/{len(shards):,}]  {shard_id}  eta={eta:.0f}s', end='  ')

        try:
            # Embed current shard
            t_current = embed_with_max_magnitude_pool(text, args.ollama)

            # Bootstrap T-start on first shard
            if t_start is None:
                t_start = t_current
                print(f' T-start anchored')
            else:
                print(f'', end='')

            t_minus1 = t_prev if t_prev is not None else [0.0] * 1024

            # Temporal concatenation → 3072-D
            vec3072 = temporal_cat(t_current, t_minus1, t_start)
            heat    = manhattan_heat(vec3072)
            pos3d   = position_3d(vec3072)

            # Drift: cosine distance from previous shard
            drift = 0.0
            if t_prev is not None:
                dot = sum(a*b for a,b in zip(t_current, t_prev))
                la  = math.sqrt(sum(a*a for a in t_current))
                lb  = math.sqrt(sum(b*b for b in t_prev))
                drift = 1.0 - (dot / (la * lb + 1e-8))

            # Pull spectral band from heat map
            heat_info = heat_by_id.get(shard_id, {})
            spectral_band = heat_info.get('spectral_band', 'unknown')
            corpus_heat   = heat_info.get('heat_score', 0.0)
            cluster_id    = heat_info.get('cluster_id', -1)

            # Temporal classification
            # Low drift + low heat = stable, settled doctrine
            # High drift = doctrinal transition (shard diverges from predecessor)
            # High heat (manhattan) = novel / contested
            if drift < 0.1 and heat < 0.005:
                temporal_band = 'settled'
            elif drift > 0.4:
                temporal_band = 'transition'
            elif heat > 0.01:
                temporal_band = 'contested'
            else:
                temporal_band = 'active'

            # Stable integer ID for Qdrant
            qdrant_id = i + 1

            point = {
                'id': qdrant_id,
                'vector': vec3072,
                'payload': {
                    'shard_id':       shard_id,
                    'source':         source,
                    'title':          title[:120],
                    'path':           shard.get('path', ''),
                    'domain':         shard.get('domain', 'legal'),
                    'chunk_index':    shard.get('chunk_index', 0),
                    'total_chunks':   shard.get('total_chunks', 1),
                    'word_count':     shard.get('word_count', 0),
                    # Temporal geometry
                    'position_3d':    pos3d,
                    'temporal_index': i,
                    'drift':          round(drift, 4),
                    'manhattan_heat': round(heat, 6),
                    'temporal_band':  temporal_band,
                    'is_t_start':     (i == 0),
                    # From spectral heat map pass
                    'spectral_band':  spectral_band,
                    'corpus_heat':    round(corpus_heat, 6),
                    'cluster_id':     cluster_id,
                    # Temporal axis metadata
                    'temporal_dims': {
                        'T':       [0, 1023],
                        'T_minus1':[1024, 2047],
                        'T_start': [2048, 3071],
                    },
                    'ingest_protocol': 'T||T-1||T-start_3072D_v1',
                }
            }

            batch_points.append(point)
            if emit_fp is not None:
                emit_fp.write(json.dumps(point, ensure_ascii=False) + '\n')
                emitted_points += 1
                if emitted_points % 500 == 0:
                    emit_fp.flush()
                    os.fsync(emit_fp.fileno())
            t_prev = t_current
            total_ingested += 1
            print(f'heat={heat:.4f} drift={drift:.3f} [{temporal_band}]')

        except Exception as e:
            print(f'❌ {e}')
            continue

        # Flush batch to Qdrant
        if qdrant_enabled and len(batch_points) >= args.batch:
            try:
                qdrant_upsert_batch(args.qdrant, args.collection, batch_points)
                print(f'  → Flushed {len(batch_points)} points to Qdrant  '
                      f'(total: {total_ingested:,})')
                batch_points = []
            except Exception as e:
                print(f'  ⚠ Qdrant flush failed: {e}')

    # Final flush
    if qdrant_enabled and batch_points:
        try:
            qdrant_upsert_batch(args.qdrant, args.collection, batch_points)
            print(f'  → Final flush: {len(batch_points)} points')
        except Exception as e:
            print(f'  ⚠ Final flush failed: {e}')

    if emit_fp is not None:
        emit_fp.flush()
        os.fsync(emit_fp.fileno())
        emit_fp.close()

    elapsed = time.time() - t0
    print(f'\n{"="*60}')
    print(f'  T||T-1||T-start Legal Ingest — Complete')
    print(f'{"="*60}')
    print(f'  Shards ingested:  {total_ingested:,}')
    print(f'  Elapsed:          {elapsed:.0f}s  ({elapsed/60:.1f}min)')
    if qdrant_enabled:
        print(f'  Collection:       {args.qdrant}/{args.collection}')
    if args.emit_jsonl:
        print(f'  Artifact file:    {args.emit_jsonl}')
        print(f'  Points emitted:   {emitted_points:,}')
    print(f'  T-start anchor:   {shards[0].get("title","")[:50]}')
    print(f'  Dimensions:       3072-D  [T:1024 | T-1:1024 | T-start:1024]')
    print(f'{"="*60}\n')

    if args.emit_manifest:
        manifest = {
            'pipeline': 'T||T-1||T-start_3072D_v1',
            'created_at_epoch': time.time(),
            'shards_path': str(shard_dir),
            'heatmap_path': str(args.heatmap),
            'emit_jsonl': args.emit_jsonl,
            'emit_only': args.emit_only,
            'qdrant': args.qdrant if qdrant_enabled else None,
            'collection': args.collection if qdrant_enabled else None,
            'resume': args.resume,
            'end': args.end,
            'total_shards_loaded': len(shards),
            'total_points_emitted': emitted_points if args.emit_jsonl else 0,
            'total_ingested': total_ingested,
            'elapsed_seconds': elapsed,
        }
        manifest_path = Path(args.emit_manifest)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(f'  Manifest written: {manifest_path}')


if __name__ == '__main__':
    main()
