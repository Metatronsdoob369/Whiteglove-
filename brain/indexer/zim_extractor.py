import libzim
import os
import json
from pathlib import Path

ZIM_PATH = "/Volumes/ARCHIVE/Emergency_Information/ZIM_Archives/medlineplus.gov_en_all_2025-01.zim"
OUTPUT_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical"

def extract_zim():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    archive = libzim.Archive(ZIM_PATH)
    print(f"Archive: {ZIM_PATH}")
    print(f"Entry count: {archive.entry_count}")
    
    count = 0
    # Iterate through all entries to find content
    print(f"Starting full extraction of {archive.entry_count} entries...")
    for i in range(archive.entry_count):
        try:
            entry = archive._get_entry_by_id(i)
            path = entry.path
            
            # Skip static assets
            if any(path.endswith(ext) for ext in [".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".woff2", ".ico", ".js.map", ".json", ".woff"]):
                continue
            
            # Skip redirects
            if hasattr(entry, 'is_redirect') and entry.is_redirect:
                continue
                
            item = entry.get_item()
            if hasattr(item, 'is_redirect') and item.is_redirect:
                continue
            
            shard_id = f"med_{i:06d}"
            shard_path = os.path.join(OUTPUT_DIR, f"{shard_id}.json")
            
            if os.path.exists(shard_path):
                count += 1
                continue

            content_bytes = item.content
            if not content_bytes:
                continue
                
            # Skip massive files that would choke the retrieval engine
            # 1MB cap for a single shard
            if len(content_bytes) > 1024 * 1024:
                print(f"⚠️ Skipping oversized entry ({len(content_bytes) / 1024:.1f}KB): {path}")
                continue

            if hasattr(content_bytes, 'tobytes'):
                content_bytes = content_bytes.tobytes()
                
            content = content_bytes.decode('utf-8', errors='ignore')
            
            # Basic check for article content
            if "<html" not in content.lower() and "<body" not in content.lower():
                continue
                
            title = entry.title or path.split('/')[-1].replace('.html', '').replace('_', ' ')
            
            shard = {
                "id": shard_id,
                "source": "MedlinePlus",
                "title": title,
                "path": path,
                "content": content
            }
            
            with open(shard_path, "w") as f:
                json.dump(shard, f)
                
            count += 1
            if count % 1000 == 0:
                print(f"Processed {count} entries...")
            
        except Exception as e:
            if i % 5000 == 0:
                print(f"Error at index {i}: {e}")
            continue

    print(f"Extraction complete. Total: {count}")

if __name__ == "__main__":
    extract_zim()
