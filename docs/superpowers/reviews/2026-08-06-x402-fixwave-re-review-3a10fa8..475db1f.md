# Independent re-review — fix wave 3a10fa8..475db1f (2026-08-06)

VERDICT: APPROVED FOR MERGE DECISION — all five mandated items verified, zero residue, no new breakage.

A. Generator side (e5ef3d8) VERIFIED: ternary gone (generate-all.ts pathTemplate: op.pathTemplate); all six
operations declare templates in domains.config.ts; byte-identity proven 3 ways (0 manifest files in net diff,
check:drift green, e2e compares fresh output vs repo for all 9 artifacts); collision predicate derived from
matchPathTemplate semantics (placeholder swallows literal — /x/manifest vs /x/{cid} collides), pinned by a
symmetry table; GENERATION REFUSED names both operationIds + templates, exit 1; wired into check:all as
check:routes with two REAL generator subprocess checks against a copied package.

B. Runtime side (5055116) VERIFIED: assertNoRouteCollisions before Substrate.load and ledger open; checked
over raw routes array (Map would collapse exact dupes); message names both operationIds; six real routes
still boot (exact sorted list asserted); twin predicate character-identical to generator's shared core;
cross-validated against an independent concrete-path matcher over a 7x7 template grid.

C. Revert completeness VERIFIED: net diff exactly 10 files; kernel.ts/mcp.ts/http.ts/rate-limit.ts/
mcp-transport.test.ts/http-routing.test.ts clean vs 3a10fa8; zero #1 residue (no mcp-init/initRateLimit/
second RateLimiter); zero #3 residue (no nonce/payment_invalid in http.ts); no backup remnants; test
arithmetic corroborates: 145 - 6 - 2 = 137 = 129 baseline + 8 route-authority.

D. Docs commit (d0cf7dc) VERIFIED: docs/superpowers/reviews/2026-08-06-x402-final-review-712cfda..3a10fa8.md
byte-identical to workspace original, complete.

E. No new breakage. Missing pathTemplate is unrepresentable (zod required + tsc annotation — fails loudly at
two layers); boundary/hand-edit fixtures live and passing; guard proven not over-eager; no partial artifact
writes on refusal.

Out-of-scope observations (Low, disclosed, cross-mount cases outside the mandate, unreachable in shipped
config): (1) resolveRoute mount-agnostic — two DIFFERENT mounts sharing a relative shape could cross-resolve
(current two-mount same-shape table deliberately allowed, asserted); (2) runtime twin omits the generator's
mount-prefix rule — a hand-edited mount-root template (relative "") would pass boot as a catch-all.
