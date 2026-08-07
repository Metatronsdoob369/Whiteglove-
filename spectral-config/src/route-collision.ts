/**
 * route-collision.ts — generation-time route-authority check.
 *
 * The generator used to ASSIGN each operation's `pathTemplate` from a ternary
 * whose else-branch handed `/<mount>/manifest` to every operation it did not
 * recognize by name. A fourth operation therefore shipped with pack_manifest's
 * path, and the paid HTTP edge resolves a request to an operationId by
 * matching path shapes in declaration order (`spectral-x402/src/http.ts`,
 * `resolveRoute` → `matchPathTemplate`). First match wins, and nothing
 * detected the tie: the wrong operation ran, with the wrong adapter and the
 * wrong price, on a paid wire — while the MCP spoke, which routes by tool
 * name, dispatched the same call correctly. A wrong-price defect and a
 * two-doors-one-kernel parity violation from one silent default.
 *
 * Templates are now DECLARED per operation in domains.config.ts, and this
 * module is what makes declaring them safe: generation refuses a mount whose
 * declared shapes cannot be told apart by the resolver that has to tell them
 * apart at runtime.
 *
 * ── the twin ────────────────────────────────────────────────────────────────
 * `spectral-x402/src/route-collision.ts` carries the same predicate for the
 * server's boot-time refusal. It is a deliberate duplicate, not an import: the
 * two packages share no dependency (JSON across the seam is the whole point of
 * the generated-artifact design, FOLD_SPEC "After the fold"), and a shared
 * package to hold twenty lines would couple a Node-20 CJS payment kernel to an
 * ESM build layer. Both files must move together; each names the other.
 *
 * Both mirror ONE authority — `matchPathTemplate` in spectral-x402/src/http.ts.
 * If its matching rules change, these predicates are wrong until they change
 * too, and the boot-time twin is what turns that into a refusal rather than a
 * mis-dispatch.
 */

/** The minimum a route needs to be checked for ambiguity. */
export interface RouteShape {
  operationId: string;
  method: string;
  /** Absolute, mount-prefixed: `/roblox-luau/tile/{cid}`. */
  pathTemplate: string;
}

export class RouteShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteShapeError";
  }
}

const isPlaceholder = (segment: string): boolean => segment.startsWith("{") && segment.endsWith("}");

const segments = (s: string): string[] => s.split("/").filter(Boolean);

/**
 * A template with its leading segment — the declaring mount's id — removed.
 *
 * The HTTP edge strips the mount segment off the caller's path before matching
 * (`http.ts` `relativeTemplate`), so the mount id is never part of what
 * distinguishes two operations of the SAME mount. Comparing full templates
 * would therefore compare a segment that is equal by construction.
 */
export function relativeTemplate(pathTemplate: string): string {
  return segments(pathTemplate).slice(1).join("/");
}

/**
 * True when NO caller path can distinguish these two relative shapes — i.e.
 * some concrete path matches both, so first-match resolution picks by
 * declaration order rather than by what the caller asked for.
 *
 * Derived from `matchPathTemplate`'s actual semantics, which are looser than
 * they look:
 *
 *   - only the TEMPLATE's segments are examined; extra segments in the
 *     caller's path are ignored, so a shorter template subsumes a longer one
 *     that agrees with it on the shared prefix (`tile` vs `tile/{cid}`);
 *   - a `{placeholder}` matches whatever sits at that position, INCLUDING a
 *     literal, and matches even when the caller omitted the segment entirely.
 *     So `{cid}` and `manifest` are not alternatives — `{cid}` swallows
 *     `manifest`;
 *   - only a literal-vs-literal disagreement is a non-match.
 *
 * Hence: two templates are distinguishable if and only if some position
 * within BOTH of their lengths holds two DIFFERENT literals. Anything else —
 * two placeholders, a placeholder against a literal, a common prefix with one
 * template simply ending — leaves at least one path both accept.
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
 * Refuse a mount whose declared routes are not resolvable.
 *
 * Two failures, both fatal to generation:
 *
 *   1. a template that does not begin with its own mount's id. The HTTP edge
 *      strips exactly one leading segment and treats the rest as the shape
 *      after the mount, so a template that names a different mount (or no
 *      mount) silently publishes a shape nobody can reach. That convention was
 *      previously guaranteed because the generator wrote the prefix itself;
 *      now that operations declare the whole string, the guarantee has to be
 *      checked.
 *   2. two operations whose shapes collide under `templatesCollide`. Only
 *      same-method pairs are compared, because `resolveRoute` skips operations
 *      whose method differs before it ever matches a path.
 *
 * Scope is ONE mount, matching where the ambiguity does damage: a caller's
 * path carries the mount id in its first segment, and the kernel refuses an
 * operation the addressed mount does not declare.
 */
export function assertMountRouteShapes(mountId: string, routes: readonly RouteShape[]): void {
  for (const r of routes) {
    const first = segments(r.pathTemplate)[0];
    if (first !== mountId) {
      throw new RouteShapeError(
        `mount "${mountId}" operation "${r.operationId}" declares pathTemplate "${r.pathTemplate}", ` +
          `which does not begin with the mount's own id — every template must be "/${mountId}/...".`
      );
    }
  }
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i];
      const b = routes[j];
      if (a.method !== b.method) continue;
      if (!templatesCollide(relativeTemplate(a.pathTemplate), relativeTemplate(b.pathTemplate))) continue;
      throw new RouteShapeError(
        `mount "${mountId}" declares two operations whose paid routes cannot be told apart: ` +
          `"${a.operationId}" (${a.method} ${a.pathTemplate}) and "${b.operationId}" (${b.method} ${b.pathTemplate}). ` +
          `A request matching both resolves to whichever is declared first — the wrong adapter, ` +
          `the wrong price, on a paid wire. Give them distinguishable literal segments.`
      );
    }
  }
}
