# Going live on Base Sepolia

What an operator provides so the kernel settles REAL payments, and how to prove
it did. Nothing here is code the kernel runs — it is the two inputs the kernel
cannot supply itself, plus the gate that checks them.

Everything below is testnet. Mainnet (`eip155:8453`) stays startup-blocked until
a signed `manifests/mainnet-gate.json` validates; that is a separate decision
with a separate artifact.

---

## 1. The service's configuration — `spectral-x402/.env.local`

The seller is **key-less by construction**. It receives at an address and a
facilitator performs verification and settlement; there is no code path in this
kernel that wants a spending key, and boot refuses to start if any `X402_*`
variable holds something shaped like one.

```sh
# The seller's PUBLIC receiving address. 0x + 40 hex. Appears on chain.
X402_PAYTO_ROBLOX_LUAU_PAYTO=0x…
X402_PAYTO_MEDICAL_MEDLINEPLUS_PAYTO=0x…

# A standard x402 v2 facilitator that supports exact/eip155:84532.
X402_FACILITATOR_URL=https://x402.org/facilitator

# REMOVE THIS LINE ENTIRELY when going live.
# X402_ALLOW_STUB_FACILITATOR=1
```

Deleting `X402_ALLOW_STUB_FACILITATOR` is not cosmetic. The stub approves every
well-formed payment without touching a chain, which is correct for tests and
catastrophic for a listening service. `X402_FACILITATOR_URL` wins when both are
set, but leaving the line there means one edit away from free data.

**The running process does not re-read this file.** Restart after editing:

```sh
npm run service:restart && npm run service:health
```

### Which facilitator

| | URL | API key | Notes |
|---|---|---|---|
| **x402.org** (default) | `https://x402.org/facilitator` | none | The SDK's own default. Verified reachable without a key on 2026-08-07: `GET /supported` returned 200 with `exact` + `eip155:84532` among its `kinds`. |
| **CDP** (Coinbase) | per CDP docs | yes → `X402_FACILITATOR_API_KEY` | Not exercised here. The auth header is sent as `Authorization: Bearer <key>` on `/verify`, `/settle`, and `/supported`. **Unverified until provisioned.** |

The wire either one must speak is the SDK's, not ours: `POST /verify` and
`POST /settle` with `{ x402Version, paymentPayload, paymentRequirements }`, and
`GET /supported`. We do not implement it — `@x402/core`'s own
`HTTPFacilitatorClient` does, including per-request deadlines and response
validation.

---

## 2. The payer's key — macOS Keychain

Only the **harness** ever holds a spending key, only for the length of one
signature, and never under an `X402_*` name (the server sweeps those and
refuses to boot). Add it yourself so it never passes through a transcript or
shell history — `-w` with no value prompts:

```sh
security add-generic-password -a "$USER" -s x402-payer-key -w
# (paste the key at the prompt; use -U to replace an existing entry)
```

Use a **throwaway wallet that holds only testnet funds**. Assume anything typed
into a shell is compromised.

Fund it with Base Sepolia USDC from Circle's faucet:
**<https://faucet.circle.com>** → select *Base Sepolia*. The token is
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals, so the tile price of
`500` atomic units is $0.0005. The gate wants roughly four calls' worth of
headroom.

The payer needs **no ETH**: `exact` on EVM is an EIP-3009
`transferWithAuthorization`, so the payer signs and the facilitator pays gas.

---

## 3. Prove it

```sh
npm run gate:settlement
```

It refuses before touching a key unless the challenge's own network is
`eip155:84532`, and it names the single missing input rather than "not
configured" — facilitator URL unset, stub still authorized, payTo malformed,
service unreachable, Keychain entry absent, wallet unfunded.

If everything is present it buys a tile with a real payment and proves four
properties: the receipt's transaction exists on chain and moved exactly the
manifest's price from the payer to the mount's payTo; every receipt field
matches the payment and the chain; the same paymentId replays byte-identically
without a second transfer; and a real payment for a tile that does not exist is
refused without settling.

The fifth property needs you, because only you can restart the service:

```sh
npm run service:restart
npm run service:health
npm run gate:settlement -- --phase2        # or … --phase2 <paymentId>
```

Evidence — transaction hashes, block numbers, decoded transfer values, ledger
counts — lands in `spectral-x402/evidence/` as JSON and markdown, and is meant
to be committed. It contains the payer's address (public, on chain anyway) and
no secrets.

`BASE_SEPOLIA_RPC_URL` overrides the default `https://sepolia.base.org`.

---

## Known gap — the 402 challenge is still ours, not the standard's

The **facilitator boundary** speaks standard x402 v2. The **challenge** does
not: our 402 body carries the manifest's flat vocabulary (`amountAtomic`, the
symbolic asset `"USDC"`, `resource`/`description` inside the requirement), and
the MCP spoke's `PaymentRequired` is standard-shaped but carries the symbol
rather than the contract address and an empty `extra`.

A conforming third-party client therefore cannot pay us unaided — it would have
no token contract and no EIP-712 domain to sign against. Our own harness bridges
this by translating the challenge with the same `toStandardRequirements` the
server uses, so what it signs is exactly what the server presents for
settlement.

Closing the gap means publishing standard-shaped requirements from both edges,
which changes the published 402 body and the MCP tool contract. That is a
manifest/spectral-config decision, not a kernel one, and is deliberately not
bundled with the settlement work.
