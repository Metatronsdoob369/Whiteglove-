# WhiteGlove Healthcare Pilot — Appendix A: Success Metrics

Document: Appendix A — Success Metrics
Applies To: Healthcare Pilot SOW + Order Form [Order ID]

## 1) Validation Dataset

- Known-hit query set size: >= 50 queries
- No-match query set size: >= 25 queries
- Dataset approval owner: [Customer Name/Role]
- Dataset freeze date: [YYYY-MM-DD]

## 2) Metric Definitions & Targets

### 1. Citation Accuracy (Known-Hit)

- Definition: Returned answer cites correct source doc/section for the expected fact.
- Target: >= 95% on approved known-hit set.
- Pass Rule: Correct citations / total known-hit queries >= 0.95.

### 2. No-Hallucination Contract (No-Match)

- Definition: For queries with no qualifying corpus support, system returns no answer/refusal.
- Target: 100%.
- Pass Rule: No-answer responses / total no-match queries = 1.00.

### 3. Latency (Pilot Environment)

- Definition: End-to-end retrieval time measured in customer pilot environment.
- Target: p50 <= [X] ms, p95 <= [Y] ms.
- Pass Rule: Both p50 and p95 thresholds met over agreed sample run.

### 4. Audit Trace Completeness

- Definition: Query event, citation/refusal outcome, snapshot linkage, and timestamp available for sampled runs.
- Target: 100% for sampled validation events.
- Pass Rule: All required fields present and verifiable in audit artifacts.

### 5. Snapshot Restore Demonstration

- Definition: Restore a selected snapshot and reproduce expected retrieval behavior on sample queries.
- Target: 1 successful restore demo.
- Pass Rule: Restore completes and sampled outputs match expected references.

## 3) Test Method

- Test window: [start/end dates]
- Environment: [prod-like details]
- Operator: [name/team]
- Tooling/log sources: [paths/endpoints]
- Sampling method: [random/stratified/manual]

## 4) Acceptance Decision

Pilot accepted if all pass criteria above are met and signed by:

- Customer Pilot Owner: [ ]
- Customer Compliance/Security Reviewer: [ ]
- WhiteGlove Delivery Lead: [ ]

## 5) Final Sign-Off

Customer Sign-Off
Name: [ ]
Title: [ ]
Date: [ ]
Signature: [ ]

WhiteGlove Sign-Off
Name: [ ]
Title: [ ]
Date: [ ]
Signature: [ ]
