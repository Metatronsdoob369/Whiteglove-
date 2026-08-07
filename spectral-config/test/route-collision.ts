/**
 * route-collision.ts — route authority is DECLARED, and ambiguity is refused.
 *
 * Two claims, and the second one is the point:
 *
 *   1. the shipped three-operation config still generates BYTE-IDENTICAL
 *      artifacts now that templates are declared rather than assigned by a
 *      ternary. Declared values that changed even one byte would have silently
 *      re-pathed a live paid route.
 *   2. a fourth operation whose shape a first-match resolver cannot separate
 *      from an existing one FAILS generation — exit 1, no artifacts written,
 *      an error naming both operations and both templates.
 *
 * Claim 2 is run END TO END, as a real `tsx src/generate-all.ts` in a copy of
 * this package whose config carries the extra operation. Asserting only the
 * predicate would leave the wiring untested — and the wiring (does generation
 * actually stop?) is the half that protects the wire. The copy is why: the
 * generator reads one hardcoded config path, so the only honest way to
 * generate from a DIFFERENT config is to give it a different package.
 *
 * The predicate's own semantics are pinned below as a table, because they are
 * inherited from `matchPathTemplate` in spectral-x402/src/http.ts and are
 * looser than they look — a placeholder swallows a literal, and a shorter
 * template subsumes a longer one.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "../src/index.js";
import {
  assertMountRouteShapes,
  relativeTemplate,
  templatesCollide,
  RouteShapeError,
  type RouteShape,
} from "../src/route-collision.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");
const REPO_MANIFESTS = path.resolve(PKG, "../manifests");

let failures = 0;
const ok = (what: string): void => console.log(`ok   ${what}`);
const bad = (what: string, detail: string): void => {
  console.log(`✗ ${what} — ${detail}`);
  failures++;
};

function expect(cond: boolean, what: string, detail = "assertion failed"): void {
  cond ? ok(what) : bad(what, detail);
}

// ── the predicate's semantics, as a table ───────────────────────────────────
//
// `collide: true` means NO caller path can distinguish the two shapes, so
// first-match resolution decides by declaration order.

const PAIRS: Array<{ a: string; b: string; collide: boolean; why: string }> = [
  // The three real shapes are pairwise separable — this is what makes the
  // shipped manifest safe under a first-match resolver.
  { a: "tile/{cid}", b: "proof/{cid}", collide: false, why: "distinct literals at position 0" },
  { a: "tile/{cid}", b: "manifest", collide: false, why: "distinct literals at position 0" },
  { a: "proof/{cid}", b: "manifest", collide: false, why: "distinct literals at position 0" },

  // The defect Finding #0 describes: the old ternary handed every
  // unrecognized operation pack_manifest's exact path.
  { a: "manifest", b: "manifest", collide: true, why: "identical templates" },

  // A placeholder matches a LITERAL too, so these are not alternatives.
  { a: "manifest", b: "{cid}", collide: true, why: "a placeholder swallows the literal" },
  { a: "{a}", b: "{b}", collide: true, why: "two placeholders match the same paths" },

  // Only the template's own segments are examined, so a shorter template
  // subsumes a longer one it agrees with.
  { a: "manifest", b: "manifest/{x}", collide: true, why: "shorter template ignores the extra segment" },
  { a: "tile/{cid}", b: "tile", collide: true, why: "shared literal prefix, one template ends" },

  // Divergence AFTER a shared prefix is still divergence.
  { a: "tile/raw/{cid}", b: "tile/meta/{cid}", collide: false, why: "distinct literals at position 1" },

  // An empty relative template (a mount-root route) is a catch-all.
  { a: "", b: "manifest", collide: true, why: "no segments to disagree on" },
];

for (const p of PAIRS) {
  const got = templatesCollide(p.a, p.b);
  expect(got === p.collide, `collide(${p.a || "<root>"}, ${p.b || "<root>"}) === ${p.collide} — ${p.why}`, `got ${got}`);
  // The relation is symmetric; a first-match resolver has no preferred order.
  expect(
    templatesCollide(p.b, p.a) === got,
    `collide(${p.b || "<root>"}, ${p.a || "<root>"}) is symmetric`,
    "asymmetric result"
  );
}

expect(relativeTemplate("/roblox-luau/tile/{cid}") === "tile/{cid}", "relativeTemplate strips the mount segment");
expect(relativeTemplate("/roblox-luau/manifest") === "manifest", "relativeTemplate on a one-segment shape");

// ── the shipped manifest passes the check generation runs ───────────────────

const soldMounts = MANIFEST.pipelines.filter((p) => p.distribution === "sealed-paid" && p.commercial?.sold);
expect(soldMounts.length > 0, "the manifest declares at least one sold mount");

const shapesOf = (p: (typeof soldMounts)[number]): RouteShape[] =>
  p.commercial!.operations.map((op) => ({ operationId: op.operationId, method: "GET", pathTemplate: op.pathTemplate }));

for (const p of soldMounts) {
  try {
    assertMountRouteShapes(p.id, shapesOf(p));
    ok(`mount "${p.id}" declares ${p.commercial!.operations.length} pairwise-separable routes`);
  } catch (e) {
    bad(`mount "${p.id}" route shapes`, (e as Error).message);
  }
}

// ── refusals: the added operation, and the mislabelled prefix ───────────────

function refuses(what: string, mountId: string, routes: RouteShape[], mustNameEach: string[]): void {
  try {
    assertMountRouteShapes(mountId, routes);
    bad(what, "ACCEPTED — the check did not refuse");
  } catch (e) {
    if (!(e instanceof RouteShapeError)) return bad(what, `wrong error type: ${(e as Error).name}`);
    const missing = mustNameEach.filter((n) => !e.message.includes(n));
    missing.length === 0 ? ok(what) : bad(what, `message omits ${missing.join(", ")}`);
  }
}

const roblox = soldMounts.find((p) => p.id === "roblox-luau")!;

refuses(
  "refused: a new operation carrying pack_manifest's exact path (the old ternary's default)",
  "roblox-luau",
  [...shapesOf(roblox), { operationId: "pack_summary", method: "GET", pathTemplate: "/roblox-luau/manifest" }],
  ["pack_manifest", "pack_summary", "/roblox-luau/manifest"]
);

refuses(
  "refused: a new operation whose placeholder swallows pack_manifest's literal",
  "roblox-luau",
  [...shapesOf(roblox), { operationId: "pack_summary", method: "GET", pathTemplate: "/roblox-luau/manifest/{part}" }],
  ["pack_manifest", "pack_summary"]
);

refuses(
  "refused: a template that does not begin with its own mount id",
  "roblox-luau",
  [{ operationId: "pack_summary", method: "GET", pathTemplate: "/medical-medlineplus/summary" }],
  ["pack_summary", "/medical-medlineplus/summary"]
);

// A different METHOD is a different resolution path — resolveRoute skips
// operations whose method differs before it matches any shape.
try {
  assertMountRouteShapes("roblox-luau", [
    { operationId: "pack_manifest", method: "GET", pathTemplate: "/roblox-luau/manifest" },
    { operationId: "pack_write", method: "POST", pathTemplate: "/roblox-luau/manifest" },
  ]);
  ok("accepted: identical shapes under DIFFERENT methods do not collide");
} catch (e) {
  bad("identical shapes under different methods", (e as Error).message);
}

// ── end to end: does generation actually stop? ──────────────────────────────

const ARTIFACTS = [
  "x402-routes.json",
  "openapi.json",
  "discovery.json",
  "catalog.json",
  "mcp-tools.json",
  "runtime-policy.json",
  "fingerprint-spec.json",
  "refusals.json",
  "generated.lock",
];

/**
 * A runnable copy of this package: real src, real config, real node_modules
 * (symlinked — copying them would cost minutes). `OUT_DIR` is derived from the
 * generator's own location, so a copy at <tmp>/pkg/src writes to <tmp>/manifests
 * and the repo's committed artifacts are never in reach.
 */
function generateInCopy(mutate?: (config: string) => string): { status: number; stderr: string; outDir: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "spectral-gen-"));
  const pkg = path.join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  for (const entry of ["src", "config", "tsconfig.json", "package.json"]) {
    cpSync(path.join(PKG, entry), path.join(pkg, entry), { recursive: true });
  }
  symlinkSync(path.join(PKG, "node_modules"), path.join(pkg, "node_modules"), "dir");

  if (mutate) {
    const cfg = path.join(pkg, "config", "domains.config.ts");
    writeFileSync(cfg, mutate(readFileSync(cfg, "utf8")));
  }

  const run = spawnSync(path.join(pkg, "node_modules", ".bin", "tsx"), ["src/generate-all.ts"], {
    cwd: pkg,
    encoding: "utf8",
  });
  return { status: run.status ?? -1, stderr: `${run.stderr}${run.stdout}`, outDir: path.join(root, "manifests"), root };
}

// (1) unmutated copy → byte-identical to what is committed.
{
  const gen = generateInCopy();
  try {
    if (gen.status !== 0) {
      bad("e2e: the shipped config generates cleanly", `exit ${gen.status}: ${gen.stderr.slice(0, 400)}`);
    } else {
      const emitted = readdirSync(gen.outDir).sort();
      expect(
        ARTIFACTS.every((a) => emitted.includes(a)),
        "e2e: the shipped config emits every declared artifact",
        `emitted ${emitted.join(", ")}`
      );
      let diffs = 0;
      for (const a of ARTIFACTS) {
        const fresh = readFileSync(path.join(gen.outDir, a));
        const committed = readFileSync(path.join(REPO_MANIFESTS, a));
        if (!fresh.equals(committed)) {
          bad(`e2e: ${a} is byte-identical to the committed artifact`, "content differs");
          diffs++;
        }
      }
      if (diffs === 0) ok(`e2e: all ${ARTIFACTS.length} artifacts byte-identical to the committed copies`);
    }
  } finally {
    rmSync(gen.root, { recursive: true, force: true });
  }
}

// (2) a colliding fourth operation → generation refuses, writing nothing.
{
  const ANCHOR = `{ operationId: "pack_manifest", pathTemplate: "/roblox-luau/manifest", resultKind: "manifest-json", deadlineMs: 5, maxResultBytes: 2097152, priceAtomic: "1000" },`;
  // The exact path the replaced ternary's else-branch produced for any
  // operation it did not recognize by name.
  const COLLIDING = `\n          { operationId: "pack_summary", pathTemplate: "/roblox-luau/manifest", resultKind: "manifest-json", deadlineMs: 5, maxResultBytes: 4096, priceAtomic: "100" },`;

  const gen = generateInCopy((cfg) => {
    if (!cfg.includes(ANCHOR)) throw new Error("route-collision test is stale: pack_manifest anchor not found in domains.config.ts");
    return cfg.replace(ANCHOR, ANCHOR + COLLIDING);
  });
  try {
    expect(gen.status === 1, "e2e: a colliding fourth operation exits 1", `exit ${gen.status}`);
    for (const needle of ["GENERATION REFUSED", "pack_manifest", "pack_summary", "/roblox-luau/manifest"]) {
      expect(gen.stderr.includes(needle), `e2e: the refusal names ${needle}`, gen.stderr.slice(0, 300));
    }
    let wrote = 0;
    try {
      wrote = readdirSync(gen.outDir).length;
    } catch {
      /* the directory was never created — also "wrote nothing" */
    }
    expect(wrote === 0, "e2e: a refused generation writes no artifacts", `${wrote} file(s) written`);
  } finally {
    rmSync(gen.root, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} route-authority check(s) failed`);
  process.exit(1);
}
console.log("\nroute authority holds — declared templates, ambiguity refused at generation");
