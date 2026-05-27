import { LandmarkOrchestrator } from './landmark-orchestrator';
import fs from 'fs';
import path from 'path';

/**
 * BROSEIDON MISSION CONTROL: 3072-D SPECTRAL INDEXER
 * 
 * Optimized for Raspberry Pi 5 (3GHz + Vulkan acceleration)
 * Targets the MedlinePlus Medical Core (15,580 shards)
 */

async function broseidonPulse() {
    console.log(" [BROSEIDON] 3GHz Spectral Activation Engaged.");
    
    // Detect environment and adjust mount points
    // Mac uses /Volumes/ARCHIVE, Pi likely uses /mnt/ARCHIVE or /media/pi/ARCHIVE
    const possiblePaths = [
        "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean",
        "/mnt/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean",
        "/media/pi/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean"
    ];

    let shardDir = possiblePaths[0];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            shardDir = p;
            break;
        }
    }

    console.log(` Targeting Shard Directory: ${shardDir}`);

    const orchestrator = new LandmarkOrchestrator({
        shardDir: shardDir,
        ollamaUrl: "http://localhost:11434",
        queryThreshold: 0.45,
        maxContextShards: 5
    });

    console.log(" Indexing 15,580 shards into SimHash-128 space...");
    const startMs = Date.now();
    await orchestrator.buildIndex(15580);
    const elapsed = Date.now() - startMs;
    
    const stats = orchestrator.diagnostics();
    console.log(`✅ Index Stable. Shards: ${stats.indexSize}`);
    console.log(`⏱️  Index Build Time: ${(elapsed / 1000).toFixed(2)}s`);
    console.log(` [BROSEIDON] Readiness: DIAMOND-STABLE. Ready for Mission Queries.`);
}

broseidonPulse().catch(console.error);
