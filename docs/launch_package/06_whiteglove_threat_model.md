# WhiteGlove Agent Husk — Threat Model & Security Posture

**Version:** 1.1 (`e73b7ad`) **Date:** 2026-05-19 **Document Owner:** WhiteGlove Security **Audience:** CISO, security architect, procurement security review, regulatory examiner

This document enumerates the threats WhiteGlove Agent Husk is designed to defend against, the mitigation built into the architecture, and the residual risks that remain the operator's responsibility.

---

## 1\. System Trust Boundary

  ┌─────────────────────────────────────────────────────────┐

  │                  Operator Perimeter                      │

  │                                                          │

  │   ┌──────────┐    ┌──────────┐    ┌──────────────┐      │

  │   │  Client  │───▶│ WhiteGlove│───▶│  Index Store │      │

  │   │ (CLI/API)│    │  Daemon   │    │  (encrypted) │      │

  │   └──────────┘    └────┬──────┘    └──────────────┘      │

  │                        │                                  │

  │                        ▼                                  │

  │                  ┌──────────────┐                         │

  │                  │ Snapshot Vault│                        │

  │                  │ \+ Audit Log   │                        │

  │                  └──────────────┘                         │

  │                                                          │

  └─────────────────────────────────────────────────────────┘

                              ╳

                       No outbound traffic

                       in default configuration

Trust ends at the operator perimeter. The corpus, the index, the snapshots, the audit log, and the embedding model all sit inside that perimeter. The architecture is designed so that no component of the system requires a network egress to function.

---

## 2\. STRIDE Mapping

| Category | Considered? | Notes |
| :---- | :---: | :---- |
| **S**poofing | Yes | API key auth, mTLS roadmap, OS-level access controls |
| **T**ampering | Yes | Hash-chained audit log, signed snapshots, source-hash verification |
| **R**epudiation | Yes | Append-only audit, operator identity captured per action |
| **I**nformation disclosure | Yes | AES-256 at rest, TLS 1.3 in transit, no outbound traffic |
| **D**enial of Service | Yes | Rate limiting, resource caps, snapshot isolation |
| **E**levation of Privilege | Yes | Scoped API keys, role separation (read / ingest / admin) |

---

## 3\. Threat Vectors, Mitigations, Residual Risk

### 3.1 Prompt Injection via Ingested Documents

| Field | Value |
| :---- | :---- |
| **Vector** | Adversarial content embedded in a source document instructs the system to ignore retrieval policy, leak corpus contents, or fabricate a response |
| **Realism** | High in legal discovery corpora and external regulatory feeds; lower in internally-authored archives |
| **Mitigation** | Faith-less contract by design: the daemon does not act on instructions found in retrieved content. Retrieval is a similarity operation, not an instruction execution. No tool-use path is wired to corpus content. All output is bounded by the source-hash citation requirement. Pre-ingestion content scanners flag suspicious instruction-like patterns for operator review. |
| **Residual risk** | An adversary can still embed *misleading factual content* in a document and have it surfaced as authoritative. This is a corpus-curation problem, not a retrieval problem. Operator owns source vetting. |

### 3.2 Embedding Model Poisoning

| Field | Value |
| :---- | :---- |
| **Vector** | A malicious or backdoored embedding model produces biased similarity scores, causing the daemon to surface attacker-controlled content or suppress legitimate content |
| **Realism** | Moderate; rises with use of niche or community-fine-tuned models |
| **Mitigation** | Embedder identity is recorded in every snapshot. Operators can pin a specific model SHA. Reference embedders shipped with WhiteGlove are pulled from signed sources and verified at install. Snapshot diff exposes silent embedder swaps. |
| **Residual risk** | If the operator deliberately installs an untrusted model, the system trusts that model. Pin a known-good model and resist ad-hoc swaps. |

### 3.3 Snapshot Tampering

| Field | Value |
| :---- | :---- |
| **Vector** | Attacker with filesystem access modifies a snapshot manifest or its underlying index to alter what the system "remembers" |
| **Realism** | Low without privileged access; high if filesystem ACLs are misconfigured |
| **Mitigation** | Snapshot manifest is hash-signed. Index files carry their own per-file SHA-256. On every restore and on a scheduled verifier sweep, the daemon recomputes and compares. Mismatch triggers a refusal-to-load and an audit event. Optional WORM storage backend supported. |
| **Residual risk** | An attacker who controls the signing key and the filesystem can produce a consistent forgery. Protect signing keys in HSM or Vault; rotate on personnel changes. |

### 3.4 Crafted Query Exfiltration

| Field | Value |
| :---- | :---- |
| **Vector** | Adversary issues queries shaped to extract sensitive corpus content one chunk at a time (e.g., "complete the sentence: SSN of patient ...") |
| **Realism** | Moderate against multi-tenant deployments; low in single-operator |
| **Mitigation** | Retrieval returns only chunks above a configured similarity threshold. No generative completion is performed; the system is retrieval-only and quotes source verbatim only up to a configurable chunk length. Rate limiting per API key. Query logs are first-class audit events; abnormal patterns surface in the audit stream. Role-scoped API keys restrict which corpora a key may query. |
| **Residual risk** | A determined attacker with valid read access can still enumerate a corpus over time. Scope keys narrowly, audit queries actively, and rotate on suspicion. |

### 3.5 Denial of Service

| Field | Value |
| :---- | :---- |
| **Vector** | Flood of expensive queries or ingestion requests exhausts CPU, memory, or disk |
| **Realism** | Moderate; trivially possible from any authenticated client |
| **Mitigation** | Per-key token-bucket rate limiting on query, ingest, and snapshot endpoints. Configurable concurrency cap. Disk quotas on the snapshot vault. Slow-query timeouts. Health endpoint exposes saturation telemetry to external monitoring. |
| **Residual risk** | A coordinated DoS from inside the perimeter can still impact availability. Pair WhiteGlove with conventional network controls; segment by trust zone. |

### 3.6 Supply Chain Compromise

| Field | Value |
| :---- | :---- |
| **Vector** | Malicious dependency or build artifact ships in a WhiteGlove release |
| **Realism** | Low but non-zero; industry-wide concern |
| **Mitigation** | SBOM published per release in CycloneDX format. Release artifacts signed with Sigstore / cosign. Reproducible builds with public build attestation. Pinned dependency manifests; renovate workflow with manual review gate. Vulnerability scans on every release; CVE response SLA of 72 hours for critical. |
| **Residual risk** | A compromise at the upstream of a pinned dependency could ship to a release before detection. Subscribe to our security advisory channel and apply patch releases promptly. |

### 3.7 Insider Threat

| Field | Value |
| :---- | :---- |
| **Vector** | Authorized operator or administrator copies the corpus, exfiltrates a snapshot, or tampers with audit records |
| **Realism** | Moderate; classic data-handling concern |
| **Mitigation** | Role separation (read / ingest / admin) enforced at the API surface. Admin actions require elevated key with optional hardware-token signing. Audit log is append-only and hash-chained; tampering breaks the chain and surfaces on verification. Optional remote audit shipping to a SIEM the admin cannot rewrite. |
| **Residual risk** | An admin with full filesystem access and signing-key custody can compromise the system. Apply least privilege; separate signing custody from operations custody. |

### 3.8 Physical Access

| Field | Value |
| :---- | :---- |
| **Vector** | Attacker obtains physical access to the host running WhiteGlove (theft, unsecured server room, lost laptop) |
| **Realism** | Variable by deployment profile; high for Edge / Workstation, low for Server in a colo |
| **Mitigation** | AES-256 encryption at rest with operator-managed keys. Optional TPM-backed key sealing. Snapshot vault can be configured on removable encrypted media. Daemon refuses to start without unsealed key material. |
| **Residual risk** | Physical access defenses are the operator's responsibility — locked racks, full-disk encryption on portable nodes, BIOS/firmware controls. WhiteGlove protects the data at rest; the chassis is your problem. |

### 3.9 Side-Channel and Inference Attacks

| Field | Value |
| :---- | :---- |
| **Vector** | Attacker observes query timing, cache behavior, or memory residency to infer corpus contents without authorized retrieval |
| **Realism** | Low; primarily a multi-tenant concern |
| **Mitigation** | Single-tenant by default. Optional constant-time response padding mode. Memory-locked sensitive buffers; explicit zeroization on shutdown. |
| **Residual risk** | Sophisticated side-channel attacks against shared hardware are out of scope. For maximum-sensitivity deployments, run on dedicated hardware. |

### 3.10 Model Inversion / Training Data Leakage

| Field | Value |
| :---- | :---- |
| **Vector** | An attacker probes the embedding model to reconstruct training data |
| **Realism** | Low; WhiteGlove does not host or train on customer data |
| **Mitigation** | The embedding model is a fixed reference model. It is not fine-tuned on the corpus. There is no training pipeline exposed. The vector index stores embeddings, not source text, and the source text is encrypted at rest. |
| **Residual risk** | If an operator chooses to fine-tune a custom embedder on sensitive data, model inversion against that fine-tune is the operator's exposure. Default deployments do not face this vector. |

---

## 4\. Cryptographic Inventory

| Use | Algorithm | Notes |
| :---- | :---- | :---- |
| At-rest encryption | AES-256-GCM | Operator-managed key, Vault integration available |
| Transport | TLS 1.3 | Modern cipher suites only |
| Hash chains, audit | SHA-256 | Each entry binds prior entry hash |
| Snapshot signing | Ed25519 (default) or RSA-4096 | Operator chooses |
| Password / key derivation | Argon2id | If passphrase-derived keys are used |

No deprecated primitives are present. No MD5, SHA-1, RC4, or 3DES is reachable.

---

## 5\. Out of Scope

The following are explicitly not addressed by WhiteGlove and remain the operator's responsibility:

- Network perimeter controls (firewalls, segmentation, IDS/IPS)  
- Endpoint hardening (EDR, host firewall, OS patching)  
- Physical security of hosts  
- Identity provider and SSO security  
- Backup of operator key material  
- Personnel vetting and access provisioning processes  
- Curation and authenticity of the source corpus

---

## 6\. Security Disclosure

Report vulnerabilities to [**security@whiteglove.ai**](mailto:security@whiteglove.ai). PGP key published on the website. Acknowledgment within 48 hours; coordinated disclosure window of 90 days standard. We credit reporters in release notes unless anonymity is requested.

---

## 7\. Versioning of This Document

This threat model is reviewed quarterly and on every major release. Past versions are preserved in the documentation repository under semantic-version tags. Material changes require sign-off from the WhiteGlove security lead and are noted in the document history section of the canonical copy.  
