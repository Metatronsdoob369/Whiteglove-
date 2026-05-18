"""
legal_qdrant_publish.py — Stable Publisher Plane for Legal Temporal Points
=========================================================================

Reads precomputed point artifacts (JSONL) and publishes them to Qdrant in
resumable batches. Designed for running on a stable node (Mac/Pi), decoupled
from ephemeral GPU compute jobs.

Input JSONL format: one Qdrant point object per line
  {"id": <int|str>, "vector": [...], "payload": {...}}

Usage:
  python3 brain/spectral/legal_qdrant_publish.py \
      --points-jsonl ~/whiteglove/vault/alabama_points.jsonl \
      --qdrant http://localhost:6340 \
      --collection legal-heatmap \
      --batch 100 \
      --checkpoint ~/whiteglove/vault/alabama_publish_checkpoint.json
"""

import argparse
import json
import time
from pathlib import Path
import urllib.request


def qdrant_create_collection(qdrant_url: str, collection: str, dim: int = 3072):
    try:
        check = urllib.request.Request(f'{qdrant_url}/collections/{collection}', method='GET')
        with urllib.request.urlopen(check, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        pass

    payload = json.dumps({'vectors': {'size': dim, 'distance': 'Cosine'}}).encode()
    req = urllib.request.Request(
        f'{qdrant_url}/collections/{collection}',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def qdrant_upsert_batch(qdrant_url: str, collection: str, points: list):
    payload = json.dumps({'points': points}).encode()
    req = urllib.request.Request(
        f'{qdrant_url}/collections/{collection}/points',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def load_checkpoint(path: Path):
    if not path.exists():
        return {'line_offset': 0, 'published_points': 0, 'updated_at_epoch': 0}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {'line_offset': 0, 'published_points': 0, 'updated_at_epoch': 0}


def save_checkpoint(path: Path, line_offset: int, published_points: int):
    data = {
        'line_offset': line_offset,
        'published_points': published_points,
        'updated_at_epoch': time.time(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def iter_points(points_jsonl: Path, start_line: int):
    with points_jsonl.open('r', encoding='utf-8') as fp:
        for line_no, line in enumerate(fp, start=1):
            if line_no <= start_line:
                continue
            raw = line.strip()
            if not raw:
                continue
            try:
                point = json.loads(raw)
            except Exception:
                continue
            yield line_no, point


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--points-jsonl', required=True, help='Path to exported point JSONL artifact')
    parser.add_argument('--qdrant', default='http://localhost:6340')
    parser.add_argument('--collection', default='legal-heatmap')
    parser.add_argument('--batch', type=int, default=100)
    parser.add_argument('--checkpoint', required=True, help='Path to publisher checkpoint JSON')
    parser.add_argument('--start-line', type=int, default=None,
                        help='Override resume line offset (1-based JSONL line number)')
    parser.add_argument('--end-line', type=int, default=None,
                        help='Optional stop line (inclusive) for bounded publish windows')
    args = parser.parse_args()

    points_jsonl = Path(args.points_jsonl)
    checkpoint_path = Path(args.checkpoint)

    if not points_jsonl.exists():
        raise FileNotFoundError(f'points JSONL not found: {points_jsonl}')

    ckpt = load_checkpoint(checkpoint_path)
    resume_line = args.start_line if args.start_line is not None else int(ckpt.get('line_offset', 0))
    published_total = int(ckpt.get('published_points', 0))

    print(f'Points file:   {points_jsonl}')
    print(f'Checkpoint:    {checkpoint_path}')
    print(f'Resume line:   {resume_line}')
    print(f'Published so far: {published_total:,}')

    print(f'Ensuring Qdrant collection: {args.collection}')
    qdrant_create_collection(args.qdrant, args.collection, dim=3072)

    batch = []
    last_line = resume_line
    t0 = time.time()

    for line_no, point in iter_points(points_jsonl, resume_line):
        if args.end_line is not None and line_no > args.end_line:
            print(f'[end] reached line {line_no}, stopping.')
            break

        if 'id' not in point or 'vector' not in point:
            continue

        batch.append(point)
        last_line = line_no

        if len(batch) >= args.batch:
            qdrant_upsert_batch(args.qdrant, args.collection, batch)
            published_total += len(batch)
            save_checkpoint(checkpoint_path, last_line, published_total)
            elapsed = time.time() - t0
            rate = published_total / max(elapsed, 1)
            print(f'  → Published {len(batch):,} points  (total: {published_total:,}, line: {last_line:,}, rate: {rate:.2f}/s)')
            batch = []

    if batch:
        qdrant_upsert_batch(args.qdrant, args.collection, batch)
        published_total += len(batch)
        save_checkpoint(checkpoint_path, last_line, published_total)
        print(f'  → Final publish {len(batch):,} points  (total: {published_total:,}, line: {last_line:,})')

    elapsed = time.time() - t0
    print('\n' + '=' * 60)
    print('Publisher Complete')
    print('=' * 60)
    print(f'Published total: {published_total:,}')
    print(f'Last line:       {last_line:,}')
    print(f'Elapsed:         {elapsed:.1f}s')
    print(f'Collection:      {args.qdrant}/{args.collection}')
    print('=' * 60)


if __name__ == '__main__':
    main()
