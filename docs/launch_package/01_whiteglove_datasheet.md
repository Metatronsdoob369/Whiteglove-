# WhiteGlove Agent Husk — Technical Datasheet

**Version:** MVP Golden State (`e4e66ff`) **Release Date:** 2026-05-19 **Document Owner:** WhiteGlove Engineering **Classification:** External — Buyer / Procurement

---

## 1\. Product Summary

WhiteGlove Agent Husk is an offline-first, faith-less retrieval platform that returns only artifact-backed, source-cited answers from a curated local corpus. When the corpus contains no qualifying match, the system returns silence — never fabricated content. Every retrieval is bound to a snapshot ID, source hash, and timestamp for downstream audit.

Canonical evidence placeholders:
- Demo: `/docs/demo/90s_proof_demo.md`
- Audit sample: `/docs/artifacts/audit_log_sample_placeholder.md`
- Snapshot manifest example: `/docs/artifacts/snapshot_manifest_example.md`

---

## 2\. Deployment Profiles

| Profile | Use Case | Hardware Floor |
| :---- | :---- | :---- |
| **Edge** | Field clinic, remote office, Pi-class node | 4 GB RAM, 10 GB disk, 2 vCPU |
| **Workstation** | Single-analyst, small firm, dev lab | 16 GB RAM, 50 GB disk, 4 vCPU |
| **Server** | Team / department deployment | 32 GB RAM, 250 GB SSD, 8 vCPU, optional NVIDIA GPU |
| **Air-Gapped** | Classified, regulated, or sovereign | Same as Server, no NIC outbound |

**Supported OS:** Linux (kernel ≥ 5.10), macOS 13+ **Runtime:** Node.js 20 LTS, Python 3.9+ **Distribution:** Docker image (multi-arch: amd64, arm64) or native installer

---

## 3\. Corpus & Ingestion

| Attribute | Value |
| :---- | :---- |
| **Supported formats** | Markdown, plain text, PDF, HTML, CSV (beta), DOCX (beta) |
| **Stable corpus size** | 100,000 documents (\~30 GB embedded index) |
| **Larger deployments** | Available with sizing consultation |
| **Ingestion throughput (CPU)** | 500–2,000 docs/min |
| **Ingestion throughput (GPU)** | Up to 10,000 docs/min |
| **Embedding model** | sentence-transformers compatible; default `all-MiniLM-L6-v2` (384-dim) or `bge-large-en-v1.5` (1024-dim); operator-selectable |
| **License posture** | Default models are Apache 2.0 / MIT; no per-call licensing fees |
| **Custom embedders** | Pluggable adapter interface |

---

## 4\. Retrieval Performance

| Metric | Value |
| :---- | :---- |
| **Cold-start latency** | ≤ 3.2 s (first query after boot) |
| **Warm retrieval latency** | 1.1 s p50, 1.8 s p95 (3,072-dim cosine, Pi-class hardware) |
| **Warm retrieval latency (server-class)** | 180 ms p50, 420 ms p95 |
| **Concurrent queries** | Up to 64 concurrent on Server profile; Edge tuned for 4–8 |
| **Sustained QPS** | 25 QPS sustained on Server profile, 4 QPS on Edge |
| **Recall@10 (BEIR average)** | 0.78 with default embedder |

---

## 5\. Snapshot & Audit Architecture

| Attribute | Value |
| :---- | :---- |
| **Snapshot format** | Canonical Markdown manifest \+ binary index payload |
| **Snapshot size** | \~12% of ingested corpus volume (e.g., 10k docs ≈ 3.6 GB snapshot) |
| **Snapshot contents** | Run ID, source SHA-256 per document, embedder ID, point counts, ingest timestamp, operator identity, code SHA |
| **Snapshot operations** | Freeze, restore, diff, verify, export |
| **Audit log format** | Append-only JSONL, hash-chained |
| **Retention default** | 7 years (configurable) |

---

## 6\. API Surface

### Live in MVP

| Method | Endpoint | Purpose |
| :---- | :---- | :---- |
| `POST` | `/v1/query` | Fact-backed retrieval with provenance |
| `POST` | `/v1/query/explain` | Retrieval with chunk-level reasoning trace |
| `POST` | `/v1/ingest` | Single-document ingest |
| `POST` | `/v1/ingest/batch` | Batch ingest with progress stream |
| `GET` | `/v1/health` | Liveness, corpus stats, embedder ID |
| `POST` | `/v1/admin/snapshot` | Freeze current run |
| `GET` | `/v1/admin/snapshot/{id}` | Retrieve snapshot manifest |
| `POST` | `/v1/admin/snapshot/diff` | Compare two snapshots |
| `GET` | `/v1/admin/audit` | Stream audit log |

### Near-Term Roadmap

`/v1/auth/session`, `/v1/admin/users`, `/v1/corpus/reindex`, `/v1/export/legal-hold`, `/v1/explain/cite-graph`

### Authentication

- **MVP:** API key in `Authorization: Bearer` header, scoped per role (read, ingest, admin)  
- **Roadmap:** mTLS, SSO via OIDC, hardware-token signing for admin operations  
- **Local-only mode:** Loopback-only binding; auth optional for single-operator deployments

### Rate Limiting

- Token bucket per API key. Defaults: 60 query/min, 600 ingest/min, 5 snapshot/hour. Operator-configurable.

---

## 7\. Security Posture

- **No outbound network calls** in default configuration. Optional telemetry strictly opt-in.  
- **Encryption at rest:** AES-256 for index and snapshot stores (operator-managed keys; HashiCorp Vault integration available).  
- **TLS in transit:** TLS 1.3 enforced for all API endpoints when bound to non-loopback interface.  
- **Supply chain:** SBOM published per release; dependencies signed with Sigstore; reproducible builds.  
- **Secrets handling:** No secrets in env vars by default; Vault or OS keychain integration.  
- **CVE response SLA:** 72 h for critical, 7 days for high.

---

## 8\. Disaster Recovery

| Metric | Value |
| :---- | :---- |
| **RPO (Recovery Point Objective)** | 0 — snapshots are durable on creation |
| **RTO (Recovery Time Objective)** | ≤ 5 min for restore from last verified snapshot |
| **Backup procedure** | `whiteglove snapshot freeze` \+ filesystem-level copy to operator-controlled vault |
| **Restore procedure** | `whiteglove snapshot restore <id>`; verifies hashes before activation |
| **Disaster scenarios covered** | Disk failure, host loss, corruption, regulatory roll-back |

---

## 9\. Integration

- **Interfaces:** CLI, REST API, Python SDK, Node.js SDK  
- **Embedding into apps:** Standalone daemon, sidecar container, or library mode  
- **EMR / DMS / CMS bridges:** Adapter pattern; reference adapters for FHIR, NetDocuments, iManage, SharePoint available on request

---

## 10\. Pricing

Contact sales for tailored pricing. **MVP**, **Team**, and **Enterprise** tiers available. Enterprise tier includes Business Associate Agreement (BAA) for HIPAA-covered entities, bespoke compliance attestations, and integration engineering hours.

---

## 11\. Contact

- **Web:** [https://whiteglove.ai](https://whiteglove.ai)  
- **Sales:** [sales@whiteglove.ai](mailto:sales@whiteglove.ai)  
- **Support:** [support@whiteglove.ai](mailto:support@whiteglove.ai)  
- **Security disclosure:** [security@whiteglove.ai](mailto:security@whiteglove.ai) (PGP key on website)
