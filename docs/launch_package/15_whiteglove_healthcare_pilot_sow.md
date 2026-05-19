# WhiteGlove Healthcare Pilot SOW (One-Page)

Document: Statement of Work (Pilot)
Effective Date: [YYYY-MM-DD]
Customer: [Legal Entity Name]
Vendor: WhiteGlove
Term: 30 days from kickoff

## 1. Objective

Deploy and validate WhiteGlove Agent Husk in a controlled healthcare environment to prove:

- source-cited retrieval from customer-approved corpus
- no-answer behavior when no qualifying source exists
- auditable query and snapshot workflow suitable for compliance review

## 2. Fixed Scope

WhiteGlove will provide:

- 1 production-equivalent pilot deployment in Customer-controlled environment
- corpus onboarding up to contracted document cap
- role-based access for up to contracted user cap
- baseline configuration of retrieval thresholds and logging
- weekly check-in (up to 4 total, 45 minutes each)
- final pilot report with agreed success metrics

Scope limits:

- 1 department/service line only
- 1 primary corpus domain only
- 1 non-critical integration max (if included in selected tier)
- no model training/fine-tuning
- no custom feature development

## 3. Customer Responsibilities

Customer will provide:

- infrastructure access and required technical contacts
- approved corpus files and metadata
- security/compliance reviewer for weekly decisions
- named pilot owner with sign-off authority
- required legal approvals (including BAA if applicable)

## 4. Deliverables

- deployment checklist and environment validation
- ingestion summary (document counts, indexing status)
- retrieval validation pack:
    - known-hit query set results
    - no-match query set results
    - citation trace samples
- audit artifact pack:
    - sample logs
    - snapshot/restore demonstration evidence
- final outcomes report and go/no-go recommendation

## 5. Acceptance Criteria

Pilot is accepted when all are met:

- citation accuracy: >= 95% on agreed validation set
- no-hallucination contract: 100% of no-match test queries return no answer
- p50 retrieval latency at or below: [target ms/s] in pilot environment
- audit traceability demonstrated for sampled queries and one snapshot restore event
- customer sign-off on final report within 5 business days of submission

## 6. Timeline

- Week 1: kickoff, environment setup, corpus intake
- Week 2: ingestion complete, initial validation
- Week 3: user validation and tuning within fixed scope
- Week 4: final test run, report, executive readout

## 7. Pricing Tiers (Fixed Fee)

| Tier | Fixed Fee | Document Cap | User Cap | Integration | Support Window |
|---|---:|---:|---:|---|---|
| Starter Pilot | $15,000 | 5,000 | 10 | None | Business hours |
| Standard Pilot | $25,000 | 10,000 | 25 | 1 basic integration | Business hours + priority response |
| Enterprise Pilot | $35,000 | 20,000 | 50 | 1 integration + security workshop | Priority response + exec review |

Travel or on-site work:

- remote-first by default
- on-site, if requested: billed separately at [rate] plus expenses (pre-approved)

## 8. Payment Terms

- 50% due at signing (non-refundable reservation/setup fee)
- 50% due at Day 15 of pilot term
- net 15 payment terms unless otherwise stated in MSA
- overdue balances may pause pilot execution

## 9. Change Control

Any request outside fixed scope requires written change order, including:

- scope delta
- fee impact
- schedule impact
- approval by both parties before execution

## 10. Security & Privacy

- deployment is in Customer-controlled environment
- no outbound telemetry unless explicitly enabled in writing
- PHI handling follows executed BAA terms, if applicable
- both parties follow incident notification obligations in MSA/BAA

## 11. Legal Terms

- this SOW is governed by the parties' MSA (or equivalent agreement)
- if conflict exists, MSA controls unless this SOW explicitly states otherwise
- IP ownership: each party retains pre-existing IP; customer retains customer data
- warranty and liability per MSA
- termination per MSA; fees earned through termination date remain payable

## 12. Signatures

Customer
Name: [ ]
Title: [ ]
Signature: [ ]
Date: [ ]

WhiteGlove
Name: [ ]
Title: [ ]
Signature: [ ]
Date: [ ]
