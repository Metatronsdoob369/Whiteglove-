"""
publish_hf.py — WhiteGlove → Hugging Face Hub Publisher

Publishes the curated medical dataset to HF Hub.
Run after: huggingface-cli login

Usage:
    python3 brain/indexer/publish_hf.py
    python3 brain/indexer/publish_hf.py --private   # private repo first
    python3 brain/indexer/publish_hf.py --repo my-org/my-dataset-name
"""

import argparse
import json
import os
from pathlib import Path

EXPORTS_DIR  = Path("/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/exports")
DEFAULT_REPO = "joecwales/whiteglove-medical-medlineplus-2025"

def publish(repo_id: str, private: bool):
    try:
        from huggingface_hub import HfApi, whoami
        from datasets import load_dataset, DatasetDict
    except ImportError:
        print("Run: pip3 install huggingface_hub datasets")
        return

    # ── Auth check ────────────────────────────────────────────────────────────
    try:
        me = whoami()
        print(f"Logged in as: {me['name']}")
    except Exception:
        print("Not logged in. Run: huggingface-cli login")
        return

    api = HfApi()

    # ── Create repo if needed ─────────────────────────────────────────────────
    print(f"\nCreating dataset repo: {repo_id} (private={private})")
    try:
        api.create_repo(
            repo_id=repo_id,
            repo_type="dataset",
            private=private,
            exist_ok=True,
        )
        print(f"Repo ready: https://huggingface.co/datasets/{repo_id}")
    except Exception as e:
        print(f"Repo creation error: {e}")
        return

    # ── Upload dataset card (README.md) ───────────────────────────────────────
    readme = EXPORTS_DIR / "README.md"
    if readme.exists():
        print("\nUploading README.md (dataset card)...")
        api.upload_file(
            path_or_fileobj=str(readme),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type="dataset",
        )
        print("Dataset card uploaded.")

    # ── Upload manifest ───────────────────────────────────────────────────────
    manifest = EXPORTS_DIR / "manifest.json"
    if manifest.exists():
        print("Uploading manifest.json...")
        api.upload_file(
            path_or_fileobj=str(manifest),
            path_in_repo="manifest.json",
            repo_id=repo_id,
            repo_type="dataset",
        )

    # ── Upload JSONL files ────────────────────────────────────────────────────
    for fname in ["train.jsonl", "validation.jsonl"]:
        fpath = EXPORTS_DIR / fname
        if not fpath.exists():
            print(f"Missing: {fpath} — run export_training_set.py first")
            continue

        size_mb = fpath.stat().st_size / 1024 / 1024
        print(f"\nUploading {fname} ({size_mb:.1f}MB)...")
        api.upload_file(
            path_or_fileobj=str(fpath),
            path_in_repo=f"data/{fname}",
            repo_id=repo_id,
            repo_type="dataset",
        )
        print(f"{fname} uploaded.")

    # ── Upload pipeline scripts ───────────────────────────────────────────────
    scripts = [
        ("brain/indexer/rechunk_medical.py",      "pipeline/rechunk_medical.py"),
        ("brain/indexer/export_training_set.py",  "pipeline/export_training_set.py"),
        ("brain/indexer/zim_extractor.py",        "pipeline/zim_extractor.py"),
    ]
    root = Path("/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk")
    print("\nUploading pipeline scripts...")
    for local_rel, repo_path in scripts:
        local = root / local_rel
        if local.exists():
            api.upload_file(
                path_or_fileobj=str(local),
                path_in_repo=repo_path,
                repo_id=repo_id,
                repo_type="dataset",
            )
            print(f"  {repo_path}")

    # ── Done ──────────────────────────────────────────────────────────────────
    visibility = "private" if private else "public"
    print(f"\n{'='*56}")
    print(f"  Published ({visibility})")
    print(f"  https://huggingface.co/datasets/{repo_id}")
    print(f"{'='*56}")
    print()
    print("  Load it:")
    print(f"    from datasets import load_dataset")
    print(f"    ds = load_dataset('{repo_id}')")
    print()
    if private:
        print("  Make public when ready:")
        print(f"    huggingface-cli repo visibility {repo_id} --type dataset --visibility public")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo",    default=DEFAULT_REPO, help="HF repo id (org/name)")
    parser.add_argument("--private", action="store_true",  help="Create as private first")
    args = parser.parse_args()
    publish(args.repo, args.private)
