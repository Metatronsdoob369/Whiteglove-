/**
 * secrets.ts — runtime secret resolution for the mount kernel.
 *
 * The manifest and every generated artifact carry only LOGICAL REFS
 * (payToRef: "roblox-luau-payto"). This module resolves a ref to a concrete
 * value at boot, from the environment only. Nothing here is ever written to
 * disk, logged, or emitted into a generated artifact.
 *
 * The seller is KEY-LESS by construction: an x402 `exact` seller is a
 * receiving address, and the facilitator performs verification and
 * settlement. There is no code path in this kernel that wants a spending
 * key — so any value shaped like one is treated as an operator mistake and
 * refuses startup rather than being quietly accepted.
 */

/** Public EVM address: 0x + 40 hex. Safe to hold, safe to publish. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Shapes that must never appear in kernel config. Refuse, never store. */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export class SecretRefusal extends Error {
  constructor(
    public readonly code: "SECRET_MISSING" | "SECRET_KEY_SHAPED" | "SECRET_MALFORMED",
    message: string
  ) {
    // Never interpolate the offending value into the message — a refusal
    // that echoes the secret is a leak with good intentions.
    super(message);
    this.name = "SecretRefusal";
  }
}

function looksLikeSpendingKey(value: string): boolean {
  const v = value.trim();
  if (PRIVATE_KEY_RE.test(v)) return true;
  const words = v.split(/\s+/);
  if (BIP39_WORD_COUNTS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return true;
  }
  if (/"crypto"\s*:/.test(v) && /"ciphertext"\s*:/.test(v)) return true; // keystore JSON
  return false;
}

/** ENV var name a logical ref resolves to: "roblox-luau-payto" → X402_PAYTO_ROBLOX_LUAU_PAYTO */
export function envVarForRef(ref: string): string {
  return `X402_PAYTO_${ref.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Resolve a payToRef to a public receiving address.
 *
 * Refuses if the value is absent, malformed, or shaped like a spending key.
 * The key-shape refusal is the important one: it catches the predictable
 * "operator pasted the private key where the address goes" before the
 * process is live, and it does so without ever echoing the value.
 */
export function resolvePayTo(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = envVarForRef(ref);
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new SecretRefusal(
      "SECRET_MISSING",
      `payToRef "${ref}" is unresolved: set ${name} to the public receiving address (0x + 40 hex).`
    );
  }
  const value = raw.trim();
  if (looksLikeSpendingKey(value)) {
    throw new SecretRefusal(
      "SECRET_KEY_SHAPED",
      `${name} holds something shaped like a private key, seed phrase, or keystore. ` +
        `This kernel never needs a spending key — it only needs the PUBLIC address (0x + 40 hex). ` +
        `Rotate that secret: assume anything pasted into a shell is compromised.`
    );
  }
  if (!ADDRESS_RE.test(value)) {
    throw new SecretRefusal(
      "SECRET_MALFORMED",
      `${name} is not a public EVM address (expected 0x followed by 40 hex characters).`
    );
  }
  return value;
}

/**
 * Env var names that are NOT `X402_*` but must still never hold a key in the
 * SERVER's environment. The settlement-gate harness reads `PAYER_PRIVATE_KEY`
 * as a one-shot fallback to the Keychain (secrets note in the module header);
 * it belongs to that SEPARATE process alone. An operator who exported it in the
 * shell that then launches the server would put a spending key in the key-less
 * seller's environment — and the `X402_*`-prefixed sweep below is blind to it
 * precisely because the name was chosen to stay out of that namespace. Name it
 * explicitly so the guard is not.
 */
const WATCHED_NON_PREFIXED_KEY_NAMES = ["PAYER_PRIVATE_KEY"];

/**
 * Boot-time sweep: refuse to start if any watched variable is key-shaped —
 * every `X402_*` (regardless of which ref it belongs to) and the harness's
 * documented `PAYER_PRIVATE_KEY` fallback. Belt and suspenders around
 * resolvePayTo, because the cost of being wrong here is unrecoverable.
 */
export function assertNoSpendingKeysInEnv(env: NodeJS.ProcessEnv = process.env): void {
  const offenders: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const watched = name.startsWith("X402_") || WATCHED_NON_PREFIXED_KEY_NAMES.includes(name);
    if (!watched) continue;
    if (value && looksLikeSpendingKey(value)) offenders.push(name);
  }
  if (offenders.length > 0) {
    throw new SecretRefusal(
      "SECRET_KEY_SHAPED",
      `Refusing to start: ${offenders.join(", ")} hold key-shaped values. ` +
        `The seller is key-less — it needs public addresses only, and the payer ` +
        `key belongs solely to the settlement-gate harness process (from the ` +
        `Keychain), never the server's environment. Rotate/unset those secrets.`
    );
  }
}
