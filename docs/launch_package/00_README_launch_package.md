# WhiteGlove Agent Husk — Launch Package

**Version:** 1.1 (`e4e66ff`) **Date:** 2026-05-19 **Status:** Baseline for buyer / procurement interaction

This package is the coordinated launch drop for WhiteGlove Agent Husk. Each document is buyer-ready and cross-consistent with the others. Treat this as the canonical baseline. Update files in place; rev the version date at the top.

---

## Package Contents

| \# | File | Audience | Purpose |
| :---- | :---- | :---- | :---- |
| 00 | `00_README_launch_package.md` | Internal | This index. Master of the drop. |
| 01 | `01_whiteglove_datasheet.md` | Technical evaluator, procurement | One-page technical spec with full API surface, performance metrics, DR posture |
| 02 | `02_whiteglove_demo_script.md` | Internal (production team) | 90-second beat sheet with narration timing, on-screen actions, and post-production notes |
| 03 | `03_whiteglove_landing_healthcare.md` | Clinical buyer, CMIO, practice owner | Pain hook, proof artifact, three objections, CTA |
| 04 | `04_whiteglove_landing_finance.md` | Hedge fund ops, compliance, trading desk lead | Alpha protection, SEC 17a-4 defensibility, three objections, CTA |
| 05 | `05_whiteglove_landing_legal.md` | Managing partner, GC, in-house counsel | Malpractice avoidance, privilege preservation, three objections, CTA |
| 06 | `06_whiteglove_threat_model.md` | CISO, security architect, examiner | STRIDE mapping, 10 named threat vectors with mitigation and residual risk |
| 07 | `07_whiteglove_compliance.md` | CCO, privacy officer, auditor | Control-to-citation mapping for HIPAA, SEC 17a-4, FINRA 4511, SOC 2, GDPR, ABA, NIST CSF 2.0, CCPA |

---

## How to Use This Folder

### For a healthcare prospect

Lead with `03_landing_healthcare.md`. Attach `01_datasheet.md` and `07_compliance.md` (HIPAA section flagged). Schedule the 90-second demo from `02_demo_script.md`. Hold the threat model in reserve for the security review.

### For a hedge fund or finance prospect

Lead with `04_landing_finance.md`. Attach `01_datasheet.md` and `07_compliance.md` (SEC 17a-4 and FINRA 4511 sections flagged). Demo on request. Threat model goes to the CISO before the contract review.

### For a law firm or in-house legal prospect

Lead with `05_landing_legal.md`. Attach `01_datasheet.md` and `07_compliance.md` (ABA Model Rules section flagged). The malpractice-by-fabrication narrative carries the room; the demo reinforces it.

### For a regulator, examiner, or external auditor

Lead with `07_compliance.md` and `06_threat_model.md`. The datasheet supports specifics; landing pages stay out of that conversation.

---

## Brand and Tone Conventions

- **Product full name:** WhiteGlove Agent Husk  
- **Short name in body copy:** WhiteGlove  
- **Never:** "WG", "Husk" alone, or marketing-y abbreviations  
- **The core thesis is one sentence:** "WhiteGlove returns only artifact-backed answers from a curated local corpus. When the corpus does not qualify, it stays silent."  
- **Words to avoid:** "magical", "AI-powered" (vague), "revolutionary", "next-generation", emojis in body copy  
- **Words to lean into:** "artifact-backed", "faith-less", "auditable", "snapshot", "refusal", "provenance"  
- **Tone:** institutional, sober, technical. The buyer's auditor should read these and find nothing to roll their eyes at.

---

## Cross-Document Consistency Check

The following facts appear in multiple documents. If any one is updated, propagate everywhere.

| Fact | Authoritative location |
| :---- | :---- |
| Version string (`e4e66ff`) | `01_datasheet.md` §header |
| Warm retrieval latency (1.1 s p50 Pi, 180 ms p50 Server) | `01_datasheet.md` §4 |
| Corpus stable size (100,000 docs / 30 GB) | `01_datasheet.md` §3 |
| Encryption inventory (AES-256-GCM, TLS 1.3, SHA-256, Ed25519) | `06_threat_model.md` §4 |
| Retention default (7 years) | `07_compliance.md` §2 |
| RPO 0 / RTO ≤ 5 min | `01_datasheet.md` §8 |
| Faith-less contract wording | `00_README_launch_package.md` §brand |

---

## Next Steps (post-drop)

1. Record the 90-second demo against the script in `02_demo_script.md`. Capture the snapshot ID from the actual recording session for use in landing pages.  
2. Stand up `whiteglove.ai` with the three landing pages and a single CTA per page.  
3. Publish `06_threat_model.md` and `07_compliance.md` as gated PDFs behind a low-friction sales form.  
4. Open a security advisory channel and a PGP-signed disclosure inbox at `security@whiteglove.ai`.  
5. Draft the BAA, DPA, and Enterprise MSA templates as the next document drop.  
6. Begin three pilot conversations — one per vertical — with the package as the leave-behind.

---

## Canonical Artifact Links

- Demo artifact root: `/docs/demo/`
- 90-second proof demo placeholder: `/docs/demo/90s_proof_demo.md`
- Evidence artifact root: `/docs/artifacts/`
- Audit sample placeholder: `/docs/artifacts/audit_log_sample_placeholder.md`
- Snapshot manifest placeholder: `/docs/artifacts/snapshot_manifest_example.md`

---

## Document History

| Date | Version | Change | Author |
| :---- | :---- | :---- | :---- |
| 2026-05-18 | 1.0 | Initial coordinated drop | WhiteGlove launch team |
| 2026-05-19 | 1.1 | Launch package normalized to current SHA; canonical demo/artifact placeholders added | WhiteGlove launch team |
