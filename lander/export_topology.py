#!/usr/bin/env python3
"""
export_topology.py — WhiteGlove Legal Manifold Topology Exporter
=================================================================
Pulls vectors from Pi Qdrant, projects to 2D via PCA on the T-axis (first
1024 dims = doctrinal content), classifies bands, detects fractures, and
writes topology.json for index_topology.html.

Usage:
    python3 export_topology.py                  # export once
    python3 export_topology.py --watch          # re-export every 30s
    python3 export_topology.py --sample 500     # sample size (default 2000)
    python3 export_topology.py --qdrant http://100.113.215.46:6340

Band thresholds (must match LawLibra api/config.py):
    settled:   heat < 0.002
    active:    0.002 <= heat < 0.005
    contested: 0.005 <= heat < 0.015
    noise:     heat >= 0.015
"""

import argparse
import json
import time
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient
from sklearn.decomposition import PCA

# ── Constants ─────────────────────────────────────────────────────────────────

BAND_COLORS = {
    "settled":   "#8effa6",
    "active":    "#c97a4a",
    "contested": "#ff4a4a",
    "noise":     "#5b5e64",
}

OUT_PATH = Path(__file__).parent / "topology.json"

# ── Band classification ───────────────────────────────────────────────────────

def classify_band(heat: float) -> str:
    if heat < 0.002:   return "settled"
    if heat < 0.005:   return "active"
    if heat < 0.015:   return "contested"
    return "noise"

# ── Qdrant fetch ──────────────────────────────────────────────────────────────

def fetch_points(qdrant_url: str, sample: int) -> list:
    client = QdrantClient(url=qdrant_url, timeout=30)
    points = []
    offset = None

    while len(points) < sample:
        batch, next_offset = client.scroll(
            collection_name="legal-heatmap",
            limit=min(256, sample - len(points)),
            offset=offset,
            with_vectors=True,
            with_payload=True,
        )
        if not batch:
            break
        for p in batch:
            vec = p.vector
            if vec is None:
                continue
            points.append({
                "id":      str(p.payload.get("id", p.id)),
                "vector":  vec,
                "heat":    float(p.payload.get("corpus_heat", p.payload.get("manhattan_heat", 0.003))),
                "drift":   float(p.payload.get("drift", 0.0)),
                "source":  str(p.payload.get("source", "unknown")),
                "excerpt": str(p.payload.get("content", ""))[:120],
            })
        offset = next_offset
        if offset is None:
            break

    print(f"[exporter] Fetched {len(points)} points from Qdrant", flush=True)
    return points

# ── PCA projection ────────────────────────────────────────────────────────────

def project_to_2d(points: list) -> list:
    # T-axis slice: first 1024 dims = current doctrinal content
    matrix = np.array([p["vector"][:1024] for p in points], dtype=np.float32)

    pca = PCA(n_components=2, random_state=42)
    coords = pca.fit_transform(matrix)

    x_min, x_max = coords[:, 0].min(), coords[:, 0].max()
    y_min, y_max = coords[:, 1].min(), coords[:, 1].max()
    x_range = x_max - x_min or 1.0
    y_range = y_max - y_min or 1.0

    for i, p in enumerate(points):
        p["x"] = round(float((coords[i, 0] - x_min) / x_range * 90 + 5), 2)
        p["y"] = round(float((coords[i, 1] - y_min) / y_range * 90 + 5), 2)

    print(f"[exporter] PCA variance explained: {pca.explained_variance_ratio_.sum():.1%}", flush=True)
    return points

# ── Fracture detection ────────────────────────────────────────────────────────

def detect_fractures(points: list) -> list:
    contested = [p for p in points if p["band"] in ("contested", "noise")]
    settled   = [p for p in points if p["band"] == "settled"]

    if not contested or not settled:
        return []

    settled_coords = np.array([[p["x"], p["y"]] for p in settled])
    fractures = []

    for node in contested:
        nc = np.array([node["x"], node["y"]])
        dists = np.linalg.norm(settled_coords - nc, axis=1)
        if dists.min() > 20:
            fractures.append({"source": node["id"]})

    return fractures[:40]

# ── Build topology.json ───────────────────────────────────────────────────────

def build_topology(points: list) -> dict:
    stats = {"total": len(points), "settled": 0, "active": 0, "contested": 0, "noise": 0}
    nodes = []

    for p in points:
        band = classify_band(p["heat"])
        p["band"] = band
        stats[band] += 1
        nodes.append({
            "id":    p["id"],
            "label": p["id"],
            "room":  band,
            "x":     p["x"],
            "y":     p["y"],
            "heat":  round(p["heat"], 6),
            "band":  band,
            "color": BAND_COLORS[band],
        })

    fractures = detect_fractures(points)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "nodes":     nodes,
        "fractures": fractures,
        "stats":     stats,
    }

# ── Export ────────────────────────────────────────────────────────────────────

def export_once(qdrant_url: str, sample: int) -> None:
    print(f"[exporter] Fetching from {qdrant_url} (sample={sample})", flush=True)
    points = fetch_points(qdrant_url, sample)
    if not points:
        print("[exporter] No points fetched — collection may be empty.", flush=True)
        return

    points = project_to_2d(points)
    topology = build_topology(points)

    OUT_PATH.write_text(json.dumps(topology, indent=2))
    print(f"[exporter] Written: {OUT_PATH}  ({len(points)} nodes, {len(topology['fractures'])} fractures)", flush=True)

# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export WhiteGlove topology.json")
    parser.add_argument("--qdrant", default="http://100.113.215.46:6340")
    parser.add_argument("--sample", type=int, default=2000)
    parser.add_argument("--watch",  action="store_true", help="Re-export every 30s")
    args = parser.parse_args()

    export_once(args.qdrant, args.sample)
    if args.watch:
        print("[exporter] Watch mode — re-exporting every 30s. Ctrl-C to stop.", flush=True)
        while True:
            time.sleep(30)
            export_once(args.qdrant, args.sample)

if __name__ == "__main__":
    main()
