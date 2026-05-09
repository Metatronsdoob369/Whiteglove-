import fs from 'fs';
import path from 'path';

const INPUT_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical";
const OUTPUT_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean";

function stripHtml(html: string): string {
    // Basic HTML stripping logic
    return html
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
        .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function processMedical() {
    console.log("🧼 [HUSK] Cleaning Medical Data...");
    
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    
    const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith(".json"));
    console.log(`Found ${files.length} medical shards to process.`);
    let count = 0;

    for (const file of files) {
        const outPath = path.join(OUTPUT_DIR, file);
        // Skip if already cleaned
        if (fs.existsSync(outPath)) {
            count++;
            continue;
        }

        const raw = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, file), 'utf-8'));
        const cleanContent = stripHtml(raw.content);
        
        // Only keep if there's substantial content
        if (cleanContent.length < 200) continue;

        const shard = {
            id: raw.id,
            shardId: raw.id, // Ensure both are present for compatibility
            source: raw.source,
            title: raw.title,
            path: raw.path,
            content: cleanContent,
            contentPreview: cleanContent.slice(0, 200).replace(/\n/g, ' '),
            timestamp: new Date().toISOString()
        };

        fs.writeFileSync(outPath, JSON.stringify(shard, null, 2));
        count++;
        
        if (count % 1000 === 0) {
            console.log(`Processed ${count} articles...`);
        }
    }

    console.log(`✅ [HUSK] Cleaning Complete. Total processed: ${count}`);
}

processMedical().catch(console.error);
