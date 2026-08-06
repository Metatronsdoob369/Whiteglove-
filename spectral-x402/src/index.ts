/**
 * spectral-x402 — public surface.
 *
 * Boot order (all fail-closed):
 *   1. Load generated manifests; verify every digest against generated.lock.
 *   2. Admit mounts: refuse any non-read_only / non-replaySafe / non-sealed-pack declaration.
 *   3. Load substrates once (verify merkle root + detached seal per pack).
 *   4. Open the SQLite ledger (WAL, synchronous=FULL); reconcile crashed states.
 *   5. Attach transports. `bootKernelOnly` stops at step 4; `boot` adds the
 *      paid HTTP listener.
 *
 * The kernel reads only generated JSON at runtime — never domains.config.ts.
 *
 * What is exported is what a TRANSPORT or an operator tool needs: the kernel
 * and its invocation contract, the two boots, the facilitator boundary, the
 * ledger, the pack substrate, and the published paymentId rule. Fingerprint
 * internals and the pack-building CLIs stay private.
 */

export { KERNEL_VERSION } from "./version.js";

// ── kernel: the transport-neutral core
export { Kernel, AdapterMiss } from "./kernel.js";
export type { PaidInvocation, KernelOutcome, Transport, Mount, MountOperation } from "./kernel.js";

// ── shared admission limiter (one per kernel, keyed by clientKey)
export { RateLimiter } from "./limiter.js";
export type { RateLimitPolicy } from "./limiter.js";

// ── boot: ledger + mounts + kernel, with or without an HTTP listener
export { boot, bootKernelOnly } from "./server.js";
export type { BootOptions, KernelBootOptions, Booted, BootedKernel, RuntimePolicy } from "./server.js";

// ── HTTP transport: one of several possible edges, not the kernel's business
export { createPaidServer, statusFor } from "./http.js";
export type { HttpOptions, RefusalTable } from "./http.js";

// ── durable state
export { Ledger, LedgerRefusal } from "./ledger.js";
export type { CallState, CallRow, ReceiptInput } from "./ledger.js";

// ── sealed packs
export { Substrate, SubstrateRefusal, canonicalize, cidOf } from "./substrate.js";
export type { TrustEntry } from "./substrate.js";

// ── payment boundary
export { StubFacilitator, HttpFacilitator } from "./facilitator.js";
export type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  VerifyResult,
  SettleResult,
  StubMode,
} from "./facilitator.js";

// ── the paymentId rule we publish, so a caller can hold itself to it too
export {
  isValidPaymentId,
  PAYMENT_ID_PATTERN,
  PAYMENT_ID_PATTERN_SOURCE,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_CHARS,
} from "./payment-id.js";

// ── fail-closed secret handling
export { assertNoSpendingKeysInEnv, resolvePayTo, SecretRefusal } from "./secrets.js";
