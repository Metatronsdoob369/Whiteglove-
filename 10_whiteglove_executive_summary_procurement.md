# WhiteGlove Agent Husk — Procurement Executive Summary

**Purpose:** Evaluate WhiteGlove for controlled deployment in regulated environments requiring verifiable retrieval and auditable operations.

## What Is Being Procured

WhiteGlove Agent Husk is an offline-first retrieval platform that returns only source-backed answers from a local corpus. If no qualifying source exists, it refuses to answer.

## Core Control Characteristics

- No outbound traffic in default deployment mode
- AES-256 at rest; TLS 1.3 in transit
- Role-scoped API access (read/ingest/admin)
- Append-only, hash-chained audit logging
- Snapshot freeze/restore/diff/verify with provenance metadata

## Performance and Capacity (MVP Baseline)

- Warm retrieval latency: 1.1s p50 (Pi-class), 180ms p50 (server-class)
- Stable corpus target: 100,000 documents (~30 GB embedded index)
- Sustained throughput profile: up to 25 QPS server-class

## Compliance Fit (Control Mapping Available)

WhiteGlove package includes documented mappings for:

- HIPAA Security Rule
- SEC 17a-4 and FINRA 4511
- SOC 2 Trust Services Criteria
- GDPR Articles 5/25/30/32/33-34
- ABA legal-practice guidance
- NIST CSF 2.0 and CCPA alignment

## Procurement Decision Criteria

Approve if the following are satisfied during pilot:

1. Refusal behavior verified on no-match queries
2. Citation accuracy verified on known-hit queries
3. Snapshot restoration validates historical reproducibility
4. Audit exports meet internal review and examiner expectations

## Recommended Acquisition Path

- 30-day controlled pilot (single corpus/domain)
- Security + compliance review package exchange
- Production rollout with enterprise support and policy controls

**Contact:** sales@whiteglove.ai
