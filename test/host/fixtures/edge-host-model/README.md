# edge-host-model RED fixtures (TASK-041)

Each directory is a miniature repository tree that `scripts/check-edge-host-model.test.mjs`
scans with the real rule table. Every file here exists to VIOLATE one rule (or, for
`r1-pinned`, to prove the two pinned `internaltest` routers stay GREEN), so the whole
directory is exempt from the real-tree scan. Nothing here is deployed or rendered.

| Directory | Rule | Expected |
|---|---|---|
| r1-websecure | R1 | RED: a wildcard leg on a websecure compose router |
| r1-file-provider | R1 | RED: a wildcard leg in a file-provider `rule:` |
| r1-unlisted-internaltest | R1 | RED: an internaltest router nobody pinned |
| r1-widened | R1 | RED: a pinned router that also listens on websecure |
| r1-pinned | R1 | GREEN: exactly the two pinned internaltest routers |
| r1-no-rules | R1 | vacuous: files in scope, no router rule parsed |
| r1-unparseable | R1 | RED: a file in scope that cannot be parsed is never a pass |
| r2a | R2a | RED: the wildcard env key assigned |
| r2b | R2b | RED: the wildcard env key named in operator docs |
| r3 | R3 | RED: the apex host-injection middleware |
| r4 | R4 | RED: the leftmost-label resolver named in docs |
