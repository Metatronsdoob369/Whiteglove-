# WhiteGlove for Legal

## A research assistant that will not invent a case.
**Repo SHA:** `e73b7ad` **Last updated:** 2026-05-19

You have read the headlines. Attorneys sanctioned for filing briefs containing AI-fabricated citations. Firms exposed for sending privileged work product to cloud AI vendors. The market answered with louder cloud LLMs. WhiteGlove Agent Husk answers with a different architecture: every retrieval is bound to a real document in your curated corpus, or there is no retrieval.

**[Watch the 90-second proof demo ▶](/docs/demo/90s_proof_demo.md)**

---

## Built for the practices that cannot afford a phantom citation

- **Litigation and trial practice** — case files, deposition transcripts, internal memos, expert reports  
- **Corporate and transactional** — precedent contracts, negotiation playbooks, clause libraries, regulatory advisories  
- **In-house counsel** — policy archives, compliance procedures, vendor agreements, employment matters  
- **Regulatory and government practice** — agency rules, enforcement actions, internal interpretive memos

---

## The proof artifact

Every WhiteGlove answer carries:

- File-and-section citation to a document in your curated corpus  
- Snapshot ID anchoring the state of authority at the moment of query  
- Timestamp, operator identity, and hash-chained audit entry  
- Recorded refusal when the corpus does not qualify — privilege of silence over the malpractice of invention
- Audit evidence placeholder: `/docs/artifacts/audit_log_sample_placeholder.md`
- Snapshot evidence placeholder: `/docs/artifacts/snapshot_manifest_example.md`

You can demonstrate, in a disciplinary inquiry or a sanctions hearing, exactly what authority was available to your attorneys on the date of filing.

---

## What it costs to not have this

| Scenario | Cloud AI exposure | WhiteGlove posture |
| :---- | :---- | :---- |
| Associate uses cloud LLM to draft brief; AI invents a citation | Rule 11 sanctions; bar referral | Refusal or fully-cited answer. The phantom is impossible. |
| Privileged work product copy-pasted into a cloud assistant | Waiver risk; ABA Model Rule 1.6 exposure | Zero outbound traffic. Privilege preserved by architecture. |
| Opposing counsel demands the research trail for a 2024 motion | Reconstructed from memory | Restore the snapshot. Produce the manifest. |
| Firm migrates LLM vendors and old reasoning is irreproducible | Inconsistent advice over time | Snapshots are forever. Restore any prior state. |

---

## The three objections we hear most

### "Westlaw and Lexis already have AI features. Why do we need this?"

Those tools are excellent for primary legal research over their proprietary corpora. WhiteGlove is not a replacement for primary research. It is a retrieval layer over **your** archive — your precedent contracts, your client memos, your internal know-how, your firm-specific playbooks — the material those vendors do not possess and cannot reason over. The competitor is not Westlaw. The competitor is the partner who tries to remember which client agreement had the carve-out language and gives up after twenty minutes of folder spelunking.

### "ABA Model Rule 1.6 is non-negotiable. How is this actually safe?"

WhiteGlove processes queries entirely on infrastructure controlled by the firm. Client confidences never leave the perimeter. There is no vendor in the data path, no model fine-tuning over your archive, no telemetry stream. The configuration aligns with the duty of confidentiality, the duty of technological competence (ABA Comment 8 to Rule 1.1), and the supervision obligations under Rules 5.1 and 5.3. For full mapping, see our Compliance document.

### "We tried internal AI. The retrieval was wrong half the time."

That is the failure mode of vector retrieval without a refusal contract. Conventional RAG systems return *something* even when the top match is weak. WhiteGlove will not. It scores against a configurable confidence threshold and produces silence below that threshold. The result is a lower hit rate and a far higher precision rate — exactly the trade-off legal practice requires.

---

## What you do next

- **Evaluate:** Request a 30-day on-prem evaluation with a curated practice-group archive  
- **Pilot:** One practice group, one quarter, with reporting on refusal rate, citation accuracy, and partner time saved  
- **Procure:** Enterprise tier with integration to NetDocuments, iManage, or SharePoint

**Contact:** [sales@whiteglove.ai](mailto:sales@whiteglove.ai) · [https://whiteglove.ai](https://whiteglove.ai)

---

*WhiteGlove Agent Husk is a retrieval and reference platform. It does not constitute the practice of law and does not replace attorney judgment. It surfaces what your verified corpus already contains, and refuses everything else.*  
