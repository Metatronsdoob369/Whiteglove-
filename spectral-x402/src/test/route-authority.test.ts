/**
 * route-authority.test.ts — boot refuses a route table it cannot resolve.
 *
 * The paid HTTP edge turns a caller's path into an operationId by FIRST MATCH
 * with no ambiguity detection (`resolveRoute` → `matchPathTemplate`, http.ts).
 * Two operations of one mount whose shapes overlap therefore dispatch by
 * declaration order: the wrong adapter, the wrong product, the wrong price, on
 * a paid wire — while the MCP spoke, which routes by tool name, serves the
 * same call correctly. One manifest, two answers.
 *
 * The generator now refuses to EMIT such a manifest. That is not sufficient on
 * its own, and this file is about why: hand-editing `x402-routes.json` and
 * re-sealing `generated.lock` produces artifacts that satisfy every digest
 * check at boot without ever passing through the generator. boundary.test.ts
 * does exactly that to add fixture capabilities, so the path is supported, not
 * hypothetical. Boot has to hold the same line.
 *
 * Fixtures here are built the same supported way — a real clone of the real
 * manifests, edited and re-sealed with the package's own `cidOf` — so what is
 * under test is the refusal, never a broken digest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { bootKernelOnly, cidOf, StubFacilitator } from "../index.js";
import { templatesCollide } from "../route-collision.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";

interface RouteEntry {
  operationId: string;
  method: string;
  pathTemplate: string;
  resultKind: string;
  deadlineMs: number;
  maxResultBytes: number;
  priceAtomic: string;
}
interface RoutesArtifact {
  mounts: Array<{ mountId: string; routes: RouteEntry[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * A clone of the real manifests with `edit` applied and `generated.lock`
 * re-sealed over the result — the hand-edit path this refusal exists to catch.
 */
function fixtureManifests(dir: string, edit: (routes: RoutesArtifact) => void): string {
  const md = path.join(dir, "manifests");
  mkdirSync(md, { recursive: true });
  cpSync(MANIFESTS, md, { recursive: true });

  const routes = JSON.parse(readFileSync(path.join(md, "x402-routes.json"), "utf8")) as RoutesArtifact;
  edit(routes);
  writeFileSync(path.join(md, "x402-routes.json"), JSON.stringify(routes, null, 2) + "\n");

  const lock = JSON.parse(readFileSync(path.join(md, "generated.lock"), "utf8")) as {
    artifacts: Record<string, string>;
  };
  lock.artifacts["x402-routes.json"] = cidOf(routes);
  writeFileSync(path.join(md, "generated.lock"), JSON.stringify(lock, null, 2) + "\n");
  return md;
}

async function bootWith(manifestsDir: string, ledgerDir: string) {
  return bootKernelOnly({
    manifestsDir,
    packsDir: PACKS,
    ledgerPath: path.join(ledgerDir, "ledger.db"),
    facilitator: new StubFacilitator("valid"),
    payToOverride: PAY_TO,
  });
}

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-routeauth-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const extraRoute = (over: Partial<RouteEntry>): RouteEntry => ({
  operationId: "shadow_op",
  method: "GET",
  pathTemplate: `/${MOUNT}/shadow`,
  resultKind: "manifest-json",
  deadlineMs: 5,
  maxResultBytes: 64,
  priceAtomic: "100",
  ...over,
});

// ─── the real thing still boots ──────────────────────────────────────────────

test("route authority: the six real routes boot, unchanged", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(MANIFESTS, dir);
    try {
      const shapes: string[] = [];
      for (const mountId of core.kernel.mountIds()) {
        for (const op of core.kernel.getMount(mountId)!.operations.values()) shapes.push(op.pathTemplate);
      }
      assert.deepEqual(
        shapes.sort(),
        [
          "/medical-medlineplus/manifest",
          "/medical-medlineplus/proof/{cid}",
          "/medical-medlineplus/tile/{cid}",
          "/roblox-luau/manifest",
          "/roblox-luau/proof/{cid}",
          "/roblox-luau/tile/{cid}",
        ],
        "the shipped route table is what boots — a refusal here would be a false positive"
      );
    } finally {
      core.close();
    }
  });
});

// ─── the shapes that must refuse ─────────────────────────────────────────────

const REFUSED: Array<{ name: string; route: RouteEntry; twin: string }> = [
  {
    // A bare placeholder swallows every one-segment literal AND every longer
    // shape, so it collides with all three. The refusal names the FIRST pair
    // it finds — tile_fetch, the first declared — which is enough: one
    // unresolvable pair is already a refused boot.
    name: "a placeholder against a literal (/m/{a} vs the mount's own shapes)",
    route: extraRoute({ operationId: "shadow_any", pathTemplate: `/${MOUNT}/{anything}` }),
    twin: "tile_fetch",
  },
  {
    name: "the exact duplicate the old generator ternary produced",
    route: extraRoute({ operationId: "shadow_manifest", pathTemplate: `/${MOUNT}/manifest` }),
    twin: "pack_manifest",
  },
  {
    name: "two placeholders in the same position (/m/tile/{a} vs /m/tile/{cid})",
    route: extraRoute({ operationId: "shadow_tile", pathTemplate: `/${MOUNT}/tile/{other}` }),
    twin: "tile_fetch",
  },
  {
    name: "a shorter template subsuming a longer one (/m/tile vs /m/tile/{cid})",
    route: extraRoute({ operationId: "shadow_short", pathTemplate: `/${MOUNT}/tile` }),
    twin: "tile_fetch",
  },
];

for (const c of REFUSED) {
  test(`route authority: boot refuses ${c.name}`, async () => {
    await withTmpDir(async (dir) => {
      const md = fixtureManifests(dir, (routes) => {
        routes.mounts.find((m) => m.mountId === MOUNT)!.routes.push(c.route);
      });
      await assert.rejects(
        () => bootWith(md, dir),
        (e: Error) => {
          assert.match(e.message, /BOOT_REFUSED/);
          // Both halves of the pair, so an operator can act on the message
          // without reading the manifest.
          assert.ok(e.message.includes(c.route.operationId), `names the added operation: ${e.message}`);
          assert.ok(e.message.includes(c.twin), `names the operation it collides with: ${e.message}`);
          assert.ok(e.message.includes(c.route.pathTemplate), `names the colliding template: ${e.message}`);
          return true;
        }
      );
    });
  });
}

// ─── what must NOT refuse ────────────────────────────────────────────────────

test("route authority: a distinguishable new operation still boots", async () => {
  await withTmpDir(async (dir) => {
    const md = fixtureManifests(dir, (routes) => {
      routes.mounts
        .find((m) => m.mountId === MOUNT)!
        .routes.push(extraRoute({ operationId: "echo_ping", pathTemplate: `/${MOUNT}/echo_ping` }));
    });
    // Boot gets past the route check and fails LATER, on the adapter registry
    // — which is the proof that route authority let it through. A refusal
    // naming the route table would mean the check is too eager to be usable.
    await assert.rejects(
      () => bootWith(md, dir),
      (e: Error) => {
        assert.match(e.message, /no registered adapter handler/, `expected the adapter refusal, got: ${e.message}`);
        assert.ok(!e.message.includes("cannot be told apart"), "the route table must not have been blamed");
        return true;
      }
    );
  });
});

test("route authority: the same shape on a DIFFERENT mount is not a collision", async () => {
  await withTmpDir(async (dir) => {
    // Every mount already serves "tile/{cid}" relative to itself; the check is
    // per mount because the caller's path names the mount in its first
    // segment. This is really an assertion that the shipped two-mount
    // manifest is not itself a false positive, stated as its own claim.
    const core = await bootWith(MANIFESTS, dir);
    try {
      const relatives = core.kernel
        .mountIds()
        .map((id) => [...core.kernel.getMount(id)!.operations.values()].map((o) => o.pathTemplate.split("/")[2]));
      assert.deepEqual(relatives[0].sort(), relatives[1].sort(), "both mounts publish the same relative shapes");
    } finally {
      core.close();
    }
  });
});

// ─── the predicate mirrors matchPathTemplate, and is checked against it ──────

test("route authority: the collision predicate agrees with matchPathTemplate on concrete paths", async () => {
  // The predicate claims "collide" means SOME path matches both. Rather than
  // trust the reading, enumerate: for each pair, find a witness path both
  // accept, or confirm none of the candidates is accepted by both.
  const match = (template: string, actual: string): boolean => {
    const t = template.split("/").filter(Boolean);
    const a = actual.split("/").filter(Boolean);
    for (let i = 0; i < t.length; i++) {
      const seg = t[i];
      if (!(seg.startsWith("{") && seg.endsWith("}")) && a[i] !== seg) return false;
    }
    return true;
  };

  const templates = ["tile/{cid}", "proof/{cid}", "manifest", "{any}", "tile", "tile/raw/{cid}", "tile/meta/{cid}"];
  const candidates = [
    "manifest",
    "tile",
    "proof",
    "tile/abc",
    "proof/abc",
    "manifest/abc",
    "tile/raw/abc",
    "tile/meta/abc",
    "x/y/z",
  ];

  for (const a of templates) {
    for (const b of templates) {
      const witness = candidates.some((c) => match(a, c) && match(b, c));
      assert.equal(
        templatesCollide(a, b),
        witness,
        `predicate and matcher disagree on ("${a}", "${b}") — witness=${witness}`
      );
    }
  }
});
