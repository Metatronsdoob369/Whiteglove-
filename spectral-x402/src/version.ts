/**
 * version.ts — the kernel version, alone in its own module.
 *
 * It lives here rather than in index.ts because index.ts is the public surface
 * and re-exports server.ts, while server.ts stamps this value into ledger meta
 * on every boot. Importing it from index.ts would make that a cycle.
 *
 * This string is PERSISTED in the ledger. Changing it is a migration decision,
 * not a version bump.
 */
export const KERNEL_VERSION = "0.1.0";
