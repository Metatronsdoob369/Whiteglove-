# x402 Mount Kernel — Failure, Recovery, and Verification Design

**Date:** 2026-08-04

**Status:** Design approved; written specification awaiting final review.

**Depends on:** [Modular x402 Mount Kernel — Approved Architecture](2026-08-03-x402-mount-kernel-design.md)

## Scope

This specification defines failure ownership, durable lifecycle transitions, retry entitlement, restart reconciliation, and verification evidence for the Phase-1 x402 mount kernel.

It does not select a production wallet, custody model, mainnet facilitator, refund policy, or compliance posture. Base mainnet remains startup-blocked. It also does not admit state-changing or non-replay-safe capabilities.

## Official lifecycle

The kernel preserves the official x402 v2 order:

1. verify the payment;
2. execute the protected handler;
3. settle only after successful execution;
4. deliver only after successful settlement has been durably recorded.

When a handler throws or returns an error, the official server lifecycle dispatches `onVerifiedPaymentCanceled`; it does not settle. The MCP wrapper exposes matching `onBeforeExecution`, `onAfterExecution`, and `onAfterSettlement` hooks, so HTTP and MCP drive the same ledger state machine.

Primary references:

- [Official x402 lifecycle hooks](https://docs.x402.org/advanced-concepts/lifecycle-hooks)
- [Official x402 payment-identifier specification](https://docs.x402.org/extensions/payment-identifier)
- [Official x402 TypeScript server examples](https://github.com/coinbase/x402/tree/main/examples/typescript/servers)

## Selected recovery architecture

Use official HTTP and MCP payment wrappers with durable ledger hooks and a shared mount orchestrator.

| Approach | Decision |
| --- | --- |
| Official middleware plus durable ledger hooks | Selected. Official code owns challenge, verification, cancellation, and settlement; the kernel owns binding, leases, result persistence, quarantine, replay, and audit. |
| Manual flow using `@x402/core` | Rejected for Phase 1. It would recreate middleware responsibilities without a demonstrated protocol gap. |
| Middleware plus in-memory cache | Rejected. Restart would lose receipts, results, leases, and retry entitlements. |

## Phase-1 adapter admission

Every mounted adapter must declare and satisfy both:

- `effect: "read_only"`;
- `replaySafe: true`.

SupplyLens qualifies because it performs read-only npm retrieval and normalization. The kernel rejects startup if any Phase-1 manifest declares a state-changing or non-replay-safe adapter.

Future support for other effects requires a separate authorization, governance, and compensation design. Payment alone can never authorize state-changing or irreversible work.

## Request and payment binding

The server computes a canonical request fingerprint from all of:

- `operationId`;
- adapter version;
- canonical argument digest;
- payment scheme;
- CAIP-2 network;
- asset;
- amount;
- recipient;
- payment expiry;
- payment nonce;
- payer, when available.

Canonicalization and hashing are versioned. The fingerprint version is persisted with each call so a future canonicalization change cannot reinterpret an existing payment.

Three identities remain separate:

| Identity | Purpose |
| --- | --- |
| `paymentId` | Client identity for one logical paid request across retries. |
| Request fingerprint | Immutable binding between that logical request, capability version, arguments, and payment authorization. |
| `callId` | Server correlation identity for lifecycle, leases, audit, and recovery. |

The first accepted use of a `paymentId` binds it to exactly one fingerprint. Reuse with a different fingerprint returns `409 Conflict` and cannot execute, settle, or receive cached output.

## Durable state machine

States are monotonic except for an explicitly recorded recovery transition. Every transition is committed with its timestamp, actor, reason, and correlation identifiers.

| State | Meaning and permitted next action |
| --- | --- |
| `challenged` | No usable payment was presented. Return manifest-generated x402 v2 requirements. |
| `payment_present` | A payment payload and required `paymentId` exist; validate full fingerprint binding and payment terms. |
| `verified` | Official verification succeeded. Atomically acquire the execution lease. |
| `executing` | The adapter is running. Concurrent callers cannot acquire a second lease. |
| `execution_unknown` | The process died while executing. Phase-1 replay-safe adapters may be invoked again under a new lease; the recovery event is audited. |
| `executed` | The complete protected result is durably stored. It is still locked and cannot be delivered. |
| `settling` | The official wrapper has begun settlement. No further execution is permitted. |
| `settlement_unknown` | Settlement lost a definitive outcome or the process restarted from `settling`. The call is quarantined. |
| `settled` | A successful settlement receipt tied to the fingerprint is durably recorded. Retry entitlement becomes active. |
| `delivered` | The stored result and matching receipt were returned to the caller. |
| `execution_failed` | Adapter failure or deadline. Official cancellation is recorded and no settlement is allowed. |
| `settlement_rejected` | Definitive settlement rejection. Output remains locked. |

Terminal payment validation failures are recorded with structured reason codes without preserving signatures or secrets in logs.

## Persistence and concurrency invariants

- SQLite is opened in WAL mode and remains limited to one application instance.
- A unique constraint binds `paymentId` to one fingerprint.
- Only one non-expired execution lease can exist for a call.
- The protected result is committed before transition to `settling`.
- A successful settlement receipt is committed before transition to `settled`.
- Delivery requires both the stored result and the persisted successful receipt for the same fingerprint.
- A result in `executed`, `settling`, or `settlement_unknown` cannot activate payment bypass.
- Concurrent matching retries produce at most one active execution and one settlement attempt.
- The canonical request envelope and protected result remain in the private ledger under manifest retention rules; logs and metrics contain only identifiers, digests, classifications, and redacted error data.

## Retry entitlement

Retry entitlement activates only in `settled` or `delivered`. A matching `paymentId` and fingerprint returns the stored result and receipt without another transaction or adapter invocation.

For SupplyLens, the entitlement and stored result are retained for 24 hours from recorded settlement. The duration is declared in the commercial manifest and generated into the public contract. Expiry removes payment bypass; it does not erase the immutable settlement audit record.

The entitlement is the Phase-1 remedy when settlement succeeded but the response was lost. Phase 1 has no onchain refund or fungible service-credit mechanism.

## Settlement quarantine and reconciliation

The official facilitator interface does not guarantee a general settlement-status lookup. Therefore:

- a facilitator timeout does not mean settlement failed;
- `settling` found during restart becomes `settlement_unknown`;
- the kernel never blindly submits the same settlement again;
- quarantined calls never deliver output and never execute again;
- automatic resolution requires provable facilitator evidence or Base Sepolia chain evidence matching the network, asset contract, payer when available, recipient, amount, authorization nonce, and fingerprint-bound payment;
- absent sufficient evidence, the call remains quarantined for operator review.

`POST /ops/reconcile` is separately operator-authorized, audited, rate-limited, and never payment-authorized. It may attach evidence and perform an allowed monotonic resolution; it cannot fabricate a receipt, edit the fingerprint, or force delivery without proof.

## Failure ownership

| Failure | Outcome and owner |
| --- | --- |
| Missing, malformed, invalid, expired, underpaid, or wrong-term payment | Caller corrects payment. No execution and no settlement. |
| `paymentId` reused with a different fingerprint | `409 Conflict`. No execution, settlement, or output. |
| Adapter error or deadline | Seller capability failure. Record cancellation; do not settle. |
| Crash during replay-safe execution | Mark `execution_unknown`; rerun under one new lease. |
| Crash after result persistence but before settlement | Resume from stored output without executing again, subject to a fresh verified request and unambiguous payment state. |
| Settlement rejection | Lock output and record definitive rejection. |
| Settlement timeout or crash while settling | Quarantine as `settlement_unknown`; require evidence. |
| Recorded settlement followed by lost response | Seller owes delivery; matching retry entitlement returns stored result and receipt. |

## Structured public behavior

- Unpaid protected calls return an official x402 v2 `402` challenge.
- Payment validation failures fail closed with stable machine-readable codes.
- Mismatched `paymentId` reuse returns `409`.
- A matching request already executing returns `202` plus `callId`, retry guidance, and no protected output.
- Quarantined settlement returns `503` with `callId` and an opaque `settlement_pending_review` code; it does not reveal payment payloads or private evidence.
- Settled replay returns the original protected result and settlement receipt.

HTTP and MCP translate these same kernel outcomes into their transport-native response shapes. Transport code cannot create alternate payment or recovery semantics.

## Verification evidence

Evidence is captured as commands and sanitized output. Local simulation and Base Sepolia are reported separately; neither is represented as product demand.

### Local simulation must prove

- manifest-generated unpaid x402 v2 challenge;
- valid simulated payment executes once;
- invalid, expired, underpaid, wrong-asset, wrong-network, wrong-recipient, and argument-mismatched rejection;
- matching replay returns the settled stored result;
- mismatched `paymentId` replay returns `409`;
- concurrent retries produce one execution and one settlement;
- adapter error dispatches cancellation and never settles;
- crash recovery from `executing`, `executed`, and `settling`;
- unresolved settlement remains quarantined;
- generated OpenAPI, discovery, catalog, MCP, and runtime policies have no drift;
- Base mainnet configuration fails at startup;
- secrets and private inputs remain absent from logs and metrics.

### Base Sepolia must prove separately

- facilitator `/supported` accepts `exact` on `eip155:84532`;
- an unpaid request returns the expected official challenge;
- a funded test client completes a genuine USDC settlement;
- ledger receipt, `PAYMENT-RESPONSE`, transaction hash, payer, recipient, amount, and chain evidence agree;
- the same settled `paymentId` returns the stored result without a second transaction;
- a deliberately failing capability call produces no settlement;
- restart followed by retry preserves the entitlement.

## Execution gates

Live Base Sepolia verification requires:

- an explicitly supplied Base Sepolia recipient address;
- an explicitly supplied payer test wallet funded with test ETH and test USDC;
- current facilitator support confirmed immediately before the test;
- deployment secrets supplied through the runtime secret store.

The build does not generate, import, or silently take custody of either wallet. Missing live credentials skip only the Base Sepolia evidence stage; they do not convert simulation into settlement evidence.

Before dependency installation, the implementation records the resolved official package versions, licenses, maintenance state, known limitations, and the facilitator trust boundary. Exact versions are pinned by the lockfile.

## Design completion criteria

This design is complete when:

- every HTTP and MCP transition maps to the same durable state machine;
- protected output cannot be delivered from any state before `settled`;
- `paymentId` bypass requires a persisted matching settlement receipt;
- uncertain settlement cannot be guessed or automatically resubmitted;
- Phase-1 adapter admission rejects state-changing and non-replay-safe capabilities;
- every local and Base Sepolia verification claim has an explicit evidence requirement.
