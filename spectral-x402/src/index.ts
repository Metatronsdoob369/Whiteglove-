/**
 * spectral-x402 — x402 mount kernel entrypoint.
 *
 * Boot order (all fail-closed):
 *   1. Load generated manifests; verify every digest against generated.lock.
 *   2. Admit mounts: refuse any non-read_only / non-replaySafe / non-sealed-pack declaration.
 *   3. Load substrates once (verify merkle root + detached seal per pack).
 *   4. Open the SQLite ledger (WAL, synchronous=FULL); reconcile crashed states.
 *   5. Start paid listener (public) and ops listener (loopback only).
 *
 * The kernel reads only generated JSON at runtime — never domains.config.ts.
 */

export const KERNEL_VERSION = "0.1.0";
