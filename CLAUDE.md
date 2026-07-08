# CLAUDE.md — WhiteGlove MVP Execution Profile

## Project Objective
- Build the core offline intelligence pipeline (WhiteGlove) for tokenless memory, including index building, calibration, and RAG/inference gates.
- Goal: Embed once, query forever. Expose RAG-style semantic search using Qdrant client, SimHash-128 drift guards, and L₂-normalization gates.

## Build, Run & Test Commands
- **Build & Run**:
  - Install: `npm install`
  - Compile: `npm run build`
  - Start API Server: `npm run start` (or dev: `npm run dev`)
- **Operations & Indexing**:
  - Calibrate SimHash/Resonance: `npm run calibrate`
  - Build Spectral Index: `npm run build-index`
  - Shatter Shards: `npm run shatter`
- **Testing & Safety**:
  - Run Tests: `npm run test` (Regression + retrieval tests)
  - Secrets Scan: `npm run secrets:scan`

## Strict Execution Rules
- **Pure Retrieval Priority**: Until a Q4 model is configured, prioritize `retrieve()` (Faith-Less pure source retrieval, 1ms latency) over `query()` (RAG inference) as Falcon3-7B 1.58-bit produces slop on raw RAG prompts.
- **Precision Preservation**: Use Kahan summation for all L₂-normalization gate operations.
- **Extreme Density**: Output ultra-modular, clean, uncommented code.
- **Single-Turn Execution**: Achieve full tasks in one turn without halting for micro-approvals.
