"""
legal_heatmap.py — Eve_v2 Corpus-Level Spectral Heat Map
=========================================================

The correct application of the heat kernel is at the CORPUS level, not
per-shard. Each shard is a NODE in the corpus graph. Edges connect shards
with similar spectral fingerprints. The heat kernel then diffuses over
this graph — shards in dense, well-connected regions (settled doctrine)
get high heat scores. Isolated or topologically sharp nodes (contested
law, edge cases, boilerplate) get low scores.

This is what makes it instinct vs retrieval:
  - SimHash retrieval: "find shards with similar bit patterns"
  - Spectral heat map: "find where this query sits in the topology of law"

Pipeline:
  1. Each shard → text landmark vector (legal signal extraction)
  2. All shard vectors → pairwise similarity → k-NN corpus graph
  3. Normalized Laplacian of corpus graph
  4. Partial eigendecomposition (Lanczos, top-k smallest eigenvalues)
  5. Heat kernel: h(t,v) = sum_k exp(-lambda_k * t) * phi_k(v)^2
  6. Per-shard: heat_score, spectral_band, cluster_id

Output:
  legal_heatmap.json — full corpus topology with per-shard scores
  This gets loaded by the WhiteGlove server to route queries by topology
  rather than SimHash distance alone.

Usage (on Pi, inside kos-venv):
    python3 brain/spectral/legal_heatmap.py \
        --shards ~/whiteglove/brain/shards/legal \
        --out    ~/whiteglove/vault/legal_heatmap.json \
        --tau    0.05 \
        --k      64 \
        --knn    8 \
        --sample 5000   # 0 = all 27k
"""

import argparse
import json
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from scipy.sparse import csr_matrix, diags
from scipy.sparse.linalg import eigsh

# ── Legal Signal Feature Extractor ───────────────────────────────────────────
# Converts a legal shard to a fixed-length feature vector.
# This is the "landmark" in the corpus-level graph.

CITATION_SIGNALS = [
    (r'U\.?C\.?C\.?\s*§?\s*\d+[-–]\d+',          'ucc',           2.0),
    (r'\d+\s+U\.S\.C\.?\s*§?\s*\d+',              'usc',           1.8),
    (r'§\s*\d+[\.\-]\d+',                          'section',       1.5),
    (r'\d+\s+C\.?F\.?R\.?\s*§?\s*\d+',            'cfr',           1.5),
    (r'[A-Z][a-z]+\s+v\.?\s+[A-Z][a-z]+',         'case_cite',     1.3),
    (r'\d{2,3}\s+[A-Z][a-z]+\.?\s+\d+',           'reporter',      1.2),
    (r'Article\s+[IVX\d]+',                        'article',       1.0),
    (r'Restatement\s+\(?Second\)?',               'restatement',   1.0),
    (r'pursuant\s+to|in\s+accordance\s+with',     'pursuant',      0.8),
    (r'Pub\.\s*L\.?\s*\d+[-–]\d+',               'public_law',    1.4),
]

DOMAIN_SIGNALS = [
    # Contract
    (r'\bcontract\b|\boffer\b|\bacceptance\b|\bconsideration\b',   'contract',      1.0),
    (r'\bbreach\b|\bremedy\b|\bdamages\b|\bperformance\b',        'breach',        1.0),
    (r'\bwarranty\b|\bindemnif|\bfraud\b|\bmisrepresent',         'warranty',      0.9),
    # Property
    (r'\bproperty\b|\btitle\b|\bdeed\b|\blien\b|\bmortgage\b',   'property',      1.0),
    (r'\beasement\b|\btrespass\b|\bnuisance\b|\btenancy\b',      'real_prop',     0.9),
    # Criminal
    (r'\bcriminal\b|\bfelony\b|\bmisdemeanor\b|\bindictment\b',  'criminal',      1.0),
    (r'\bprobable\s+cause\b|\bsearch\b|\bseizure\b|\bwarrant\b', 'fourth_amend',  1.1),
    # Constitutional
    (r'\bconstitutional\b|\bamendment\b|\bdue\s+process\b',      'constitutional', 1.1),
    (r'\bequal\s+protection\b|\bfirst\s+amendment\b',           'first_amend',   1.1),
    # Procedure
    (r'\bjurisdiction\b|\bvenue\b|\bstanding\b|\bmootness\b',    'jurisdiction',  0.9),
    (r'\bappeal\b|\bremand\b|\bcertiorari\b|\baffirm\b',        'appellate',     0.9),
    (r'\bmotion\b|\bpleading\b|\bdiscovery\b|\bdeposition\b',   'procedure',     0.8),
    # Secured transactions / UCC
    (r'\bsecurity\s+interest\b|\bcollateral\b|\bperfect\b',     'secured_trans', 1.2),
    (r'\bnegotiable\s+instrument\b|\bpromissory\s+note\b',      'negotiable',    1.2),
    # International
    (r'\binternational\s+law\b|\btreaty\b|\bsovereign\b',       'intl_law',      0.9),
    (r'\bwar\s+crime\b|\btribunal\b|\bnuremberg\b',             'intl_criminal', 1.0),
    # Historical / treatise
    (r'\bblackstone\b|\bcommonlaw\b|\bcommon\s+law\b',          'common_law',    0.8),
    (r'\bmagna\s+carta\b|\bhabeas\s+corpus\b',                  'foundational',  0.8),
]

QUALITY_SIGNALS = [
    (r'\bholding\b|\bthe\s+court\s+held\b',                     'holding',       1.5),
    (r'\bstare\s+decisis\b|\bprecedent\b|\boverrul',            'precedent',     1.3),
    (r'\bplaintiff\b|\bdefendant\b|\bpetitioner\b',             'parties',       0.7),
    (r'\bratio\s+decidendi\b|\bobiter\b',                       'ratio',         1.4),
]

ALL_SIGNALS = CITATION_SIGNALS + DOMAIN_SIGNALS + QUALITY_SIGNALS
N_FEATURES = len(ALL_SIGNALS)


def shard_to_vector(text: str) -> np.ndarray:
    """
    Convert shard text to a normalized feature vector.
    Each dimension corresponds to one legal signal pattern.
    Value = normalized hit count weighted by signal importance.
    """
    vec = np.zeros(N_FEATURES)
    words = len(text.split())
    if words == 0:
        return vec

    for i, (pattern, _, weight) in enumerate(ALL_SIGNALS):
        hits = len(re.findall(pattern, text, re.IGNORECASE))
        vec[i] = (hits / max(words / 100, 1)) * weight

    norm = np.linalg.norm(vec)
    return vec / (norm + 1e-8)


# ── Corpus Graph Builder ──────────────────────────────────────────────────────

def build_corpus_graph(vectors: np.ndarray, knn: int) -> csr_matrix:
    """
    Build k-NN similarity graph over shard feature vectors.
    Uses cosine similarity (dot product of normalized vectors).
    """
    n = len(vectors)
    knn = min(knn, n - 1)

    print(f'  Building {n:,}-node corpus graph (k={knn})...')
    t0 = time.time()

    # Cosine similarity matrix in batches to avoid OOM on 27k x 27k
    batch = 512
    rows, cols, vals = [], [], []

    for start in range(0, n, batch):
        end = min(start + batch, n)
        sim_block = vectors[start:end] @ vectors.T  # (batch, n)

        for local_i, global_i in enumerate(range(start, end)):
            sims = sim_block[local_i].copy()
            sims[global_i] = -1  # exclude self

            top_k_idx = np.argpartition(sims, -knn)[-knn:]
            for j in top_k_idx:
                s = float(sims[j])
                if s > 0:
                    rows += [global_i, j]
                    cols += [j, global_i]
                    vals += [s, s]

        if (start // batch) % 10 == 0:
            elapsed = time.time() - t0
            pct = end / n * 100
            print(f'    {pct:.0f}% ({end:,}/{n:,})  {elapsed:.1f}s', flush=True)

    adj = csr_matrix((vals, (rows, cols)), shape=(n, n))
    adj.setdiag(0)
    adj.eliminate_zeros()

    print(f'  Graph built: {adj.nnz:,} edges  ({time.time()-t0:.1f}s)')
    return adj


def normalized_laplacian(adj: csr_matrix) -> csr_matrix:
    """L_sym = I - D^{-1/2} A D^{-1/2}"""
    degrees = np.asarray(adj.sum(axis=1)).flatten()
    degrees = np.maximum(degrees, 1e-12)
    d_inv_sqrt = np.power(degrees, -0.5)
    D = diags(d_inv_sqrt)
    norm_adj = D @ adj @ D
    return diags(np.ones(adj.shape[0])) - norm_adj


# ── Heat Kernel ───────────────────────────────────────────────────────────────

def heat_kernel_diagonal(laplacian: csr_matrix, k: int, tau: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute per-node heat kernel diagonal scores.

    h(tau, v, v) = sum_k exp(-lambda_k * tau) * phi_k(v)^2

    Returns:
        heat_scores: (n,) per-node heat score
        eigvals:     (k,) eigenvalues used
        eigvecs:     (n, k) eigenvectors
    """
    k_actual = min(k, laplacian.shape[0] - 2)
    print(f'  Running Lanczos eigsh (k={k_actual}, tau={tau})...')
    t0 = time.time()

    eigvals, eigvecs = eigsh(laplacian, k=k_actual, which='SM', tol=1e-5, maxiter=3000)
    print(f'  Eigendecomposition: {time.time()-t0:.1f}s  '
          f'lambda range [{eigvals[0]:.4f}, {eigvals[-1]:.4f}]')

    heat_weights = np.exp(-eigvals * tau)
    heat_scores  = (eigvecs ** 2) @ heat_weights  # (n,)

    return heat_scores, eigvals, eigvecs


# ── Spectral Clustering ───────────────────────────────────────────────────────

def assign_clusters(eigvecs: np.ndarray, n_clusters: int = 12) -> np.ndarray:
    """
    Assign shards to spectral clusters using the first n_clusters eigenvectors.
    Simple k-means in spectral embedding space — no sklearn needed.
    """
    k = min(n_clusters, eigvecs.shape[1])
    embedding = eigvecs[:, :k]

    # Normalize rows
    norms = np.linalg.norm(embedding, axis=1, keepdims=True)
    embedding = embedding / (norms + 1e-8)

    n = len(embedding)
    # Random initialization
    rng = np.random.RandomState(42)
    centers = embedding[rng.choice(n, k, replace=False)]

    for _ in range(20):  # k-means iterations
        dists = np.sum((embedding[:, None, :] - centers[None, :, :]) ** 2, axis=2)
        labels = np.argmin(dists, axis=1)
        new_centers = np.array([
            embedding[labels == c].mean(axis=0) if (labels == c).any() else centers[c]
            for c in range(k)
        ])
        if np.allclose(centers, new_centers, atol=1e-4):
            break
        centers = new_centers

    return labels


# ── Band Classification ───────────────────────────────────────────────────────

def classify_band(heat: float, heat_mean: float, heat_std: float,
                  cite_density: float, vec: np.ndarray) -> str:
    """
    Classify shard into spectral band relative to corpus mean.

      settled:   high heat (well-connected to corpus), high citation density
                 → black-letter doctrine, well-anchored statute text
      contested: heat near corpus mean but high feature spread
                 → mixed signals, edge cases, evolving doctrine
      active:    moderate heat, moderate citations
                 → working law, applied doctrine
      noise:     low heat, low citations, near-zero feature vector
                 → boilerplate, index pages, meta-content
    """
    z = (heat - heat_mean) / (heat_std + 1e-8)
    vec_norm = float(np.linalg.norm(vec))

    if vec_norm < 0.05 and cite_density < 0.01:
        return 'noise'
    if z > 0.5 and cite_density > 0.05:
        return 'settled'
    if z < -0.5 or (vec_norm < 0.15 and cite_density < 0.03):
        return 'noise'
    if abs(z) < 0.3 and vec_norm > 0.2:
        return 'contested'
    return 'active'


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shards',  required=True)
    parser.add_argument('--out',     required=True)
    parser.add_argument('--tau',     type=float, default=0.05,
                        help='Heat diffusion time. Lower=local topology, higher=global structure')
    parser.add_argument('--k',       type=int,   default=64,
                        help='Eigenvectors for Lanczos (more=finer clusters, slower)')
    parser.add_argument('--knn',     type=int,   default=8,
                        help='k-NN edges per shard in corpus graph')
    parser.add_argument('--clusters', type=int,  default=12,
                        help='Spectral clusters to assign')
    parser.add_argument('--sample',  type=int,   default=0,
                        help='Sample N shards. 0=all')
    args = parser.parse_args()

    shard_dir = Path(args.shards)
    files = sorted(shard_dir.glob('*.json'))
    if args.sample > 0:
        step = max(1, len(files) // args.sample)
        files = files[::step][:args.sample]

    print(f'\n{"="*60}')
    print(f'  Eve_v2 — Corpus Spectral Heat Map')
    print(f'{"="*60}')
    print(f'  Shards:    {len(files):,}')
    print(f'  heat_tau:  {args.tau}')
    print(f'  k-eigvec:  {args.k}')
    print(f'  k-NN:      {args.knn}')
    print(f'  clusters:  {args.clusters}')
    print(f'{"="*60}\n')

    # ── 1. Load shards and build feature vectors ──
    print('Step 1/4 — Extracting legal signal vectors...')
    t0 = time.time()
    shards, vectors = [], []
    citation_densities = []

    for i, path in enumerate(files):
        try:
            shard = json.loads(path.read_text())
        except Exception:
            continue
        text = shard.get('content', shard.get('text', ''))
        vec = shard_to_vector(text)

        # Citation density (separate from vec — used for band classification)
        words = len(text.split())
        hits = sum(len(re.findall(p, text, re.IGNORECASE)) for p, _, _ in CITATION_SIGNALS)
        cite_density = hits / max(words / 100, 1)

        shards.append(shard)
        vectors.append(vec)
        citation_densities.append(cite_density)

        if (i + 1) % 5000 == 0:
            print(f'  {i+1:,}/{len(files):,} vectorized  ({time.time()-t0:.1f}s)')

    vectors = np.array(vectors, dtype=np.float32)
    citation_densities = np.array(citation_densities)
    print(f'  Done: {len(shards):,} shards → {vectors.shape}  ({time.time()-t0:.1f}s)')

    # ── 2. Build corpus graph ──
    print('\nStep 2/4 — Building corpus k-NN graph...')
    adj = build_corpus_graph(vectors, args.knn)

    # ── 3. Spectral decomposition + heat kernel ──
    print('\nStep 3/4 — Spectral decomposition...')
    lap = normalized_laplacian(adj)
    heat_scores, eigvals, eigvecs = heat_kernel_diagonal(lap, args.k, args.tau)

    # ── 4. Classify and cluster ──
    print('\nStep 4/4 — Classifying spectral bands + clustering...')
    cluster_labels = assign_clusters(eigvecs, args.clusters)

    heat_mean = float(np.mean(heat_scores))
    heat_std  = float(np.std(heat_scores))

    results = []
    band_counts: Dict[str, int] = {}

    for i, (shard, vec, heat, cite, cluster) in enumerate(
        zip(shards, vectors, heat_scores, citation_densities, cluster_labels)
    ):
        band = classify_band(heat, heat_mean, heat_std, cite, vec)
        band_counts[band] = band_counts.get(band, 0) + 1

        results.append({
            'id':               shard['id'],
            'source':           shard.get('source', ''),
            'title':            shard.get('title', ''),
            'heat_score':       round(float(heat), 6),
            'heat_z':           round((float(heat) - heat_mean) / (heat_std + 1e-8), 3),
            'citation_density': round(float(cite), 4),
            'spectral_band':    band,
            'cluster_id':       int(cluster),
            'vec_norm':         round(float(np.linalg.norm(vec)), 4),
        })

    # Cluster summaries
    cluster_summaries = {}
    for cid in range(args.clusters):
        members = [r for r in results if r['cluster_id'] == cid]
        if not members:
            continue
        heat_vals = [m['heat_score'] for m in members]
        cite_vals = [m['citation_density'] for m in members]
        sources   = {}
        for m in members:
            sources[m['source']] = sources.get(m['source'], 0) + 1
        cluster_summaries[str(cid)] = {
            'size':             len(members),
            'heat_mean':        round(float(np.mean(heat_vals)), 4),
            'heat_std':         round(float(np.std(heat_vals)), 4),
            'citation_mean':    round(float(np.mean(cite_vals)), 4),
            'dominant_source':  max(sources, key=sources.get),
            'band_distribution': {
                b: sum(1 for m in members if m['spectral_band'] == b)
                for b in ['settled', 'active', 'contested', 'noise']
            },
            'sample_titles':    [m['title'][:60] for m in
                                 sorted(members, key=lambda x: x['heat_score'], reverse=True)[:5]],
        }

    elapsed = time.time() - t0
    manifest = {
        'total_shards':         len(results),
        'elapsed_s':            round(elapsed, 1),
        'heat_tau':             args.tau,
        'k_eigenvecs':          args.k,
        'knn':                  args.knn,
        'n_clusters':           args.clusters,
        'corpus_heat_mean':     round(heat_mean, 6),
        'corpus_heat_std':      round(heat_std, 6),
        'eigval_min':           round(float(eigvals[0]), 6),
        'eigval_max':           round(float(eigvals[-1]), 6),
        'band_counts':          band_counts,
        'cluster_summaries':    cluster_summaries,
        'shards':               results,
    }

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(manifest, indent=2))

    print(f'\n{"="*60}')
    print(f'  Eve_v2 Spectral Heat Map — Complete')
    print(f'{"="*60}')
    print(f'  Total shards:    {len(results):,}')
    print(f'  Elapsed:         {elapsed:.1f}s')
    print(f'  Corpus heat:     {heat_mean:.4f} ± {heat_std:.4f}')
    for band, count in sorted(band_counts.items()):
        pct = 100 * count // max(len(results), 1)
        print(f'  {band:<12} {count:>6,}  ({pct}%)')
    print(f'\n  Cluster topology:')
    for cid, s in cluster_summaries.items():
        print(f'  C{cid:<3} size={s["size"]:>5,}  heat={s["heat_mean"]:.3f}  '
              f'cite={s["citation_mean"]:.2f}  [{s["dominant_source"][:20]}]')
    print(f'\n  Output: {args.out}')
    print(f'{"="*60}\n')


if __name__ == '__main__':
    main()
