import { LandmarkOrchestrator } from './brain/landmark-orchestrator';
import fs from 'fs';
import path from 'path';

async function visualizeTopology() {
    console.log("️ [HUSK] Generating Topological Heat Map...");
    
    const orchestrator = new LandmarkOrchestrator({
        shardDir: "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean"
    });
    await (orchestrator as any).buildIndex(1000);

    // Get a subset of shards to analyze
    const shards = orchestrator.diagnostics().indexSize;
    if (shards < 100) {
        console.log("⚠️ Not enough shards yet for a meaningful map. Wait for more extraction.");
        return;
    }

    // Pick random shards and find their neighbors
    const sampleSize = 8;
    const totalShards = orchestrator.diagnostics().indexSize;
    const sampleIndices = Array.from({length: sampleSize}, () => Math.floor(Math.random() * totalShards));
    
    console.log(`\n [RESONANCE LOG] Scanning ${sampleSize} Landmark clusters...\n`);
    
    for (const idx of sampleIndices) {
        const center = orchestrator.getIndexEntry(idx);
        if (!center) continue;

        console.log(` CENTER: ${center.shardId} | "${center.title}"`);
        
        // Find closest neighbors in the entire index
        const neighbors = orchestrator.findNeighbors(center.signature, 4);
        
        neighbors.forEach(n => {
            const matchScore = (1 - n.hammingRatio) * 100;
            const barWidth = Math.floor(matchScore / 5);
            const bar = "".repeat(barWidth);
            console.log(`   ${matchScore.toFixed(1)}% [${bar.padEnd(20)}] -> ${n.shardId} | "${n.title}"`);
        });
        console.log("");
    }
}

// Need to expose getIndexEntry and findNeighbors in LandmarkOrchestrator
visualizeTopology().catch(console.error);
