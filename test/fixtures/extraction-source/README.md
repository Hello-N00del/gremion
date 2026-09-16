# extraction-source fixtures

Two minimal `module.json` files carrying the one key `B00-extraction-source-freeze`
owns: `extractionSource`. They are deliberately NOT full module manifests — the
`module.json` schema belongs to `D2-module-json-and-dist-schema`, and duplicating
it here would fork it.

`agree/` is what `make lint-extraction-source` runs against, so the agreement
half of the guard is exercised on every lint rather than only inside the suite.
The RED case is produced by editing one of these files in a scratch worktree
(see the unit plan); it is never committed in a disagreeing state.
