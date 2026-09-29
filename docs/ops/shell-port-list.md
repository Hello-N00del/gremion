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
| a29347f0 (895f736 in the source record) | `gremion-public/src/hooks.server.test.ts` | adapted (G5): the kernel's header hook is `securityHeadersHandle`; the "keeps Google Fonts reachable" case is dropped (kernel self-hosts fonts, pinned the other way by `lib/test/csp-no-third-party-fonts.test.ts`) | itself | mutation: drop `X-Content-Type-Options: nosniff` -> `× sets the CSP and the anti-framing headers on a text/html response` (1 of 8) | 8/8 |
| a29347f0 (09b6128) | `gremion-public/src/lib/sanitize.test.ts` | ported (G5; one comment line adapted: the kernel portal has no `/aktuelles`); `sanitize.ts` byte-equal to the source (6fc897c) | itself | mutation: allow `script`/`iframe` + `on*` attributes -> 3 of 11 FAIL (`strips a <script> element, tag and payload alike`, ...) | 11/11; gremion-public 15 files / 187 tests |
| 5f47943c | gremion-public nosniff + Referrer-Policy | present (`gremion-public/src/hooks.server.ts:53-54`) | `hooks.server.test.ts` | as above | green |
| 5f47943c | gremion-ui nosniff + Referrer-Policy | 206-B (G0, after TASK-205) | | | |
| a29347f0 (#459-2) | rate-limit bucket eviction | present@8649555a (item 3 row, guard (n)) | | | |
| a29347f0 (#434-6) | `gremion-public/src/lib/server/mail.ts` | N/A: no such file in the kernel portal | | | |
| a29347f0 | messages `service-client` | via TASK-205 | | | |
