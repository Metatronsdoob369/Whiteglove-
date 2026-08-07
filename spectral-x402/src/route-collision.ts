/**
 * route-collision.ts — boot-time route-authority refusal.
 *
 * TWIN of `spectral-config/src/route-collision.ts`. Deliberately duplicated,
 * not imported: the two packages share no dependency by design (the kernel
 * consumes generated JSON across the seam and never the ESM build layer), and
 * a shared package to carry twenty lines would couple this Node-20 CommonJS
 * payment kernel to that build layer. Both files must move together.
 *
 * ── why the server checks what the generator already refuses ────────────────
 * The generator is not the only way a manifest reaches this boot. Editing
 * `x402-routes.json` and re-sealing `generated.lock` produces artifacts that
 * pass every digest check — our own boundary suite does exactly that to add
 * fixture capabilities, so the path is not hypothetical, it is supported. A
 * manifest that never passed through the generator would otherwise arrive
 * here with colliding shapes and boot clean.
 *
 * Colliding shapes are not a cosmetic problem. `resolveRoute` in http.ts
 * returns an operationId by FIRST MATCH, so a tie silently dispatches the
 * wrong operation — wrong adapter, wrong product, wrong price — while the MCP
 * spoke, routing by tool name, dispatches the same call correctly. Refusing at
 * boot is the difference between a service that will not start and a service
 * that quietly charges the wrong price on one of its two doors.
 *
 * ── one authority ───────────────────────────────────────────────────────────
 * The rules below mirror `matchPathTemplate` in http.ts, which is the only
 * real definition of what "matches" means. If that function's semantics
 * change, this predicate is wrong until it changes too — and because this one
 * refuses at boot, the mismatch surfaces as a refused start rather than a
 * mis-dispatched paid call.
 */

/** The manifest fields a route needs to be checked for ambiguity. */
export interface RouteShape {
  operationId: string;
  method: string;
  /** Absolute, mount-prefixed, exactly as x402-routes.json carries it. */
  pathTemplate: string;
}

const isPlaceholder = (segment: string): boolean => segment.startsWith("{") && segment.endsWith("}");

const segments = (s: string): string[] => s.split("/").filter(Boolean);

/**
 * A template minus its leading mount segment — the shape `resolveRoute`
 * actually matches a caller's path against (http.ts `relativeTemplate`).
 */
function relativeTemplate(pathTemplate: string): string {
  return segments(pathTemplate).slice(1).join("/");
}

/**
 * True when no caller path can distinguish these two relative shapes.
 *
 * `matchPathTemplate` examines ONLY the template's own segments, treats a
 * `{placeholder}` as matching whatever occupies that position (a literal
 * included, and an absent segment too), and rejects solely on a
 * literal-vs-literal disagreement. So two shapes are separable if and only if
 * some position inside both of their lengths holds two DIFFERENT literals;
 * every other arrangement leaves at least one path that both accept.
 */
export function templatesCollide(relativeA: string, relativeB: string): boolean {
  const a = segments(relativeA);
  const b = segments(relativeB);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!isPlaceholder(a[i]) && !isPlaceholder(b[i]) && a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Throws when a mount's declared routes cannot be resolved unambiguously.
 *
 * Compares same-method pairs only, because `resolveRoute` skips an operation
 * whose method differs before it matches any shape. Scope is one mount: a
 * caller's path carries the mount id in its first segment, and the kernel
 * refuses an operation the addressed mount does not declare.
 *
 * Takes the RAW route array rather than a mount's operations Map — that map is
 * keyed by operationId, so it would already have collapsed a duplicated
 * operation before this could see both halves of the pair.
 */
export function assertNoRouteCollisions(mountId: string, routes: readonly RouteShape[]): void {
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i];
      const b = routes[j];
      if (a.method !== b.method) continue;
      if (!templatesCollide(relativeTemplate(a.pathTemplate), relativeTemplate(b.pathTemplate))) continue;
      throw new Error(
        `BOOT_REFUSED: mount "${mountId}" declares two operations whose paid routes cannot be told apart: ` +
          `"${a.operationId}" (${a.method} ${a.pathTemplate}) and "${b.operationId}" (${b.method} ${b.pathTemplate}). ` +
          `First-match resolution would dispatch one of them to the other's adapter and price.`
      );
    }
  }
}
