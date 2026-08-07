/**
 * payer-key-sweep.test.ts — I6: the boot key-sweep sees `PAYER_PRIVATE_KEY`.
 *
 * The seller is key-less, and boot refuses any key-shaped `X402_*` value. The
 * settlement-gate harness reads `PAYER_PRIVATE_KEY` as a one-shot fallback to
 * the Keychain — deliberately OUTSIDE the `X402_*` namespace so an operator is
 * never taught to export a key into the namespace the guard protects. The cost
 * is that the guard was blind to exactly the one name this work introduced: an
 * operator who exported `PAYER_PRIVATE_KEY` in the shell that launches the
 * server would put a spending key in the seller's process and boot would say
 * nothing. The sweep now watches that name too.
 *
 * Uses the function's explicit `env` parameter, so nothing touches this
 * process's real environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSpendingKeysInEnv, SecretRefusal } from "../secrets.js";

const KEY = `0x${"a".repeat(64)}`;
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDRESS = "0x1111111111111111111111111111111111111111";

test("secrets: boot refuses a key-shaped PAYER_PRIVATE_KEY in the server env", () => {
  assert.throws(
    () => assertNoSpendingKeysInEnv({ PAYER_PRIVATE_KEY: KEY }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("secrets: a BIP-39 seed phrase in PAYER_PRIVATE_KEY is caught too", () => {
  assert.throws(
    () => assertNoSpendingKeysInEnv({ PAYER_PRIVATE_KEY: SEED }),
    (e: unknown) => e instanceof SecretRefusal
  );
});

test("secrets: the refusal message never echoes the key value", () => {
  try {
    assertNoSpendingKeysInEnv({ PAYER_PRIVATE_KEY: KEY });
    assert.fail("expected a refusal");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes("PAYER_PRIVATE_KEY"), "it names the offending variable");
    assert.ok(!msg.includes(KEY), "but never the value");
  }
});

test("secrets: a non-key PAYER_PRIVATE_KEY value does not trip the guard", () => {
  // The guard is about key-SHAPED values; an address (or empty) is not one.
  assert.doesNotThrow(() => assertNoSpendingKeysInEnv({ PAYER_PRIVATE_KEY: ADDRESS }));
  assert.doesNotThrow(() => assertNoSpendingKeysInEnv({ PAYER_PRIVATE_KEY: "" }));
});

test("secrets: an unrelated env var holding a key-shaped value is NOT swept (name-scoped, no false positives)", () => {
  // The sweep is a precise deny-list, not a blanket value scan — so a legitimate
  // 64-hex value under some unrelated name (a digest, say) does not block boot.
  assert.doesNotThrow(() => assertNoSpendingKeysInEnv({ SOME_CONTENT_DIGEST: KEY }));
});
