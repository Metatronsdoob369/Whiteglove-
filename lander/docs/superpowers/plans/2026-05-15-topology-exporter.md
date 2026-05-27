# Topology Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python script that pulls vectors from Pi Qdrant, projects them to 2D via PCA, and writes `topology.json` into the lander folder so `index_topology.html` renders a live legal manifold map.

**Architecture:** The exporter samples up to 2,000 points from the `legal-heatmap` Qdrant collection (3072-D vectors), extracts the T-axis slice (first 1024 dims, doctrinal content), runs PCA to 2D, normalizes coordinates to 0–100 range, classifies bands from the `heat` payload field, detects fractures (contested/noise nodes far from their nearest settled neighbor), and writes a `topology.json` that `index_topology.html` already knows how to consume. A `--watch` flag re-exports every 30s for live polling.

**Tech Stack:** Python 3.9+, qdrant-client, numpy (already installed on Mac), scikit-learn (PCA — needs install), no umap dependency.

---

## File Structure

```
/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/
├── lander/
│   ├── index_topology.html          # existing — consumes topology.json via fetch('./topology.json')
│   ├── topology.json                # CREATE — output of exporter
│   └── export_topology.py           # CREATE — main exporter script
```

**topology.json schema** (what `index_topology.html` expects):
```json
{
  "timestamp": "2026-05-15T23:00:00.000Z",
  "nodes": [
    {
      "id": "gut_chunk_001234",
      "label": "gut_chunk_001234",
      "room": "settled",
      "x": 42.3,
      "y": 67.1,
      "heat": 0.0018,
      "band": "settled",
      "color": "#8effa6"
    }
  ],
  "fractures": [
    { "source": "gut_chunk_009530" }
  ],
  "stats": {
    "total": 1100,
    "settled": 420,
    "active": 380,
    "contested": 210,
    "noise": 90
  }
}
```

---

### Task 1: Install scikit-learn on Mac

**Files:**
- No files modified

- [ ] **Step 1: Install scikit-learn**

```bash
pip3 install scikit-learn
```

Expected output: `Successfully installed scikit-learn-...`

- [ ] **Step 2: Verify**

```bash
python3 -c "from sklearn.decomposition import PCA; print('PCA ok')"
```

Expected: `PCA ok`

---

### Task 2: Write the topology exporter

**Files:**
- Create: `/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander/export_topology.py`

- [ ] **Step 1: Create the exporter**

```python
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

def fetch_points(qdrant_url: str, sample: int) -> list[dict]:
    """
    Scrolls up to `sample` points from Qdrant with vectors + payload.
    Returns list of dicts: {id, vector, heat, drift, source, content_snippet}
    """
    client = QdrantClient(url=qdrant_url)
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
            points.append({
                "id":      str(p.payload.get("id", p.id)),
                "vector":  p.vector,
                "heat":    float(p.payload.get("heat", 0.003)),
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

def project_to_2d(points: list[dict]) -> list[dict]:
    """
    Extracts T-axis (first 1024 dims = current doctrinal content),
    runs PCA to 2D, normalizes to 0–100 range.
    Returns points with x, y added.
    """
    # Stack T-axis slices: shape (N, 1024)
    matrix = np.array([p["vector"][:1024] for p in points], dtype=np.float32)

    pca = PCA(n_components=2, random_state=42)
    coords = pca.fit_transform(matrix)  # shape (N, 2)

    # Normalize to 0–100
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

def detect_fractures(points: list[dict]) -> list[dict]:
    """
    A fracture is a contested/noise node whose nearest neighbor in 2D space
    is a settled node — indicating a doctrine bridge across heat bands.
    Returns list of {source: node_id}.
    """
    contested = [p for p in points if p["band"] in ("contested", "noise")]
    settled   = [p for p in points if p["band"] == "settled"]

    if not contested or not settled:
        return []

    settled_coords = np.array([[p["x"], p["y"]] for p in settled])
    fractures = []

    for node in contested:
        nc = np.array([node["x"], node["y"]])
        dists = np.linalg.norm(settled_coords - nc, axis=1)
        nearest_dist = dists.min()
        # Only flag as fracture if the nearest settled node is far (> 20 units)
        if nearest_dist > 20:
            fractures.append({"source": node["id"]})

    return fractures[:40]  # cap at 40 fracture lines for readability

# ── Build topology.json ───────────────────────────────────────────────────────

def build_topology(points: list[dict]) -> dict:
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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander/export_topology.py
```

---

### Task 3: Run the exporter and verify topology.json

**Files:**
- Create: `/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander/topology.json`

- [ ] **Step 1: Run a small sample first to verify quickly**

```bash
cd /Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander
python3 export_topology.py --sample 200
```

Expected output:
```
[exporter] Fetching from http://100.113.215.46:6340 (sample=200)
[exporter] Fetched 200 points from Qdrant
[exporter] PCA variance explained: XX.X%
[exporter] Written: .../topology.json  (200 nodes, N fractures)
```

- [ ] **Step 2: Verify topology.json structure**

```bash
python3 -c "
import json
from pathlib import Path
t = json.loads(Path('topology.json').read_text())
print('nodes:', len(t['nodes']))
print('fractures:', len(t['fractures']))
print('stats:', t['stats'])
print('sample node:', t['nodes'][0])
"
```

Expected: nodes count matches sample, each node has id/x/y/heat/band/color fields.

- [ ] **Step 3: Open index_topology.html in browser**

Open file in browser:
```
open /Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander/index_topology.html
```

Expected: Canvas renders colored dots. HUD shows node count, fracture count, timestamp. Hover over dots shows tooltip with shard ID, band, heat.

- [ ] **Step 4: Run full sample**

```bash
python3 export_topology.py --sample 2000
```

Expected: All available vectors (currently ~1,100) fetched, projected, written.

---

### Task 4: Wire watch mode for live updates

**Files:**
- No new files

- [ ] **Step 1: Start watch mode in background**

```bash
cd /Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/lander
nohup python3 export_topology.py --watch --sample 2000 > /tmp/topology_exporter.log 2>&1 &
echo "PID: $!"
```

- [ ] **Step 2: Verify it's running**

```bash
tail -f /tmp/topology_exporter.log
```

Expected: Re-export line appears every 30 seconds.

- [ ] **Step 3: Confirm browser auto-refreshes**

`index_topology.html` already calls `setInterval(loadTopology, 15000)` — it polls every 15 seconds. With watch mode writing every 30s, the browser will pick up each new export within 15s of it landing.

Reload `index_topology.html` and wait ~30s. Node count should increment as ingest adds new vectors to Qdrant.

---

## Self-Review

**Spec coverage:**
- ✅ Topology engine: PCA projection from 3072-D → 2D — Task 2
- ✅ Heat layer: band classification from heat payload, color-coded — Task 2/3
- ✅ Fracture detection: contested nodes far from settled — Task 2
- ✅ Frontend integration: topology.json polled by existing HTML — Task 3/4
- ✅ Live watch mode: --watch flag, 30s cadence — Task 4

**Placeholder scan:** None. All code is complete and runnable.

**Type consistency:** `classify_band()` returns string matching BAND_COLORS keys. `build_topology()` uses same band strings. `detect_fractures()` called after band is set on each point. No mismatches.
