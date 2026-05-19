# WhiteGlove Healthcare Pilot — Appendix A: Success Metrics (Redline-Friendly)

Document: Appendix A — Success Metrics  
Applies To: Healthcare Pilot SOW + Order Form [Order ID]

This appendix includes optional metric bands to speed legal/procurement negotiation without changing the KPI framework.

## 1) Validation Dataset

- Known-hit query set size: >= 50 queries
- No-match query set size: >= 25 queries
- Dataset approval owner: [Customer Name/Role]
- Dataset freeze date: [YYYY-MM-DD]

Optional dataset alternative (select one):

- Option A (default): 50/25 known-hit/no-match split
- Option B: 75/25 split for larger pilots

## 2) Metric Definitions & Targets

### 1. Citation Accuracy (Known-Hit)

- Definition: Returned answer cites correct source doc/section for the expected fact.
- Base target: >= 95% on approved known-hit set.

Optional target band (select one):

- Option A (default): >= 95%
- Option B: >= 92% for compressed pilot timelines
- Option C: >= 97% for expanded validation windows

### 2. No-Hallucination Contract (No-Match)

- Definition: For queries with no qualifying corpus support, system returns no answer/refusal.
- Target: 100%.
- Pass Rule: No-answer responses / total no-match queries = 1.00.

### 3. Latency (Pilot Environment)

- Definition: End-to-end retrieval time measured in customer pilot environment.
- Base target: p50 <= [X] ms, p95 <= [Y] ms.

Optional latency target bands (select one):

- Option A: p50 <= 1200 ms, p95 <= 2200 ms
- Option B: p50 <= 900 ms, p95 <= 1800 ms
- Option C: environment-dependent values agreed at kickoff and frozen in Week 1 report

### 4. Audit Trace Completeness

- Definition: Query event, citation/refusal outcome, snapshot linkage, and timestamp available for sampled runs.
- Target: 100% for sampled validation events.

### 5. Snapshot Restore Demonstration

- Definition: Restore a selected snapshot and reproduce expected retrieval behavior on sample queries.
- Target: 1 successful restore demo.

Optional restore alternative (select one):

- Option A (default): 1 successful restore demo
- Option B: 2 successful restore demos across separate dates

## 3) Test Method

- Test window: [start/end dates]
- Environment: [prod-like details]
- Operator: [name/team]
- Tooling/log sources: [paths/endpoints]
- Sampling method: [random/stratified/manual]

Optional test method clause (select one):

- Option A (default): Single consolidated validation run in Week 4
- Option B: Rolling validation across Weeks 2-4 with weekly scorecards

## 4) Acceptance Decision

Pilot accepted if all selected pass criteria above are met and signed by:

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
