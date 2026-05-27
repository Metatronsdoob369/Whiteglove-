#!/usr/bin/env python3
"""
alabama_code_scraper.py — Alabama Code of 1975 via ALISON GraphQL API
======================================================================
Uses the ALISON GraphQL API (alison.legislature.state.al.us/graphql)
to pull all sections of the Alabama Code as structured data.

No scraping — it's a clean GraphQL query. The API returns HTML content
which we strip to plain text and chunk into ~500-word shards.

Output: brain/shards/alabama/<shard_id>.json
Format matches WhiteGlove shard schema exactly.

Usage:
    python3 alabama_code_scraper.py                         # all titles
    python3 alabama_code_scraper.py --filter "13A"          # DUI/criminal only
    python3 alabama_code_scraper.py --filter "13A,32,15"   # multiple titles

Priority titles for legal defense:
    13A — Criminal Code
    32  — Motor Vehicles / Traffic / DUI
    15  — Criminal Procedure
    12  — Courts
"""

import argparse
import json
import re
import hashlib
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

# ── Config ────────────────────────────────────────────────────────────────────

GRAPHQL_URL = "https://alison.legislature.state.al.us/graphql"
OUT_DIR = Path(__file__).parent.parent / "shards" / "alabama"
CHUNK_SIZE = 500   # words per shard
SOURCE_TAG = "AlabamaCode-1975-2026"
PAGE_SIZE  = 1000  # GraphQL page size per request

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Referer": "https://alison.legislature.state.al.us/code-of-alabama",
}

# ── GraphQL fetch ─────────────────────────────────────────────────────────────

def graphql(query: str, variables: dict = {}):
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = Request(GRAPHQL_URL, data=payload, headers=HEADERS, method="POST")
    try:
        with urlopen(req, timeout=30) as resp:
            d = json.loads(resp.read().decode())
            if "errors" in d:
                print(f"  GQL error: {d['errors'][0]['message'][:100]}", flush=True)
                return None
            return d.get("data")
    except Exception as e:
        print(f"  Request failed: {e}", flush=True)
        return None

# ── Fetch all code records ────────────────────────────────────────────────────

QUERY = """
query GetCode($offset: Int, $limit: Int) {
  codesOfAlabama(offset: $offset, limit: $limit) {
    count
    data {
      id
      title
      sectionRange
      content
    }
  }
}
"""

def fetch_all_sections(title_filter=None):
    """Fetch all Alabama Code section records via paginated GraphQL."""
    print("Fetching Alabama Code from ALISON GraphQL...", flush=True)

    # First call: get total count
    first = graphql(QUERY, {"offset": 0, "limit": 1})
    if not first:
        print("ERROR: GraphQL fetch failed", flush=True)
        return []
    total = first.get("codesOfAlabama", {}).get("count", 0)
    print(f"  Total records: {total:,}", flush=True)

    all_records = []
    offset = 0
    while offset < total:
        data = graphql(QUERY, {"offset": offset, "limit": PAGE_SIZE})
        if not data:
            print(f"  Failed at offset {offset}, stopping", flush=True)
            break
        batch = data.get("codesOfAlabama", {}).get("data", [])
        if not batch:
            break
        all_records.extend(batch)
        print(f"  Fetched {len(all_records):,}/{total:,}", flush=True, end="\r")
        offset += PAGE_SIZE

    print(f"\n  Done: {len(all_records):,} records", flush=True)
    return all_records

# ── Text processing ───────────────────────────────────────────────────────────

def html_to_text(html: str) -> str:
    """Strip HTML tags and normalize whitespace."""
    if not html:
        return ""
    # Remove common noise tags with content
    html = re.sub(r'<style[^>]*>.*?</style>', ' ', html, flags=re.DOTALL)
    html = re.sub(r'<script[^>]*>.*?</script>', ' ', html, flags=re.DOTALL)
    # Preserve paragraph breaks
    html = re.sub(r'<p[^>]*>', ' ', html)
    html = re.sub(r'<br\s*/?>', ' ', html)
    html = re.sub(r'<li[^>]*>', ' • ', html)
    # Strip all remaining tags
    html = re.sub(r'<[^>]+>', '', html)
    # Decode common HTML entities
    html = html.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    html = html.replace('&nbsp;', ' ').replace('&#167;', '§').replace('&sect;', '§')
    html = html.replace('&#39;', "'").replace('&quot;', '"')
    # Normalize whitespace
    html = re.sub(r'\s+', ' ', html).strip()
    return html

def extract_section_id(title_str: str) -> str:
    """Extract section ID from 'Section 13A-6-2 Murder.' etc."""
    m = re.match(r'Section\s+([\w\-\.]+)', title_str or '', re.IGNORECASE)
    return m.group(1) if m else ""

def extract_title_num_from_section(section_id: str) -> str:
    """
    Extract title number from section ID.
    '13A-6-2' -> '13A'
    '32-5A-191' -> '32'
    '1-1-1' -> '1'
    """
    m = re.match(r'^([A-Za-z0-9]+[A-Za-z]?)', section_id)
    if m:
        # Split on first hyphen to get title part
        parts = section_id.split('-')
        return parts[0].upper()
    return ""

def is_section(record: dict) -> bool:
    """True if this record is a section (has content), not a title/chapter header."""
    return bool(record.get("content")) and "Section" in (record.get("title") or "")

# ── Chunking ──────────────────────────────────────────────────────────────────

def chunk_text(text: str, section_id: str, section_title: str, title_num: str) -> list[dict]:
    """Split text into ~500-word chunks matching WhiteGlove shard schema."""
    words = text.split()
    if not words:
        return []

    total_chunks = max(1, (len(words) + CHUNK_SIZE - 1) // CHUNK_SIZE)
    chunks = []

    for i, start in enumerate(range(0, len(words), CHUNK_SIZE)):
        chunk_words = words[start:start + CHUNK_SIZE]
        chunk_text  = " ".join(chunk_words)
        safe_id     = re.sub(r'[^\w]', '_', section_id)
        shard_id    = f"al_{safe_id}_{i:03d}"

        chunks.append({
            "id":           shard_id,
            "shardId":      shard_id,
            "content":      chunk_text,
            "title":        f"Ala. Code §{section_id} — {section_title}",
            "source":       "Alabama Code of 1975",
            "path":         f"Title {title_num}/Section {section_id}",
            "domain":       "legal",
            "source_tag":   SOURCE_TAG,
            "chunk_index":  i,
            "total_chunks": total_chunks,
            "word_count":   len(chunk_words),
            "quality_score": round(min(1.0, len(chunk_words) / CHUNK_SIZE), 3),
            "section_id":   section_id,
            "title_num":    title_num,
        })

    return chunks

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape Alabama Code via ALISON GraphQL")
    parser.add_argument("--filter", default="", help="Comma-separated title numbers to include (e.g. '13A,32,15'). Default: all.")
    parser.add_argument("--out",    default=str(OUT_DIR), help="Output directory")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    title_filter = [t.strip().upper() for t in args.filter.split(",") if t.strip()]
    if title_filter:
        print(f"Filtering to titles: {title_filter}", flush=True)

    records = fetch_all_sections(title_filter)
    if not records:
        sys.exit(1)

    total_shards = 0
    sections_written = 0
    skipped = 0

    for rec in records:
        title_str = rec.get("title", "") or ""

        # Skip non-section records (title/chapter headers have no content)
        if not is_section(rec):
            continue

        section_id    = extract_section_id(title_str)
        title_num     = extract_title_num_from_section(section_id)
        section_title = re.sub(r'^Section\s+[\w\-\.]+\s*', '', title_str).strip(' .')

        # Apply title filter
        if title_filter and title_num not in title_filter:
            skipped += 1
            continue
        raw_html      = rec.get("content", "") or ""
        text          = html_to_text(raw_html)

        if not text or len(text.split()) < 10:
            continue

        chunks = chunk_text(text, section_id or rec["id"], section_title, title_num)
        for chunk in chunks:
            out_path = out_dir / f"{chunk['id']}.json"
            out_path.write_text(json.dumps(chunk, indent=2))
            total_shards += 1

        sections_written += 1
        if sections_written % 100 == 0:
            print(f"  {sections_written} sections → {total_shards} shards", flush=True)

    print(f"\n✅ Done.", flush=True)
    print(f"   Sections written: {sections_written}", flush=True)
    print(f"   Total shards:     {total_shards}", flush=True)
    print(f"   Skipped (filter): {skipped}", flush=True)
    print(f"   Output dir:       {out_dir}", flush=True)
    print(f"\nNext steps:", flush=True)
    print(f"   python3 brain/spectral/legal_heatmap.py --shards {out_dir}", flush=True)
    print(f"   python3 brain/spectral/legal_temporal_ingest.py --shards {out_dir} --heatmap ...", flush=True)

if __name__ == "__main__":
    main()
