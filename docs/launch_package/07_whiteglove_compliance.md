# WhiteGlove Agent Husk — Compliance & Regulatory Mapping

**Version:** 1.1 (`e73b7ad`) **Date:** 2026-05-19 **Document Owner:** WhiteGlove Compliance **Audience:** CCO, CISO, Privacy Officer, GC, External Auditor

This document maps WhiteGlove Agent Husk's controls to specific regulatory and standards requirements. It is not a legal opinion. It is a feature-to-control mapping intended to support customer assessment, audit response, and regulator inquiry.

---

## 1\. HIPAA (45 CFR Part 164, Subpart C — Security Rule)

| Citation | Requirement | WhiteGlove Mechanism |
| :---- | :---- | :---- |
| §164.308(a)(1)(ii)(D) | Information System Activity Review | Append-only, hash-chained audit log captures every query, refusal, and admin action. Exportable to SIEM in JSONL. |
| §164.308(a)(3)(ii)(B) | Workforce Clearance / Authorization | Role-scoped API keys (read / ingest / admin). Admin operations require elevated key with optional hardware-token signing. |
| §164.308(a)(4) | Information Access Management | Per-corpus key scoping. Keys are revocable and rotation is operationally trivial. |
| §164.308(a)(5)(ii)(C) | Login Monitoring | All authentication attempts logged with origin IP and key identity. |
| §164.310(d)(2)(iv) | Data Backup and Storage | Snapshot freeze produces a verifiable, restorable manifest. RPO 0, RTO ≤ 5 min. |
| §164.312(a)(1) | Access Control | Token-based auth, role separation, optional mTLS, optional SSO via OIDC. |
| §164.312(a)(2)(iv) | Encryption and Decryption | AES-256-GCM at rest, operator-managed keys, HashiCorp Vault integration. |
| §164.312(b) | Audit Controls | Hash-chained audit log; tampering breaks chain and is detected on verification sweep. |
| §164.312(c)(1) | Integrity | Source-hash verification on every retrieval; snapshot signatures verified on load. |
| §164.312(e)(1) | Transmission Security | TLS 1.3 enforced on non-loopback bindings; no outbound traffic in default configuration. |
| §164.402 (Breach Notification) | Definition / Disclosure | Default architecture produces zero outbound PHI flow; the cloud-vendor disclosure vector that drives most breach notifications is structurally absent. |

**Business Associate Agreement:** Enterprise tier includes a BAA signed by WhiteGlove for covered-entity customers. The BAA covers support engagements only; the runtime processes PHI entirely within the customer's environment.

---

## 2\. SEC Rule 17a-4 — Electronic Records Retention

| Citation | Requirement | WhiteGlove Mechanism |
| :---- | :---- | :---- |
| 17 CFR §240.17a-4(b) | Six-year preservation of specified records | Audit log retention configurable; default 7 years exceeds requirement. |
| §240.17a-4(f)(2)(ii)(A) | Non-erasable, non-rewriteable storage (WORM) | Audit log is append-only and hash-chained. Operator may layer WORM-capable storage (compliant object storage, immutable block devices) for full attestation. |
| §240.17a-4(f)(2)(ii)(B) | Automatic verification of quality and accuracy | Scheduled verifier sweep recomputes hashes and reports drift. |
| §240.17a-4(f)(2)(ii)(C) | Serialization, time-date stamp | Every record carries monotonic sequence number and ISO-8601 UTC timestamp. |
| §240.17a-4(f)(2)(ii)(D) | Indexing and retrieval | Audit log is queryable by time range, operator, key identity, query content, and outcome. |
| §240.17a-4(f)(3)(v) | Audit system maintaining record-keeping | Hash-chain integrity report exportable on demand. |

**Note:** The November 2022 amendment to 17a-4 added an audit-trail alternative to WORM. WhiteGlove's hash-chained audit log was designed to support either path; operator selects which compliance posture to maintain based on examiner guidance.

---

## 3\. FINRA Rule 4511 — General Recordkeeping Requirements

| Citation | Requirement | WhiteGlove Mechanism |
| :---- | :---- | :---- |
| FINRA 4511(a) | Books and records as required by FINRA rules and SEA | All retrieval activity, administrative actions, and corpus state transitions are captured in the audit log. |
| FINRA 4511(b) | Preservation period per SEA 17a-4 | Retention defaults configured to align with 17a-4 windows; per-record-type retention configurable. |
| FINRA 4511(c) | Format and media in accordance with SEA 17a-4 | Snapshot and audit formats meet the indexing, time-stamping, and integrity criteria above. |

---

## 4\. SOC 2 — Trust Services Criteria

WhiteGlove ships customer-evidence packages for use during the customer's SOC 2 audit. The mapping below identifies which WhiteGlove controls support which TSC categories.

| TSC | Criterion | WhiteGlove Evidence |
| :---- | :---- | :---- |
| CC1 | Control Environment | Security policies, secure-SDLC documentation, signed release attestation |
| CC2 | Communication and Information | Security advisories channel, CVE response SLA, customer notification process |
| CC5 | Control Activities | Role-scoped keys, change management, signed releases |
| CC6 | Logical and Physical Access | Auth controls, encryption inventory, operator key custody guidance |
| CC7 | System Operations | Health endpoint, monitoring exports, incident response runbook |
| CC7.2 | Monitoring of System Components | Hash-chain integrity reports, scheduled verifier sweep |
| CC8 | Change Management | Reproducible builds, SBOM, signed artifacts |
| A1 | Availability | DR documentation, snapshot/restore procedures, RPO/RTO commitments |
| C1 | Confidentiality | At-rest and in-transit encryption inventory, no-outbound-traffic posture |
| P1–P8 | Privacy | PHI/PII never leaves perimeter; no telemetry; data subject inquiry support via audit log |

**Customer SOC 2 audits:** WhiteGlove provides architecture diagrams, control narratives, and customer-evidence templates on request to support the customer's auditor.

---

## 5\. GDPR (Regulation (EU) 2016/679)

| Citation | Requirement | WhiteGlove Mechanism |
| :---- | :---- | :---- |
| Art. 5(1)(f) | Integrity and confidentiality | Encryption inventory above; hash-chained audit; signed snapshots. |
| Art. 25 | Data protection by design and by default | No-outbound-traffic default; faith-less contract minimizes processing of personal data beyond what the operator has explicitly ingested. |
| Art. 30 | Records of processing activities | Audit log provides per-query processing records exportable in machine-readable form. |
| Art. 32 | Security of processing | AES-256, TLS 1.3, role-based access, signed releases, vulnerability management program. |
| Art. 33 / 34 | Breach notification | Default architecture eliminates the third-party-processor breach vector. Customer remains controller and notifier for any incident within their perimeter. |
| Art. 15–22 | Data subject rights | Audit log supports access-request fulfillment and erasure verification. Erasure of corpus entries propagates to snapshots via re-ingest and re-snapshot. |

**Data processor status:** In default on-premise deployments, WhiteGlove is not a processor. The customer is the controller and the operator. WhiteGlove acts as processor only for paid support engagements that involve customer data — covered under a Data Processing Agreement available with Enterprise tier.

**Cross-border transfer:** Default deployments perform no cross-border transfer. The vendor in the data path that GDPR transfer rules contemplate is absent by design.

---

## 6\. ABA Model Rules of Professional Conduct (legal vertical)

| Rule | Requirement | WhiteGlove Mechanism |
| :---- | :---- | :---- |
| Rule 1.1, Comment 8 | Technological competence | Documented architecture, training materials, and operator runbook. |
| Rule 1.6(c) | Reasonable efforts to prevent unauthorized disclosure | No outbound traffic; encryption inventory; role-scoped access; audit. |
| Rule 1.15 | Safekeeping of property (including electronic records) | Snapshot retention, integrity verification, restore procedure. |
| Rule 5.1 / 5.3 | Supervision of lawyers / nonlawyers | Per-operator audit identity; admin actions require elevated key. |
| Rule 8.4(c) | Conduct involving dishonesty, fraud, deceit | Faith-less retrieval contract prevents the AI-fabricated-citation failure mode that has triggered sanctions in recent reported cases. |

**State-bar variations:** Several state bars have issued ethics opinions on generative-AI tool use (California Practical Guidance 2023, NY State Bar Opinion 2024-5, Florida Advisory Opinion 24-1). WhiteGlove's posture — local processing, no cloud disclosure, no fabrication — aligns with the conservative reading of those opinions.

---

## 7\. NIST Cybersecurity Framework 2.0 (cross-cutting)

| Function | WhiteGlove Mapping |
| :---- | :---- |
| GOVERN | Documented security policies, named security contact, advisories channel |
| IDENTIFY | SBOM per release, asset inventory in snapshot manifests |
| PROTECT | Encryption, access control, no-outbound posture, signed releases |
| DETECT | Audit log integrity verification, anomaly-friendly query log format |
| RESPOND | CVE response SLA, security disclosure process, incident runbook |
| RECOVER | Snapshot/restore RPO 0 / RTO ≤ 5 min, DR documentation |

---

## 8\. CCPA / CPRA (California Civil Code §1798.100 et seq.)

| Requirement | WhiteGlove Mechanism |
| :---- | :---- |
| §1798.100(a) — Notice at collection | Operator-controlled; WhiteGlove does not collect from data subjects. |
| §1798.105 — Right to delete | Operator removes from corpus and re-snapshots; audit captures the action. |
| §1798.110 — Right to know | Audit log supports per-subject processing inventory. |
| §1798.150 — Statutory damages from unauthorized exfiltration | No outbound traffic; structural elimination of vendor-disclosure vector. |

---

## 9\. What This Document Is, and Is Not

This is a mapping document for use by customer compliance teams, internal audit, and procurement security review. It is not legal advice. It does not constitute a certification, attestation, or warranty. Specific compliance posture in any deployment depends on operator configuration, the corpus content, and the broader control environment in which WhiteGlove runs.

WhiteGlove engineering and security publish updates to this mapping with each material release. The canonical version lives in the documentation repository under a semantic-version tag; prior versions are preserved.

---

## 10\. Contact

- **Compliance inquiries:** [compliance@whiteglove.ai](mailto:compliance@whiteglove.ai)  
- **Security disclosure:** [security@whiteglove.ai](mailto:security@whiteglove.ai)  
- **Customer audit support:** [support@whiteglove.ai](mailto:support@whiteglove.ai)
