# Shell port list (TASK-206)

The product-ahead shared-shell work ported from the product source into the
kernel as named ports (D R23-15). Source: tag `extraction-source-f2`
(`d0c656d0`). Every row carries its source SHA(s), a guard, the RED it showed
on the kernel base (or the re-break RED for code already present), the GREEN,
and the port-back check (`make lint-port-back`).

Nothing here was produced by regenerating or re-carving the kernel from the
source: each file is ported by hunk from `git show d0c656d0:<path>`, kernel-ahead
lines kept.

Status vocabulary: `ported` (source bytes), `adapted` (source hunks with a named
kernel change), `present@<sha>`, `superseded->TASK-nnn`, `N/A: <reason>`,
`via TASK-205`, `found -> TASK-011 harvest`.

## Item 0: seams (subtask 206-0)

Kernel base: `merge/r28-train5` (`d3f8ad62`, TASK-042-b present).
Port-back: `make lint-port-back` green before and after (41 entries intact).

| Source SHA | File / hunk | Status | Guard | RED on base | GREEN |
|---|---|---|---|---|---|
| 3661bb6c | `lib/server/modules/runtime-registry.ts` section 8 (`DecisionRuleContext`, `DecisionRuleStrategy`, `CORE_DECISION_RULE_IDS`, `ReservedDecisionRuleIdError`, `registerDecisionRule`, `getModuleDecisionRule`) | ported | `lib/server/governance/decision-rule.test.ts` | `TypeError: registerDecisionRule is not a function`; `TypeError: evaluateDecisionRule is not a function` (5 of 10 failed) | 10/10 |
| 3661bb6c | `lib/server/governance/decision-rule.ts` (registry, `consent`, `support_threshold`, fail-closed `UnknownDecisionRuleError`) | adapted: header comment de-branded; review round 1 adds `InvalidDecisionRuleTallyError` (every tally count a non-negative safe integer, checked before any strategy runs) and keeps `evaluateMajority`'s pre-port verdict (`false`) for rules outside simple/two_thirds/absolute until item 1a threads `consent`/`support_threshold` params through adoption | same; re-break (a): unknown id falls back to `simple` | re-break: `unknown rule id: throws a typed error, never falls back to simple` FAIL (1 of 10); review cases RED before the fix: 7 tally/zero-support cases FAIL, `consent -> false`, `support_threshold -> false`, `bogus -> false` FAIL | 20/20 |
| 3661bb6c | `lib/governance/support-threshold.ts` | adapted: header comment de-branded; threshold never below 1 (an empty body or a vanishing fraction must not adopt on zero support; review round 1). Dependency of the registry's `support_threshold`; item 1a's parity test lands with `compute-result.ts` | `decision-rule.test.ts` support_threshold cases + `support_threshold never adopts with zero yes votes` | `evaluateDecisionRule is not a function`; review case FAIL before the clamp | green |
| 87797e42 | `lib/server/governance/second-locus.ts` + test; registry section 9 (`SecondLocus*`, `registerSecondLocusStrategy`, `getModuleSecondLocusStrategy`) | ported (header comment de-branded) | `lib/server/governance/second-locus.test.ts`; re-break (a2): unknown id returns a permissive default | `Failed to resolve import "./second-locus"`; re-break: 2 of 6 FAIL (`unknown strategy id: throws a typed error, never a permissive fallback`) | 6/6 |
| 74ae2780 | registry section 7 (`RoleGroupGrantResolver`, `registerRoleGroupGrantResolver`, `resolveRoleGroupGrants`) + reset hunk | adapted: review round 1 drops (and logs) grant names that are empty, whitespace-padded or contain `/` | `lib/server/modules/runtime-registry.role-group.test.ts` (union/dedupe, name filter, reset of resolvers + module decision rules) | `drops (and reports) names that are not plain group names` FAIL before the filter; re-break: delete `_roleGroupGrantResolvers.length = 0` -> `_resetRuntimeRegistryForTests clears resolvers and module decision rules` FAIL | 4/4 |
| 8dfc05cc, 22562052, 9e3ae587 (f2 bytes) | `DataProviderContract` keys `finance:org-unit-refs`, `finance:handover-retention`, `finance:handover-facts`, `messages:unread-rooms`; `HandoverFinanceFactsCore`; `DashApprovalsContext.financeRoleLabels?` | adapted (kernel keeps `finance:dashboard-summary` + `DashBudgetSummary`, absent at f2) | `lib/server/modules/runtime-registry.contract-keys.test.ts` (`satisfies readonly (keyof DataProviderContract)[]`); re-break (a3): drop `finance:handover-facts` | on base: the four keys are absent from `DataProviderContract` (type-level guard; the vitest half passes on any Map, so the RED is the svelte-check one); re-break: `svelte-check` 4 ERRORS, `Type '"finance:handover-facts"' is not assignable to type 'keyof DataProviderContract'` | svelte-check 0 errors; 2/2 |
| 87797e42 | `lib/server/tenant/role-vocabulary.ts` (`DEFAULT_FINANCE_ROLE_LABELS`, `financeRoleLabelsForTenant`) + `role-vocabulary.finance.test.ts`; `lib/server/config.ts` `financeRoles` hunks (type, zod schema, update merge) only | ported (test: one conditional `expect` made unconditional for the lint ratchet) | `lib/server/tenant/role-vocabulary.finance.test.ts` | `TypeError: financeRoleLabelsForTenant is not a function`; `configUpdateSchema (strict) knows the financeRoles key` FAIL (7 of 8 failed; the 8th is green on base) | 8/8 |
| b6f30127 (e097c198, 85b57b0; f2 bytes) | `lib/server/events/consumer-state.ts` | adapted: kernel shell port (Q11, R28-O2); review round 1: each restart carries a token so a cancelled one never runs, `markWorkerRunning`/`markWorkerOff` cancel the pending restart, a fault on a worker that is not running arms no second restart, and mid-life restarts are finite (`MAX_START_ATTEMPTS`) | `lib/server/events/consumer-state.test.ts` | `Failed to resolve import "./consumer-state"`; review cases: 4 FAIL before the fix | 13/13 |
| b6f30127 | `consumer-state.test.ts` describe "the audit consumers under a rejecting broker" | via TASK-205 (imports `calendar-/content-/newsletter-audit-consumer`, which TASK-205 keeps, R28-O2) | lands with the consumers | n/a | n/a |
| b6f30127 | `lib/server/events/nats-topology-wiring.test.ts` | via TASK-205 (every case imports an audit consumer absent from the kernel; R28-O2 assigns the file to 206-0, so it is a named residual until the consumers land) | n/a | n/a | n/a |

Named exception: `lib/server/events/consumer-state.ts` is a kernel shell port,
an exception to the source carve rule `product-module-server-lib`. Modules import
it (module -> kernel is the allowed direction); the landed content module
already does (`modules/content/app/lib/server/content/register.server.ts:14`).

Closes the residual "kernel runtime-registry.ts lacks the product's finance
provider keys".

Item-0 residuals (named, not silently covered):

- `registerSecondLocusStrategy` replaces a strategy registered under the same
  id (source semantics: a module re-import is a no-op). A later module could
  swap a stricter strategy for a permissive one; the kernel registers none
  today. Owner: TASK-205 (finance registers `vier-augen`).
- The role-group grant seam keys on the role's display name, and the kernel
  does not restrict which flat groups a module may name (beyond the name
  filter). Wiring it into the role-assign route is item 1c; an allow-list per
  module is a follow-up for the ledger.
- `consumer-state` has no reader in the kernel yet: `/api/health` `degraded`
  and the relay are item 5 (206-B). Until then a worker state is recorded but
  not reported.

## Item 3: tenancy custom domains (subtask 206-A)

All present on the base; no source edit. Guards proven by re-break (Q1),
integration cases against a scratch `postgres:18-alpine` (migrated with
`pnpm run migrate:test-fixture`, torn down by name).

| Source SHA | Disposition | Status | Guard | RED (re-break) | GREEN |
|---|---|---|---|---|---|
| 8f49dcaa | leaf callback resolves its tenant by id | present@6edb5b8c | `lib/server/tenant/*` resolver tests (TASK-025) | n/a (Q1: presence by commit) | green |
| a972ed64 | cache write discarded when an eviction raced it | present (`tenant/registry.ts:293` `_evictionEpoch`, captured `:342`) | `tenant/registry.cache.test.ts` | n/a | 18/18 |
| 8649555a (kernel) | per-tenant rate-limit bucket evicted with the tenant | present@8649555a | `tenant/registry.evict-parity.integration.test.ts` (the brief named `registry.cache.test.ts`, which does not catch it) | re-break (n): `evictTenantRateLimit` call removed at `registry.ts:546` -> `drops the per-tenant rate-limit bucket, so a re-registered id starts fresh` FAIL (1 of 2) | 2/2 |
| 1da39600 | cross-tenant Vaultwarden host collision | superseded (Q6: reserved-host refusal + `tenant_domain` PK; emitter TASK-034, TRD-263) | TRD-074 row below | see below | green |
| d1f670c4 | test-smtp internal-target block | present (`routes/api/setup/test-smtp/+server.ts:51` `BLOCKED_HOST_NAMES`, `:64` suffixes, `:175` `isBlockedIpv4Bytes`); element-call half via TASK-205 | `routes/api/setup/test-smtp/server.test.ts` | see e0bc11fa | 54/54 |
| e0bc11fa | test-smtp canonical bytes + resolve-once | present (`+server.ts:39`, `:103` canonicalisation; `:351` connect to the vetted address, name only as TLS servername `:444`); helios-client + element-call via TASK-205 | `routes/api/setup/test-smtp/server.test.ts` | re-break: `connectHost: name` at `:351` -> 3 FAIL (`hands nodemailer the RESOLVED IP with the hostname as TLS servername`, `never hands nodemailer a name on ANY allowed branch`, ...) | 54/54 |
| a29347f0 | five audit fixes | -> item 2 rows | | | |
| 9e1cf8ef | test-smtp ClientAddress / `client-ip.ts` | via TASK-205 (its Q6; Q10) | | | |
| TRD-074 | one domain, one tenant | present@913f1990 (TASK-025) | `tenant/registry.domain.integration.test.ts:249` describe "tenant_domain PK constraint (TRD-074)" | re-break (j): `ALTER TABLE tenant_domain DROP CONSTRAINT tenant_domain_pkey` in the scratch control DB -> FAIL `PostgresError: there is no unique or exclusion constraint matching the ON CONFLICT specification` (1 of 1 selected); PK restored | 25/25 |

## Item 4: T07 grant fixes (subtask 206-A)

| Source SHA | Disposition | Status | Guard | RED | GREEN |
|---|---|---|---|---|---|
| 09be6d83, 61683d99, 75cffdef | `migrations/055`, `058` bytes | present@TASK-018 (kernel bytes win, D R23-16a) | `fresh-init-proof.sh` exact-set grant block (TASK-054) | n/a (present) | green |
| 09be6d83, 75cffdef | `FleetFailureKind` in `tenant/fleet.ts` (outcome `kind`, classified ledger/outcome string) + `tenant/readiness.ts` (`kind` on the entry, `getTenantReadinessFailureKind`) | adapted (fleet: kernel comment wording from TASK-042-b kept; readiness: f2 bytes) | `tenant/fleet.test.ts` (3 T07 cases), `tenant/readiness.test.ts` (3 T07 cases; test fixtures drop `matrix_homeserver`, absent in the kernel) | fleet 3 of 12 FAIL (`classifies the outcome and the ledgered error: brand-identity vs migration`, ...); readiness 3 of 13 FAIL (`a freshly provisioned un-materialized tenant fails with the BRAND-IDENTITY class, not the migration class`, ...); re-break (k): drop `kind = 'brand-identity'` -> 2 FAIL | tenant 40 files / 535 tests |
| 61683d99, 75cffdef | `scripts/verify-fresh-install-grants.sh` reader login over SCRAM + wrong password refused | adapted into `gremion-ui/scripts/fresh-init-proof.sh` (G7): container initdb `--auth-host=scram-sha-256`, `log_error_verbosity=verbose`, real TCP login as `gremion_public_reader` | the script's own post-conditions | before the initdb change: `FAIL reader login: a WRONG password connected as gremion_public_reader (the probe path is not authenticating)`, `[fresh-init] FAILED` | `ok reader login: a wrong password is refused (28P01)`, `ok reader login: gremion_public_reader logs in over SCRAM and reads protocols`, `[fresh-init] all post-conditions hold` |
| 09be6d83, 61683d99 | `k8s/base/postgres/configmap.yaml` | N/A (Q5, D R19-D16) | | | |
| 61683d99 | `docker/postgres/init-databases.sh`, `test/init-databases-role.bats` | N/A: kernel ahead, kept (fail-closed init) | | | |

## Item 2: SSRF and security hardening (subtask 206-A; gremion-ui hooks are 206-B)

| Source SHA | Disposition | Status | Guard | RED | GREEN |
|---|---|---|---|---|---|
| a29347f0, 3657370c (#458-2) | `routes/protocols/+page.server.ts` log-before-degrade | adapted onto the kernel segment `routes/protokolle/+page.server.ts` (log tag `[protokolle]`; summary only, never the raw error) | `routes/protokolle/page.server.test.ts` (source test, path/tag adapted) | on base: `× logs at ERROR level — with the route, the message and the code — before degrading`, `× does NOT log the raw error object — postgres.js carries query + parameters` (2 of 4 failed); re-break (g) is the base code | 11/11 (`routes/protokolle`) |
| a88f00c9, 3657370c (#459-4) | portal image model | N/A: OPEN at source (Q13); record ported to `docs/security/portal-image-model-open-decision.md` with kernel anchors re-measured; no `img-src` edit | the non-image guards below | | |
| a29347f0 (the brief's 895f736 is a blob id) | `gremion-public/src/hooks.server.test.ts` | adapted (G5): the kernel's header hook is `securityHeadersHandle`; the "keeps Google Fonts reachable" case is dropped (kernel self-hosts fonts, pinned the other way by `lib/test/csp-no-third-party-fonts.test.ts`) | itself | mutation: drop `X-Content-Type-Options: nosniff` -> `× sets the CSP and the anti-framing headers on a text/html response` (1 of 8) | 8/8 |
| a29347f0 (the brief's 09b6128 is a blob id) | `gremion-public/src/lib/sanitize.test.ts` | ported (G5; one comment line adapted: the kernel portal has no `/aktuelles`); `sanitize.ts` byte-equal to the source (blob 6fc897c) | itself | mutation: allow `script`/`iframe` + `on*` attributes -> 3 of 11 FAIL (`strips a <script> element, tag and payload alike`, ...) | 11/11; gremion-public 15 files / 187 tests |
| a29347f0, 3657370c | gremion-public nosniff + Referrer-Policy | present (`gremion-public/src/hooks.server.ts:53-54`) | `hooks.server.test.ts` | as above | green |
| 5f47943c | gremion-ui nosniff + Referrer-Policy | 206-B (G0, after TASK-205) | | | |
| a29347f0 (#459-2) | rate-limit bucket eviction | present@8649555a (item 3 row, guard (n)) | | | |
| a29347f0 (#434-6) | `gremion-public/src/lib/server/mail.ts` | N/A: no such file in the kernel portal | | | |
| a29347f0 | messages `service-client` | via TASK-205 | | | |

## Item 1a: Governance Phase 2 (subtask 206-A)

Ported by hunk from `git show 3661bb6c` (not from f2 whole files, which also
carry Phase 3); 87797e42's kernel half is item 0.

| Source SHA | Disposition | Status | Guard | RED | GREEN |
|---|---|---|---|---|---|
| 3661bb6c | `lib/governance/compute-result.ts` (null tally -> `null`, `consent`, `support_threshold` via the shared `supportThreshold`) + test; `support-threshold-parity.test.ts` | ported | `compute-result.test.ts`, `support-threshold-parity.test.ts`; re-break (b) drop the null-tally early return -> `× null tallies (acclamation / no-tally rows): NO computed verdict`; (b2) bare `Math.ceil` -> `× support_threshold: IEEE-754 noise does NOT wrongly reject an exactly-at-quorum tally` (compute-result and decision-rule) | on base: part of the 28 failures below | green |
| 3661bb6c | `lib/server/governance/resolution-decision.ts` (tally / acclamation inputs, delegation to the registry), `lib/server/governance/protocols-db.ts`, `lib/server/protocols/protocol-db.ts` (nullable tallies, `adoption_mode`, `decision_rule_params`) | ported (two hunks re-applied by hand: the kernel dropped a comment prefix) | `routes/api/protocols/[id]/resolutions/resolutions.test.ts` (new), `resolution-decision.integration.test.ts`, `resolution-adoption.integration.test.ts` | unit on base: 28 FAIL across 3 files, e.g. `(a) without adoption_mode defaults to tally: server computes the result from rule + tallies`, `(b) free-hand result 'passed' in tally mode → 400, nothing persisted`, `expected undefined to be 'acclamation'` | unit 28 files / 213 tests; integration 3 files / 27 tests (scratch PG18) |
| 3661bb6c | adoption-mode routes `routes/api/protocols/[id]/resolutions/+server.ts`, `[resId]/+server.ts` | ported (G1) | `resolutions.test.ts` | as above | green |
| 3661bb6c | `publish.test.ts` acclamation x quorum cases | ported (one hunk by hand) | itself | pinning cases, green on base | 17/17 |
| 3661bb6c (054 schema) | `resolution-adoption-mode.integration.test.ts` (a)-(f) | ported; present-schema guard (Q1); `expect.hasAssertions()` added in (a)/(d) for the lint ratchet (their assertions live in a helper) | itself | re-break (p): drop `protocol_resolutions_votes_mode_check` in the scratch DB -> `× (a) tally with any vote tally NULL raises 23514`, `× (d) acclamation with exactly one or two tallies set raises 23514`; CHECK restored | 6/6 |
| 3661bb6c | `routes/beschluesse/+page.svelte` (acclamation pill, null tally never "einstimmig") | ported (clean hunk); K1 NOT applied: 7f45643 is not reachable from this checkout | svelte-check | `'b.votesYes' is possibly 'null'` after the type change | 0 errors |
| 3661bb6c | `lib/components/protocols/ResolutionRow.svelte` + `ResolutionRow.test.ts`, `resolution-row-tally.test.ts`, editor page `members/committees/[id]/protokolle/[protocolId]/+page.svelte` | STOPPED (brief: the row binds nullable numbers to `Input`, which needs the not-taken `lib/components/ui/input/input.svelte` hunk -> TASK-165). Kernel-side adaptation only: the row labels all five rules and shows "nicht berechenbar" when `computeResult` is `null` | svelte-check | 3 errors after the type change (`Record<MajorityRule, string>` missing keys; `null` as index) | 0 errors |
| 3661bb6c | `input.svelte` | not taken (TASK-165) | | | |
| 3661bb6c | `packages/db/src/types.ts` | present (`adoption_mode` :87, `decision_rule_params` :90) | | | |
| 87797e42 | finance `vier-augen-strategy`, `approval-workflow`, finance `register.server.ts`/labels, `finance/{approvals,finanzordnung}` | via TASK-205 | | | |
| 87797e42 | `routes/+page.server.ts` (dashboard), `routes/api/notifications/+server.ts` financeRoleLabels hunks | found -> TASK-011 harvest (no notifications route in the kernel) | | | |

## Items 1c + 1b: role-group reconcile and Governance Phase 3 (subtask 206-A)

One commit: 29b70d92's revoke route imports the reconcile module (ea2211ae,
ee4310f0 are its ancestors), so 1c lands with 1b. New files take their f2
bytes (the tests at 29b70d92 predate the f2 "adopted only" filing rule and fail
against the f2 source).

| Source SHA | Disposition | Status | Guard | RED | GREEN |
|---|---|---|---|---|---|
| ea2211ae, ee4310f0, 74ae2780 | `lib/server/governance/role-group-reconcile.ts` (against item 0's `resolveRoleGroupGrants`), `governance-db.ts` `listAllRoleNames` / `listActiveRoleNamesForUser`, assign route reconcile (G1) | ported (the source's dead `updateRole`/`deleteRole`/`updateAssignmentStatus`, absent in the kernel, are not re-added) | `role-group-reconcile.test.ts`, `assign.reconcile.test.ts`, `revoke.reconcile.test.ts`, `governance-db.integration.test.ts` (list cases) | `Failed to resolve import "./role-group-reconcile"`; assign: 4 FAIL (`(a) assign grants the mapped groups to the incoming holder`, ...); re-break (e) reconcile add-only -> 4 FAIL incl. `(b) unassign: reassigning to a new holder removes groups the outgoing holder can no longer derive` | green |
| ea2211ae, ee4310f0 | the three reconcile tests | adapted: `financeFlatGroupsForRole` / `FINANCE_GROUPS` (finance module) replaced by an in-test stub resolver with the same role -> group data; TASK-205's finance lane keeps the real mapping | | | |
| 29b70d92 | `lib/server/governance/resolution-challenges-db.ts`, challenge routes `api/protocols/resolutions/[resId]/challenges/**` | ported (G1) | `challenges.test.ts` (401/201/400/409/403/404), `resolution-challenges-audit.integration.test.ts`, `resolution-challenges.integration.test.ts` (present-schema, Q1), `protocols-db.beschluesse-challenges.integration.test.ts` | `Failed to resolve import "./+server"`; re-break (c) drop `resolution_challenges_one_open_per_challenger` -> `× (1b) a second open challenge by the same user is refused (duplicate-open) and leaves no extra audit row`, `× (e) rejects a second OPEN challenge ...`; (c2) audit write outside the tx -> `× (3) an injected post-INSERT failure inside the FILING tx persists NEITHER the challenge row NOR the audit row` | green |
| 29b70d92 | `governance-db.ts` `ArchiveReason` + `'recalled'`, `UnarchivableAssignmentError`, `archiveAssignment(…, tx)`, `revokeMandate` (same-tx `mandate.revoked`); `POST /api/governance/committees/{id}/roles/{roleId}/revoke` (CouncilAdmin) | ported (G1) | `revoke.reconcile.test.ts`, `revoke-mandate.integration.test.ts` (adapted: the kernel lane's `TRUNCATE org_units ... CASCADE` isolation added) | `Failed to resolve import "$lib/server/governance/role-group-reconcile"`; re-break (d) drop the CouncilAdmin check -> `× (b) non-admin → 403 and nothing is revoked` | green |
| 29b70d92 | `contracts/kernel/openapi.governance.json` revoke op; 1.0.0 -> 1.1.0 (Q7) + G10 regen `kernel-governance-client.ts` | ported (the four `/api/users*` paths stay out, open-core §5) | `codegen-drift.test.ts`, `contracts-real-specs.test.ts`, `contracts:check` | spec bump before regen: `× the committed kernel-governance-client.ts matches what the governance spec generates today`; re-break (f) route removed with the op present -> `× spec inventory === kernel route inventory (both directions)` | `contracts:check` OK (6 specs); generated-clients 238/239 (the one failure, `oasdiff-gate.test.ts` "remove optional response property with NO bump: FAILS", is red on the base too) |
| 29b70d92 | `lib/governance/challenge-form.ts`, `recall-action.ts` + tests | ported (challenge-form test: conditional expects rewritten as whole-object `toEqual`, lint ratchet) | themselves | `Failed to resolve import "./challenge-form"` / `"./recall-action"` | 33/33 (`lib/governance`) |
| 29b70d92 (+ #439, f2 `routes/resolutions`) | `/beschluesse` challenge form, open-challenge badge, admin disposition; `+page.server.ts` admin-gated challenge rows, both loads log a summary before degrading | adapted onto the kernel segment `beschluesse` (script hunk re-applied by hand); the f2 `resolutions-page.test.ts` ported as `beschluesse-page.test.ts` (load result narrowed once for the kernel's generated type) | `beschluesse-page.test.ts` | `× #439: a failing challenge query degrades to empty for an admin, and is logged`, `× #439: a failing register query degrades to empty, and is logged` | 8/8; svelte-check 0 errors |
| 29b70d92 | recall action on `members/committees/[id]/+page.svelte` | ported (clean hunk; byte-equal to f2) | `recall-action.test.ts`; svelte-check | | green |
| 29b70d92 | `gremion-public` (`stura-public` at the source) `/beschluesse` register, `public-db.ts`, `packages/db/src/public-types.ts` | superseded -> TASK-145 (Q8) | | | |
| 29b70d92 | migrations 055, 056 | present@TASK-018 / TASK-029 | | | |

K1: the kernel `beschluesse/+page.svelte` no longer imports `$app/stores`
(drift from the brief), so nothing of 7f45643 applies there; 7f45643 itself is
not reachable from this checkout, so the committees page hunk is ported without
it. New UI code imports only `$app/navigation` (`invalidateAll`). The UI strings
are literal German like the surrounding kernel pages, so no G8 message keys were
added.

## Boundary scan (brief §6.15, subtask 206-A)

| Source | Disposition | Status | Guard | RED | GREEN |
|---|---|---|---|---|---|
| (kernel guard, no source SHA) | tracked `gremion-ui/src` files never import repo-root `modules/**`, `$lib/server/finance/**`, or a `$lib` path that exists only under a `modules/*/app` overlay (the boundary suite's own string fixtures exempt) | new | `lib/server/boundary/kernel-module-imports.test.ts` (seeded cases per rule) | re-break (s): a kernel file importing `../../../../../modules/content/app/...` -> `× no tracked gremion-ui/src file imports modules/** ...` | 6/6; boundary 12 files / 57 tests |

## 206-A self-review round 1 (fixes, test first)

| Finding | Fix | Guard | RED before the fix | GREEN |
|---|---|---|---|---|
| HIGH: the protocol editor PATCHed the whole row, `result` included, and the Phase-2 route refuses a free-hand result, so every edit failed | `lib/governance/resolution-patch-body.ts` (the f2 editor's request shaping, extracted) used by `members/committees/[id]/protokolle/[protocolId]/+page.svelte` (script only; the ResolutionRow markup port stays STOPPED) | `lib/governance/resolution-patch-body.test.ts` | `Failed to resolve import "./resolution-patch-body"` | 4/4 |
| HIGH: revoke returned a plain 200 when the Keycloak group cleanup failed after the recall was recorded | the route answers `{ success: true, groupsReconciled }` and logs a summary; the recall dialog warns when `false`; reason capped at 4000 characters; contract 1.1.0's revoke op documents both (G10 regen in the same commit) | `revoke.reconcile.test.ts` (f), (f2) | `× (f) a Keycloak failure during reconcile keeps the recall but reports groupsReconciled: false and logs`, `× (f2) a clean reconcile reports groupsReconciled: true` | 7/7 |
| MEDIUM: any session (a guest too) could file a challenge | POST requires `Role.Member` (hierarchy: CouncilAdmin, ITAdmin included) | `challenges.test.ts` (a2) | `× (a2) a guest → 403, service never called`, `× (a2) a session without roles → 403 ...` | 16/16 |
| MEDIUM: reconcile removals looked ids up in the realm group list and skipped a missing one silently; adds ran first | removals first, by the user's own group ids; every step runs; an incomplete reconcile throws (callers log it; revoke reports it) | `role-group-reconcile.test.ts` (3 cases) | `× removes a held group by its own id even when the realm list omits it, removals first`, `× an add whose group does not exist makes the reconcile throw`, `× a failing removal does not stop the others ...` | 10/10 |
| MEDIUM: the boundary scan missed relative climbs into `src/lib/server/finance` or overlay-only paths | relative specifiers that land in `src/lib` get the same finance / overlay judgement as `$lib/…` | `kernel-module-imports.test.ts` (2 seeded cases) | `× fires on a planted import: import { x } from '../finance/officer-groups'`, `× ... '../overlay-only/thing'` | 8/8 |

206-A residuals (named, not fixed here):

- Resolution PATCH/DELETE carry no publish lock: an adopted resolution can be
  edited or deleted (the source's #433 atomic lock, 1e460946, is not in the
  kernel and was not before this port; deleting cascades its challenges).
  found -> TASK-011 harvest.
- An acclamation row may store an informational tally that contradicts the
  declared outcome (source behaviour; the chair's declaration is the authority).
- Revoke reads the assignment outside the recall transaction (a concurrent
  assign/revoke can double-archive); neither revoke nor assign checks that
  `roleId` belongs to the path's committee (assign predates this port).
- The assign route and the reconcile still log raw Keycloak error objects.
- UI fetch handlers wrap `invalidateAll()` in the same catch as the request, so
  a refresh failure after a successful write reads as a failed write.
- ResolutionRow keeps its three-rule local type and shows empty tallies for an
  acclamation row until the row UI port (TASK-165 dependency).
- `lib/server/boundary/kernel-module-imports.test.ts` sits outside the unit's
  owned paths (the brief's §6.15 names the guard and the scoped gate runs
  `src/lib/server/boundary`); `fresh-init-proof.sh`'s `docker run` line changed
  with the reader-login block because the probe is meaningless without it (G7).
- K1 reactivity test (§6.14) and the kit-3 scan scripts are not run: 7f45643
  is not reachable and 205's scan is not on the base; a manual scan of the 58
  touched `gremion-ui/src` files found no `$app/stores`, `$app/paths`,
  `$env/dynamic`, `$:` or absolute redirect.


## 206-A self-review round 2

| Finding | Fix | Guard | RED before the fix | GREEN |
|---|---|---|---|---|
| MEDIUM: assign still only logged a failed reconcile (incl. the outgoing holder's removal) and answered a plain 201 | assign answers `groupsReconciled` like revoke and logs a summary; the contract's assign 201 documents the optional field (G10 regen) | `assign.reconcile.test.ts` (a0), (e) | `× (a0) a clean reconcile reports groupsReconciled: true`, `× (e) a Keycloak failure during reconcile is swallowed — the assignment still succeeds` (flag assertion) | 6/6 |

Round-2 residuals (LOW, not fixed): a vote edit on a withdrawn tally row is
dropped (the patch body sends none for 'withdrawn'); clearing one of three
acclamation counts keeps the stored counts instead of a 400; `/beschluesse`
shows the challenge form to guests, who get a 403 on submit (no member flag in
the page data); the revoke `reason` bound (4000) is only in the contract's
description (a `maxLength` would be a breaking change against the branch
head for the staged-spec gate).

## 206-A code review r1 (APPROVE, MEDIUM/LOW only): MEDIUM fixes, fix round 2

Kernel main 535aae89 merged into the unit branch first (no rebase, no conflict).

| Finding | Fix | Guard | RED before the fix | GREEN |
|---|---|---|---|---|
| MEDIUM (quality, silent-failure): an unknown `requiredMajority`, a negative/fractional/non-numeric tally, or an unknown stored rule escaped POST/PATCH as a 500 | POST validates the rule against the five CHECK-accepted ids in both modes; POST and PATCH map the engine's typed input errors to 400 (`isDecisionRuleInputError`, `isCoreDecisionRuleId` in `decision-rule.ts`) | `resolutions.test.ts` (h) | 7 failed / 27 passed (`expected UnknownDecisionRuleError ... to match object { status: 400 }`) | 34/34 |
| MEDIUM (security): PATCH had no published/adopted guard; the acclamation branch let an admin flip an adopted result with no audit record | PATCH and DELETE load the row joined to its protocol: 404 when unknown or under another protocol, 403 once published or `decided_at` is set | `resolutions.test.ts` (i) | 6 failed / 36 passed | 42/42 |
| MEDIUM (quality; security LOW): a member could challenge an adopted REJECTED resolution that no admin surface lists | `fileChallenge` requires `result = 'passed'` besides `decided_at` (review option a; `ResolutionNotAdoptedError`, route 403) | `resolution-challenges-audit.integration.test.ts` (0b) rejected / withdrawn | 2 failed / 6 passed (`promise resolved ... instead of rejecting`) | 3 challenge files 17/17 |
| MEDIUM (silent-failure): `/beschluesse` told an admin "Keine Einsprüche" when the challenge query had failed | the loader returns `beschluesseUnavailable` / `challengesUnavailable`; the page renders an alert line instead of the empty state | `beschluesse-page.test.ts` flag cases | 4 failed / 8 passed | 12/12 |
| MEDIUM x2 (svelte): ResolutionRow never passed the support_threshold fraction; acclamation rows rendered an empty tally and an inert rule label | optional `adoption_mode` / `decision_rule_params` on the row type, fraction passed, "per Akklamation" in both views, the null-verdict cause named | `ResolutionRow.test.ts` Phase-2 cases | 4 failed / 2 passed | 6/6 |

This closes the 206-A residuals "Resolution PATCH/DELETE carry no publish lock"
and "ResolutionRow ... shows empty tallies for an acclamation row". Still open
(LOW, named): the row type keeps the three-rule `required_majority` union and
non-null tallies (widening it changes the protocol page's type, a K1 file);
the Anfechten affordance is shown to guests; the recall dialog shows the
route's English validation messages; reconcile calls Keycloak even when no
resolver is registered; assign does not validate `userKeycloakId` as a UUID;
`financeRoleLabelsForTenant` tolerates a missing tenant context.
