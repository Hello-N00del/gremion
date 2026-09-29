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
