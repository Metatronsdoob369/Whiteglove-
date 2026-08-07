# evidence/

Where `npm run gate:settlement` writes what it proved.

Each run leaves `settlement-gate-<timestamp>.json` and the same content as
`.md`: the five properties, pass or fail, with the transaction hashes, block
numbers, chain-log values, and ledger counts the verdict rests on. Phase 1 also
leaves `settlement-gate-phase1.json`, which is the input `--phase2` reads to
assert that a purchase survived a service restart.

These files are committable and are meant to be committed — a settlement gate
whose evidence lives only in a terminal scrollback proves nothing a month later.

They contain no secrets. The payer's private key is held in the harness process
for the duration of one signature and appears in no file it writes; the payer
ADDRESS does appear, and is public — it is on chain either way.
