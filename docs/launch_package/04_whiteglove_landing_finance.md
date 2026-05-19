# WhiteGlove for Finance

## Your research. Your alpha. Your audit trail. On your hardware.
**Repo SHA:** `e73b7ad` **Last updated:** 2026-05-19

Hedge funds, trading desks, crypto operations, and compliance teams need AI retrieval that will not exfiltrate proprietary research and will not fabricate citations to phantom regulations. WhiteGlove Agent Husk runs entirely on-premise, returns only artifact-backed answers, and produces a snapshot manifest defensible under SEC and FINRA records-retention rules.

**[Watch the 90-second proof demo ▶](/docs/demo/90s_proof_demo.md)**

---

## Built for the firms whose research is the product

- **Hedge funds and prop trading desks** — proprietary research archives, risk methodology, mandate constraints, trade playbooks  
- **Compliance and surveillance** — regulatory rulebooks, policy archives, KYC procedures, surveillance escalation paths  
- **Crypto operations and DeFi** — protocol documentation, governance histories, smart contract specs, custody procedures  
- **Wealth management** — internal advisory frameworks, suitability standards, product disclosure language

---

## The proof artifact

Every WhiteGlove retrieval produces:

- File-and-section citation from your curated archive  
- Snapshot ID and timestamp anchoring the corpus state at the moment of query  
- Hash-chained audit entry meeting SEC 17a-4(f) electronic-records criteria for non-erasable, non-rewriteable retention  
- Refusal record when no qualifying source exists — the silence is itself the auditable event
- Audit evidence placeholder: `/docs/artifacts/audit_log_sample_placeholder.md`
- Snapshot evidence placeholder: `/docs/artifacts/snapshot_manifest_example.md`

You can prove, three years later in an SEC examination, exactly what your research desk had access to on the morning of a trade.

---

## What it costs to not have this

| Scenario | Cloud AI exposure | WhiteGlove posture |
| :---- | :---- | :---- |
| Analyst queries proprietary research via ChatGPT | Research excerpts logged to vendor; alpha leaks | Zero outbound traffic. Research never leaves the desk. |
| AI invents a regulatory citation in a compliance memo | Misadvice; FINRA exposure | Refusal or fully-cited answer. No phantom rules. |
| Examiner asks "what playbook governed this trade on June 4?" | No reconstructable answer | Restore the snapshot. Hand over the manifest. |
| Quant chat assistant trained on team research is breached | Mass alpha disclosure | No model is exposed. No external attack surface. |

---

## The three objections we hear most

### "We have ChatGPT Enterprise. Why do we need this?"

Enterprise cloud LLMs are governed by the vendor's data policy, not yours. Every query traverses their infrastructure, their employees, their incident response. They retain the right to update model behavior and fine-tune on aggregated patterns. For a firm whose research is the product, that is an unaccountable counterparty in your data path. WhiteGlove eliminates the counterparty. The model file sits on your disk, the index sits on your disk, the audit log sits on your disk.

### "SEC 17a-4 is the wall. How is this actually defensible?"

WhiteGlove's audit log is append-only and hash-chained. Snapshots are written once and verified on every read. The retention window is operator-controlled and defaults to seven years. Combined with WORM-capable storage at the operator's discretion, the configuration satisfies the non-erasable / non-rewriteable requirement under SEC 17a-4(f)(2). See our Compliance document for full control mapping.

### "Will this slow my analysts down?"

Warm retrieval is 180 ms on a server-class deployment. The analyst types a question and gets a cited answer faster than opening a research portal and searching manually. The friction comes from the refusal — and that friction is the point. An analyst who has to look elsewhere for an unknown is an analyst who is not building a thesis on fiction.

---

## What you do next

- **Evaluate:** Request a 30-day on-prem evaluation with a sandboxed slice of your research archive  
- **Pilot:** One desk, one quarter, with reporting on refusal rate, retrieval latency, and citation accuracy  
- **Procure:** Enterprise tier with integration to your CRM, OMS, or research portal of choice

**Contact:** [sales@whiteglove.ai](mailto:sales@whiteglove.ai) · [https://whiteglove.ai](https://whiteglove.ai)

---

*WhiteGlove Agent Husk is a retrieval and reference platform. It does not execute trades, place orders, move money, or provide investment advice. It surfaces what your verified corpus already contains, and refuses everything else.*  
