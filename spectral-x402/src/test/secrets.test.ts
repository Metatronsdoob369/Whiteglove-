import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePayTo,
  assertNoSpendingKeysInEnv,
  envVarForRef,
  SecretRefusal,
} from "../secrets.js";

const REF = "roblox-luau-payto";
const VAR = envVarForRef(REF);
const GOOD_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb7";

// Not a real key — 64 hex chars of a fixed pattern, used only to prove the
// shape guard fires. Never put a real key in a test.
const KEY_SHAPED = "0x" + "1a2b3c4d".repeat(8);
const SEED_SHAPED =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";

test("resolves a public address", () => {
  assert.equal(resolvePayTo(REF, { [VAR]: GOOD_ADDRESS }), GOOD_ADDRESS);
});

test("trims surrounding whitespace from a paste", () => {
  assert.equal(resolvePayTo(REF, { [VAR]: `  ${GOOD_ADDRESS}\n` }), GOOD_ADDRESS);
});

test("refuses a missing value with the env var name in the message", () => {
  assert.throws(
    () => resolvePayTo(REF, {}),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_MISSING" && e.message.includes(VAR)
  );
});

test("refuses a private key pasted where the address goes", () => {
  assert.throws(
    () => resolvePayTo(REF, { [VAR]: KEY_SHAPED }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("refuses a private key without the 0x prefix", () => {
  assert.throws(
    () => resolvePayTo(REF, { [VAR]: KEY_SHAPED.slice(2) }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("refuses a seed phrase", () => {
  assert.throws(
    () => resolvePayTo(REF, { [VAR]: SEED_SHAPED }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("refuses a keystore JSON", () => {
  const keystore = '{"version":3,"crypto":{"ciphertext":"deadbeef","cipher":"aes-128-ctr"}}';
  assert.throws(
    () => resolvePayTo(REF, { [VAR]: keystore }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("refuses a malformed address", () => {
  assert.throws(
    () => resolvePayTo(REF, { [VAR]: "0xnothex" }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_MALFORMED"
  );
});

test("refusal messages never echo the offending value", () => {
  for (const bad of [KEY_SHAPED, SEED_SHAPED]) {
    try {
      resolvePayTo(REF, { [VAR]: bad });
      assert.fail("should have refused");
    } catch (e) {
      const msg = (e as Error).message;
      assert.ok(!msg.includes(bad), "refusal message leaked the secret it refused");
      // and no substantial fragment of it either
      assert.ok(!msg.includes(bad.slice(0, 16)), "refusal message leaked a fragment");
    }
  }
});

test("boot sweep catches a key-shaped value under any X402_ name", () => {
  assert.throws(
    () => assertNoSpendingKeysInEnv({ X402_SOMETHING_ELSE: KEY_SHAPED }),
    (e: unknown) => e instanceof SecretRefusal && e.code === "SECRET_KEY_SHAPED"
  );
});

test("boot sweep passes on a clean environment", () => {
  assertNoSpendingKeysInEnv({ [VAR]: GOOD_ADDRESS, X402_FACILITATOR_URL: "https://example.test" });
});

test("boot sweep ignores non-X402 variables", () => {
  assertNoSpendingKeysInEnv({ SOME_OTHER_TOOL_KEY: KEY_SHAPED });
});
