# WhiteGlove for Healthcare

## The AI that refuses to guess about your patients.
**Repo SHA:** `e4e66ff` **Last updated:** 2026-05-19

Clinical AI tools that hallucinate are not tools — they are liabilities. WhiteGlove Agent Husk returns only fully-cited, source-bound answers from your curated medical corpus. When the corpus does not contain a qualifying answer, it stays silent. No fabricated dosages. No invented contraindications. No invented citations.

**[Watch the 90-second proof demo ▶](/docs/demo/90s_proof_demo.md)**

---

## Built for the clinical reality you actually work in

- **Oral surgery and dental specialty practices** — post-op protocols, medication interactions, sterilization standards, OSHA documentation  
- **Hospital service lines** — order sets, formulary lookups, internal clinical pathways, residency reference materials  
- **Field medicine** — disaster response, naval medical, remote clinics, mission deployments where the internet is not available and the answer must be right  
- **Long-term care and ambulatory** — medication reconciliation references, infection-control protocols, surveyor-ready policy archives

---

## The proof artifact

Every WhiteGlove response carries:

- The exact source document and section the claim came from  
- A snapshot ID anchoring the corpus state at the moment of the query  
- A timestamp, an operator identity, and a hash-chained audit entry  
- A refusal record when the corpus did not qualify — silence is logged, not hidden
- Audit evidence placeholder: `/docs/artifacts/audit_log_sample_placeholder.md`
- Snapshot evidence placeholder: `/docs/artifacts/snapshot_manifest_example.md`

You can hand a regulator, a defense attorney, or a surveyor a snapshot file and reconstruct exactly what your clinical knowledge base contained on any date in the past seven years.

---

## What it costs to not have this

| Scenario | Conventional AI exposure | WhiteGlove posture |
| :---- | :---- | :---- |
| AI fabricates a drug interaction warning that does not exist | Clinical decision based on fiction; malpractice exposure | Refusal: "No qualifying source." Clinician knows to look elsewhere. |
| AI cites a journal article that does not exist | Documentation references a phantom source | All citations are file-and-section accurate or the answer is withheld |
| Cloud AI logs PHI to a vendor pipeline | Notifiable breach under HIPAA §164.402 | No outbound traffic. PHI never leaves the perimeter. |
| Surveyor asks "what protocol was in effect on March 12 last year?" | No defensible answer | Restore that snapshot. Hand over the manifest. |

---

## The three objections we hear most

### "We already use a clinical AI assistant. Why switch?"

Most clinical AI assistants are wrappers over cloud LLMs. They send your queries — and sometimes excerpts of patient context — to a third-party model provider. They generate. They paraphrase. They occasionally invent. WhiteGlove does none of that. It is not a competitor to your clinical reasoning, it is a verified reference layer that cannot exceed your corpus. You keep your existing tools; you add a layer that will not lie.

### "HIPAA is hard. How is this actually compliant?"

WhiteGlove runs entirely on infrastructure you control. PHI never leaves your network. AES-256 at rest, TLS 1.3 in transit, hash-chained audit logs that meet the technical safeguards under 45 CFR §164.312(a)–(e). Enterprise tier includes a signed Business Associate Agreement. For full control mapping, see our Compliance document.

### "Our IT team is two people. Will this break us?"

Edge profile runs on a $400 mini-PC. Server profile is one Docker image. There is no cloud console to configure, no SaaS subscription to renew, no vendor SSO integration to argue with. Snapshot, restore, and audit are single commands. We provide onboarding support and the full operational runbook.

---

## What you do next

- **Evaluate:** Request a 30-day on-prem evaluation with a curated subset of your clinical protocols  
- **Pilot:** One service line, one quarter, with full reporting on refusal rate and citation accuracy  
- **Procure:** Enterprise tier with BAA and integration engineering hours

**Contact:** [sales@whiteglove.ai](mailto:sales@whiteglove.ai) · [https://whiteglove.ai](https://whiteglove.ai)

---

*WhiteGlove Agent Husk is a retrieval and reference platform. It does not diagnose, prescribe, or replace clinical judgment. It surfaces what your verified corpus already contains, and refuses everything else.*  
