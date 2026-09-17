# Release 1 — waived gate items (P4) — TEST FIXTURE

This is the deploy suite's stand-in for the real signed ledger at
`docs/ops/release-1-waivers.md`. `gremion-deploy` step 2 refuses a release tree
that carries no ledger, so every fixture release tree needs one; the deploy
suite shims `gremion-verify`, so nothing here parses these rows. The shape is
kept honest anyway — `infra/host/lib/common.sh` owns the real pattern, and a
fixture that did not match it would be a misleading example.

| Waiver id | §L item | Gate | What is waived | Why it cannot be proven at release 1 | Lifted by |
|---|---|---|---|---|---|
| `fixture-waiver` | §L:1 | G1-LEGAL | nothing real — this is a test fixture | the deploy suite needs a present, well-shaped ledger, not a true one | never; it is not a release tree |
