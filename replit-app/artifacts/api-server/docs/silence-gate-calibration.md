# Silence-gate calibration

Measured 2026-09-27 against the 8-shard seed corpus. Reproduce with:

```
pnpm --filter @workspace/api-server run test
# measurement table:
cd artifacts/api-server && npx vitest run src/lib/gate.calibration.test.ts --disable-console-intercept
```

## The gate

A shard may only be spoken if **both** hold (enforced server-side in
`src/lib/gate.ts`, never delegated to the model):

1. `min(raw query distance, best agent search-phrase distance) <= 0.45`
   (normalized SimHash-128 Hamming), and
2. the **raw user query** shares **≥ 2 content tokens** with the shard's
   retrieval text (`search_text` = concept + synopsis, the exact string the
   fingerprint is derived from).

Why two conditions: SimHash-128 alone cannot separate related from unrelated
short queries — measured, "what is quantum mechanics" lands at **0.406** of
Insulin Therapy, *below* the 0.45 threshold, purely by chance. But chance
near-misses share no tokens with the shard; the lexical check vetoes them.
Conversely, valid paraphrases can exceed 0.45 on raw distance (measured up to
0.516) — the agent's reformulated search phrases close that gap via the
min-distance rule.

Why overlap reads only the raw query: agent search phrases are model output.
If overlap credited them, a fooled model could launder an unrelated query
into a pass by searching vault vocabulary (e.g. "insulin therapy" for a
quantum-mechanics question), manufacturing both a low credited distance and
token overlap. Anchoring overlap to the user's own words keeps the lexical
veto independent of model behavior. This attack is covered by the test
"the gate still vetoes when a fooled model searches vault vocabulary".

Known remaining gap (tracked as follow-up): medical near-neighbor queries
that genuinely share vault vocabulary — e.g. "best treatment for diabetes
insipidus" (0.391, 2 shared tokens vs T2D) — pass both checks; the model's
intent judgment is the only layer that catches those today.

## Measured battery (raw distance / credited distance / raw shared tokens / verdict)

| Query | Expected shard | Raw | Credited | Shared | Gate |
|---|---|---|---|---|---|
| what are the signs of diabetic ketoacidosis | DKA | 0.383 | 0.320 | 4 | ALLOW |
| my blood sugar keeps dropping and I feel shaky and sweaty | Hypoglycemia | 0.414 | 0.344 | 4 | ALLOW |
| how is type 1 diabetes treated | T1D | 0.367 | 0.328 | 3 | ALLOW |
| what is the difference between basal and bolus insulin | Insulin Therapy | 0.516 | 0.414 | 3 | ALLOW |
| someone collapsed and has no pulse what do I do | CPR | 0.359 | 0.328 | 3 | ALLOW |
| face drooping and slurred speech | Stroke | 0.516 | 0.406 | 5 | ALLOW |
| severe allergic reaction to a bee sting, throat is swelling | Anaphylaxis | 0.305 | 0.305 | 10 | ALLOW |
| first line medication for type 2 diabetes | T2D | 0.375 | 0.375 | 3 | ALLOW |
| should I not give aspirin during a stroke | Stroke | 0.383 | 0.383 | 2 | ALLOW |
| is aspirin contraindicated in stroke | Stroke | 0.383 | 0.375 | 2 | ALLOW |
| insulin should never be stopped in type 1 diabetes | T1D | 0.430 | 0.391 | 4 | ALLOW |
| what is quantum mechanics | (silence) | 0.406 | — | 0 | VETO(overlap) |
| who won the world cup in 1998 | (silence) | 0.445 | — | 0 | VETO(overlap) |
| what is the capital of France | (silence) | 0.414 | — | 0 | VETO(overlap) |
| how do I bake sourdough bread | (silence) | 0.461 | — | 0 | VETO(overlap) |
| explain photosynthesis | (silence) | 0.492 | — | 0 | VETO(overlap) |
| best treatment for a sprained ankle | (silence) | 0.430 | — | 0 | VETO(overlap) |
| how to change a car tire | (silence) | 0.438 | — | 0 | VETO(overlap) |

Credited distances use one realistic agent search phrase per in-scope query
(e.g. "insulin therapy basal bolus dosing"); the live agent may search more
than once and takes the min. Shared tokens are raw-query-only.

## Separation summary

- Max in-scope credited distance: **0.414** (threshold 0.45 → margin 0.036)
- Min unrelated distance: **0.406** — below threshold, so distance alone does
  **not** separate; this is exactly the accident class the overlap check exists for.
- Max unrelated shared tokens: **0** (bar is 2 → margin 2 tokens)
- Min in-scope shared tokens: **2** (the two aspirin/stroke negation queries)

## Negation preservation

`not`, `no`, `never`, `avoid`, `contraindicated` are excluded from the
stopword list (`NEGATION_TERMS` in `src/lib/simhash.ts`). Before this change,
"should NOT give aspirin" fingerprinted identically to "should give aspirin".
Measured now: the pair differs by ≥ 8 of 128 bits (see
`src/lib/simhash.test.ts`). Negated in-scope queries are *answered* — the
negation guidance lives in the verified shard text ("Do not give aspirin if
hemorrhagic stroke suspected"), so reaching the Stroke shard is the correct
outcome.

## Rules for changing the gate

- Never change `SILENCE_THRESHOLD` or `MIN_SHARED_TOKENS` without re-running
  the calibration test; it enforces these margins and fails loudly.
- The fingerprint and the overlap check must always tokenize the same string
  (`search_text`). Do not fingerprint one representation and overlap-check
  another.
- The overlap check must stay grounded in the raw user query. Crediting
  model-generated search phrases in the overlap check reopens the
  fooled-model laundering attack.
- Seeding tests run against a scratch table (`seed_test_scratch`), never the
  live shards table — keep it that way.
- When adding shards (uploads), ensure their retrieval text is keyword-rich;
  the calibration battery must stay green.
