import { LandmarkOrchestrator } from './landmark-orchestrator';

async function runBenchmark() {
    console.log(" [GOVERNANCE] Starting Fine-Tuning Obsolescence Benchmark...");
    
    const orchestrator = new LandmarkOrchestrator({
        shardDir: "/home/throttleneck-15/.openclaw/workspace/mnt/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean",
        ollamaUrl: "http://localhost:11434",
        queryThreshold: 0.40 // Tighter drift guard for diagnostics
    });

    // 1. Load the permanent memory
    const loaded = await orchestrator.loadIndex('husk.index');
    if (!loaded) {
        console.log("⚠️ Index not found. Rebuilding landmarks...");
        await orchestrator.buildIndex();
        await orchestrator.saveIndex('husk.index');
    }

    // 2. The Stress Case: Meningitis vs. Sepsis vs. Viral
    const complexCase = `
        A 5-year-old child presents with:
        1. High fever (103F)
        2. Stiff neck
        3. A purple, non-blanching rash (petechiae) on the legs.
        
        Using only the MedlinePlus shards, provide a differential diagnosis. 
        Focus on identifying the highest-heat landmarks for 'meningococcal sepsis' vs 'viral meningitis'.
    `;

    console.log(" [HUSK] Reasoning through complex topology...");
    const result = await orchestrator.query(complexCase);

    console.log("\n [DIAGNOSTIC RESULT]");
    console.log("--------------------------------------------------");
    console.log(result.answer);
    
    console.log("\n [EVIDENCE_CHAIN]");
    result.citations.forEach(c => {
        console.log(`- ${c.shardId} [Hamming: ${c.hammingRatio}]: ${c.source}`);
    });
}

runBenchmark().catch(console.error);
