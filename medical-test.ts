import { LandmarkOrchestrator } from './brain/landmark-orchestrator';
import path from 'path';

async function testMedical() {
    console.log(" [ORCHESTRATOR] Initializing Medical Intelligence Core...");
    
    // Create orchestrator pointing to medical data
    const orchestrator = new LandmarkOrchestrator({
        shardDir: "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/medical_clean",
        queryThreshold: 0.45 // Slightly wider for cross-domain matching
    });

    const queries = [
        "What are the symptoms of high blood pressure?",
        "How do I recognize a heart attack?",
        "Information about diabetes management",
        "What should I do if I find a tick on me?"
    ];

    for (const q of queries) {
        console.log(`\n Query: "${q}"`);
        const result = await orchestrator.query(q);
        
        console.log(`\n═══════════════════════════════════════════════════`);
        console.log(`  GENERATED ANSWER`);
        console.log(`═══════════════════════════════════════════════════`);
        console.log(result.answer);
        
        console.log(`\n───────────────────────────────────────────────────`);
        console.log(`  TOPOLOGICAL LANDMARKS (Citations)`);
        console.log(`───────────────────────────────────────────────────`);
        result.citations.forEach((c: any) => {
            console.log(`   ${c.shardId} [Hamming: ${c.hammingRatio.toFixed(4)}] - ${c.source}`);
            console.log(`     "${c.preview}..."`);
        });

        console.log(`\n───────────────────────────────────────────────────`);
        console.log(`  METRICS`);
        console.log(`───────────────────────────────────────────────────`);
        console.log(`  Index Lookup: ${result.metrics.indexLookupMs}ms`);
        console.log(`  Inference:    ${result.metrics.inferenceMs}ms`);
        console.log(`  Shards Eval:  ${result.metrics.shardsEvaluated}`);
    }
}

testMedical().catch(console.error);
