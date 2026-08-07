/**
 * limiter.ts — the shared admission limiter.
 *
 * ONE limiter, behind the kernel boundary, keyed by the `clientKey` each
 * transport supplies (socket address for HTTP, session id for MCP). Two
 * independent per-transport limiters would hand a caller the SUM of both
 * ceilings just for alternating doors; this meters the client, not the spoke.
 *
 * The ceilings are the operator's declared runtime policy, unchanged from the
 * values the HTTP edge enforced before this moved.
 */

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
  anonymousMax: number;
}

interface Bucket {
  windowStart: number;
  paid: number;
  anon: number;
}

/**
 * Hard ceiling on tracked clients. Without eviction every distinct client key
 * is a permanent allocation, so the limiter becomes the memory-exhaustion
 * vector it exists to prevent.
 */
const MAX_TRACKED = 10_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private policy: RateLimitPolicy) {}

  private sweep(now: number): void {
    if (now - this.lastSweep < this.policy.windowMs) return;
    this.lastSweep = now;
    for (const [k, v] of this.buckets) {
      if (now - v.windowStart > this.policy.windowMs) this.buckets.delete(k);
    }
    // Still oversized after expiry means an active flood: drop oldest first.
    if (this.buckets.size > MAX_TRACKED) {
      const ordered = [...this.buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (const [k] of ordered.slice(0, this.buckets.size - MAX_TRACKED)) this.buckets.delete(k);
    }
  }

  /**
   * True when this invocation must be refused.
   *
   * `anonymous` means no paymentId was presented — those get the lower ceiling,
   * because a challenge costs us work and earns nothing.
   */
  limited(clientKey: string, anonymous: boolean): boolean {
    const now = Date.now();
    this.sweep(now);
    let b = this.buckets.get(clientKey);
    if (!b || now - b.windowStart > this.policy.windowMs) {
      b = { windowStart: now, paid: 0, anon: 0 };
      // At capacity mid-window, fail CLOSED for unknown clients rather than
      // growing without bound. Known clients keep their existing bucket.
      if (this.buckets.size >= MAX_TRACKED) return true;
      this.buckets.set(clientKey, b);
    }
    if (anonymous) {
      b.anon++;
      return b.anon > this.policy.anonymousMax;
    }
    b.paid++;
    return b.paid > this.policy.max;
  }
}
