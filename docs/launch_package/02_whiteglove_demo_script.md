# WhiteGlove Agent Husk — 90-Second Demo Script

**Target runtime:** 90 seconds **Format:** Screen capture with voice-over, hard cuts between beats **Audience:** Technical evaluator \+ decision-maker (CISO, GC, CCO, CMO of regulated firm) **Goal:** Prove faith-less retrieval, prove silence-on-miss, prove auditable snapshot in one continuous flow
**Repo SHA:** `e4e66ff` **Last updated:** 2026-05-19

**Artifact outputs:** `/docs/demo/90s_proof_demo.md`, `/docs/demo/30s_teaser_demo.md`, `/docs/demo/15s_social_cut.md`

---

## Production Checklist

- [ ] Terminal theme: dark, monospaced, 16pt minimum  
- [ ] Window chrome hidden, recorder at 1920x1080  
- [ ] Mouse cursor enlarged  
- [ ] Pre-loaded corpus: 1,000 HIPAA-style policy docs \+ 50 oral surgery procedure notes  
- [ ] Pre-flighted: API daemon running, Vault unsealed, snapshot dir empty  
- [ ] Voice-over recorded separately, layered in post; on-screen text overlays key claims

---

## Beat Sheet

### Beat 1 — 0:00–0:08 — Cold open

**On screen:** WhiteGlove wordmark on black. Text fade-in: "Other AI guesses. This one stays silent when it doesn't know."

**Voice-over:** "WhiteGlove. Faith-less retrieval for regulated environments. No internet. No fabrication. No exceptions."

**Cut.**

---

### Beat 2 — 0:08–0:22 — Live query, confident hit

**On screen:** Terminal in foreground.

$ whiteglove query "post-op care after impacted third molar extraction"

Response renders progressively. Highlighted: source citation, snapshot ID, confidence score, retrieval latency.

**Voice-over:** "Ask it something the corpus knows. It answers — and every claim is bound to a source document, a snapshot ID, and a timestamp. No paraphrase drift. No invented citations."

**On-screen overlay:** `Citation: extraction_postop_v3.md §4.2 · Snapshot 2026-05-18T14:22Z · 1.1s`

**Cut.**

---

### Beat 3 — 0:22–0:36 — Live query, miss → silence

**On screen:** Same terminal.

$ whiteglove query "drug interaction protocol for experimental compound X-7733"

Response: `No qualifying source. No answer.`

**Voice-over:** "Ask it something the corpus does not contain. It refuses. That refusal is the product. In legal, in medicine, in finance — fabrication is the liability. Silence is the safeguard."

**On-screen overlay:** `Zero hallucination. Zero fabrication. Auditable refusal.`

**Cut.**

---

### Beat 4 — 0:36–0:52 — Snapshot freeze

**On screen:** Single command.

$ whiteglove snapshot freeze \--label "pre-launch-baseline"

Output streams: hashes, point counts, manifest path, signature.

**Voice-over:** "Freeze the current state of knowledge in one command. Every source hash, every embedder ID, every operator action — sealed into a verifiable manifest. Restore it years from now. Prove what you knew, when."

**On-screen overlay:** `RPO: 0 · RTO: ≤5 min · Hash-chained · 7-year retention`

**Cut.**

---

### Beat 5 — 0:52–1:08 — Audit log export

**On screen:** Audit log streaming.

$ whiteglove audit export \--since "2026-05-18T00:00Z" \--format jsonl

JSONL records scroll: each query, each response, each refusal, each operator action.

**Voice-over:** "Every retrieval. Every refusal. Every administrative action. Append-only, hash-chained, ready for regulators, ready for opposing counsel, ready for your board."

**On-screen overlay:** `SEC 17a-4(f) · HIPAA §164.312(b) · SOC 2 CC7.2`

**Cut.**

---

### Beat 6 — 1:08–1:22 — Architecture flash

**On screen:** Diagram, 3 seconds: local node, corpus store, snapshot vault, audit log. Red X over a cloud silhouette outside the boundary.

**Voice-over:** "Nothing leaves your perimeter. No telemetry. No cloud round-trip. No vendor in your data path."

**Cut.**

---

### Beat 7 — 1:22–1:30 — Close

**On screen:** WhiteGlove wordmark. Tagline: "WhiteGlove. The AI that will not guess."

**Voice-over:** "WhiteGlove Agent Husk. Trustworthy by architecture. Auditable by default. Available on-premise today."

**End card:** `whiteglove.ai · sales@whiteglove.ai`

---

## Post-Production Notes

- Color-grade for slight blue cast in terminal scenes to evoke clinical / institutional feel  
- Sound design: minimal. One soft chime on each `Cut.` transition. No music bed under voice-over.  
- Subtitles: hard-burned, sans-serif, white-on-black bar; required for accessibility and silent-autoplay scenarios on landing pages  
- Export three masters: full 90s, 30s teaser (Beats 1, 3, 7), 15s social cut (Beat 3 only with cold-open card)

---

## Failure Modes to Rehearse

- **API daemon slow on first warm-up:** Pre-warm with a throwaway query 5 seconds before record.  
- **Snapshot directory not empty:** Reset before each take to ensure clean output.  
- **Overlay text out of sync:** Voice-over should pause 200 ms after each overlay reveal.  
- **Demo corpus stale:** Re-ingest the morning of recording; capture the actual snapshot ID for the marketing asset.
