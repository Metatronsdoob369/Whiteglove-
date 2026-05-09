import libzim
import os

ZIM_PATH = "/Volumes/ARCHIVE/Emergency_Information/ZIM_Archives/medlineplus.gov_en_all_2025-01.zim"

def debug_zim():
    archive = libzim.Archive(ZIM_PATH)
    print(f"Archive: {ZIM_PATH}")
    print(f"Entry count: {archive.entry_count}")
    
    for i in range(500):
        entry = archive._get_entry_by_id(i)
        path = entry.path
        
        static = any(path.endswith(ext) for ext in [".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".woff2", ".ico", ".js.map", ".json"])
        redirect = hasattr(entry, 'is_redirect') and entry.is_redirect
        
        item = None
        try:
            item = entry.get_item()
            item_redirect = hasattr(item, 'is_redirect') and item.is_redirect
        except:
            item_redirect = "ERROR"
            
        print(f"Index {i}: {path} | static: {static} | redirect: {redirect} | item_redir: {item_redirect}")

if __name__ == "__main__":
    debug_zim()
