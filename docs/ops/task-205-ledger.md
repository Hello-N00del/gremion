# TASK-205 ledger (205a + 205b)

The unit's grant ledger, its Q8 carve-keep classification for `seed.ts`, its deferrals and its named
residuals. For the orchestrator and the security review. Brief: TASK-205; lane note r30 (binding where it
differs from the brief). This lane delivers 205a and 205b only; 205c and 205d are residuals (section 5).

## 1. Grant ledger: files edited outside the lane note's Owns list

Each edit is needed for the unit's acceptance. None changes behaviour outside what the reason names.

| File | Brief / lane status | Grantor or reason |
|---|---|---|
| `gremion-ui/src/lib/server/config.ts` | Do-NOT-touch (042-b) | Q8 carve-keep: the `calendar` (shared event colour, German state) and `elections` (tracked Helios ids) config sections the carve removed, with their defaults, schemas and merges (60066379, 197e3e42). 042-b is merged, so the second to merge (205) carries both. Orchestrator to confirm. |
| `gremion-ui/src/lib/server/tenant/provisioner/materialize.test.ts` | Do-NOT-touch (`lib/server/tenant/**`) | Golden forced by the re-applied `calendar` / `elections` config sections. Test-only. |
| `gremion-ui/src/lib/server/tenant/role-vocabulary.test.ts` | Do-NOT-touch (`lib/server/tenant/**`) | Golden forced by `Role.Finance` / `Role.Auditor` (brief TDD 9). Test-only. |
| `gremion-ui/src/lib/auth/index.ts` | Brief grant: carve-keep file | Q6/Q8 MODULE hunk: `canReadFinance` / `canWriteFinance`. |
| `gremion-ui/src/routes/+layout.svelte` | AppShell is TASK-208's | UX-071a.6 slot seam: the root layout globs `lib/modules/slots/*.slot.ts` and hands `topbarModules` to AppShell (f7409277). TopBar.svelte is untouched. |
| `gremion-ui/src/lib/modules/layout-slot.ts` | new shell file | Same seam: the `ModuleLayoutSlot` type (chips / liveCall / bell / overlay). Replaced by TASK-125 composition. |
| `gremion-ui/src/lib/server/env/service-env.ts` (+ test), `service-endpoint-names.js` | new shell files | Q5: the service-endpoint fallback the module halves read while TASK-042 refuses those names in `platformEnv`. Restricted to an explicit frozen list of 15 names (round 2). |
| `gremion-ui/scripts/check-tenant-env-guard.mjs` (+ `tests/unit/check-tenant-env-guard.test.ts`, `scripts/__fixtures__/env-guard/service-env-calls.ts`) | not owned | Round 2: the guard reads `serviceEnv('X')` call sites (non-endpoint literal or computed name fails `--enforce`) and names `lib/server/env/service-env.ts` in its default allowlist. |
| `.oxlintrc.json`, `docs/lint.md` | not owned | Frozen-copy lint overrides for the byte-equal module halves; the ratchet stays at its baseline of 70 (e7d7589c, 845dac1b). |
| `scripts/ci-local/suites.json` | Do-NOT-touch (TASK-012) | Round 2, verifier HIGH: after main 9d8537a1 (TASK-012-fu2) the tree-claim tripwire was RED on 103 unclaimed TASK-205 test files. Claim-only edit; the orchestrator grants it or carries it in the merge commit. |
| `.dockerignore` (repo root) | lane note owns `gremion-ui/.dockerignore` | Round 2: the build context is the repo root, so the disabled-module lane dir (`gremion-ui/_module-lane/`) is excluded there. |

## 2. Q8: `gremion-ui/src/lib/server/seed/seed.ts` is deliberately NOT carried

The brief lists `seed.ts` among the carve-keep files. At f2, StuRaOS `seed.ts` calls `seedCalendar`,
`seedElections`, `seedNews`, `seedNewsletter`, `seedBoardFixtures` and `seedFinance` in its **StuRa demo
set**. Those seeders key to the StuRa blueprint's own fixtures (`ou('studierendenrat')`,
`user('anna.berger')`).

The kernel `seed.ts` (042-b, zero-tenant) seeds the **municipal** demo only (`seedMunicipalDemo`, when
`includeDemo` and `demoSeeder === 'municipal'`). Its own comment records that the StuRa demo set rode with
the carved-out feature modules. Re-applying the f2 calls would bring a StuRa-only fixture path back into
the kernel.

Decision (MODULE hunk, not carried): the module seeders stay overlaid
(`modules/{board,calendar,elections}/app/lib/server/seed/seed-*.ts`, byte-equal or delta-listed). They are
not called from the kernel `seed.ts`, so they are dead code in the kernel build until a module seed seam
exists. That seam is TASK-125's module composition (or the vertical's own seed through TASK-152). No kernel
golden changes.

## 3. Deferrals

- **Kit-3 forward edits (brief section 5.1: K1-K5, the K-scan, about 72 edits)**: deferred to TASK-032's
  trigger per the lane note (R29-I5: stay on SvelteKit 2; byte-equal copy). The round-2 tests stub
  `VideoCallPip` instead of mocking `$env/dynamic/public`, so the unit adds no new `$env/dynamic/*` mock. The
  pip itself still reads `$env/dynamic/public` (byte-equal copy) until TASK-032 converts it.
- **Q9 (chips below 768 px)**: landed as `TOPBAR_SLOT_BELOW_RAIL.chips = 'hidden'`. The PLAN quote puts
  them in the drawer header. This needs the operator's acceptance of 'hidden', or a TASK-208 drawer-header
  grant in a follow-up. The browser suite asserts: chips hidden, live-call and bell kept, bell at least
  44 px, popover `min(348px, 100vw - 32px)`.

## 4. Source policy (lane note item 1)

Byte-equal copy from `extraction-source-f2`, then one catch-up per module to StuRaOS `87c004a8`.
Round 2 adds the elections Helios client at StuRaOS `10bae9e5` (R30-FOLLOWUPS-S item 8a, in master
`0bf0236b`): `isHeliosUuid` + `encodeURIComponent`. Every catch-up file has a blob-pinned
`modules/EXTRACTION-DELTA.json` entry whose reason names the StuRaOS commit. Between `87c004a8` and
`0bf0236b` no other module-half file of messaging, votes, elections, board, calendar or files changed.
Finance (`helios/wiring.test.ts`) is 205d.

## 4a. TASK-205c: publishing, vault, content verification

Delivered by this section's unit; it supersedes the 205c bullet of section 5 and the TASK-200 residual (a)
bullet below it (residual (a) is closed: the lane is a verify part and content is green).

**What moved.** `modules/publishing/app` (48 files: newsletter pages and api routes, the three leaf callback
routes, `lib/server/newsletter`, the audit consumer, the demo seeder, the manifest) and `modules/vault/app` (28
files: vault and vault-extern, api routes, `lib/server/vault`, `lib/vault`, the manifest), byte-equal from
`extraction-source-f2`; content gains `routes/api/internal/content` and `lib/server/events/content-audit-consumer`
(its `register.server.ts` and `portal-publish-contract.test.ts` import them). Publishing is enabled (overlay,
gitignore patterns, Dockerfile COPY, both barrels); vault stays disabled and runs in the module lane.
All 69 vault and newsletter files of the f2 set are identical on StuRaOS master `e1d004de`; the only post-f2 change in
the moved sets is the type catch-up `871636a`, carried for the three audit consumers (publishing and content here,
calendar already). Parity set C: 431 files.

**Kernel adaptations (blob-pinned deltas, owner TASK-205c).** The deleted default-tenant env reader:
`NATS_URL` through `platformEnv`, `NEXTCLOUD_ADMIN_USER` through `serviceEnv` (already in the frozen list). The
`/api/internal/` guard of `boot-exempt.test.ts`: the four callback handlers (newsletter render, resolve-group,
send-mail; content portal-publish) authenticate through the shared `constantTimeEqual`. Content: the carousel
route reads `TENANT_PALETTES` (`INSTANCE_REGISTRY` no longer exists, TASK-082), `news-page.test.ts` resolves the
German catalogue from `lib/i18n/messages/de.json` (`lib/i18n/de.ts` is gone). Both audit-consumer integration
suites register `tenant-a` through `createTestTenant` as calendar's does (run against a scratch PostgreSQL: newsletter
and calendar 14 passed, content 7 passed). Neutral sender and issuer hosts for hygiene h1/h2/i1.

**Grants outside Owns.**

| File | Reason |
|---|---|
| `gremion-ui/src/lib/auth/actions.ts` (+ test) | Carve-keep hunk (`diverged-carve-keep-edits`) re-applied with its module: `vault.secret.reveal` (fresh LoA 2, no capability). The registry was empty, so every reveal threw. Finance's two actions join with 205d. |
| `gremion-ui/src/lib/modules/registry.test.ts` | Golden: the newsletter manifest (order 50) and its `newsletter: Role.Finance` page segment. |
| `gremion-ui/package.json`, `pnpm-lock.yaml` | `satori ^0.12.2` and `@resvg/resvg-js ^2.6.2` as **devDependencies**: content's carousel renderer needs them for its unit tests; `deploy --prod` leaves devDependencies out of the image while content is disabled. They move to `dependencies` with the enable decision. The lockfile was regenerated by `pnpm add` (never hand-edited); the regeneration also swapped the `picomatch` peer variant of `svelte-check` between the gremion-public and gremion-ui importers (both variants are in the lockfile; no version changes). `pnpm-workspace.yaml` untouched. |
| `gremion-ui/Dockerfile`, `gremion-ui/.gitignore` | One COPY line and the publishing overlay patterns. |
| `scripts/ci-local/suites.json` | Publishing joins the unit and integration claims; the content overlay suite (was `unrunnable`) becomes the module-lane runner and covers vault; content's integration tests are claimed by an explicit `unrunnable` suite (the integration config collects enabled halves only). |
| `scripts/verify/suites/unit.mjs` (+ test) | `unit:module-lane` part. |
| `.oxlintrc.json`, `docs/lint.md` | Frozen-copy overrides for 6 files, 7 findings; the ratchet stays at 70. |

**Content against StuRaOS master (the 14 files changed since f2).** All 14 already carry blob-pinned
`kernel-ahead` deltas (owner TASK-205) from the F1-FIX-07 / R29-LOW-07 round the kernel fixed on 2026-10-01 in
parallel with StuRaOS; one of them (`backend/index.ts`) is now byte-equal to master. No new catch-up was applied: the
other 13 differ from master by design, not by omission. Same finding ids, different shape:

| StuRaOS master | Finding | Kernel commit (the delta's reason names it) |
|---|---|---|
| `3d2823c`, `7f4b210` | H08 route ids steer the leaf URL; K5#1 publish budget | `327c900e` (`ids.ts`, encoded segments; master validates UUIDs and refuses non-UUID ids before any request) |
| `3ad8709`, `f024090` | H07 failed recipient retried; S1c#0 absolute unsubscribe link | `db286726` |
| `f7d8f15`, `5eaabbd` | H07 r2 late failure never downgrades or re-sends | `e69fccb9` |
| `1575ffc`, `ae1dee0`, `898017c` | R29-LOW-07 L1-L3 claim token, mixed pass, unknown outcome | `317a5f53`, `4d71287d` (master names the token `claimedAt`, the kernel `claimToken`; the leaf wire field `claim_token` is the same) |
| `9db1486`, `6988b24` | unsubscribe consumes on POST only | `c64a7a29`, `8dd9f899` |
| `ceee6b4` | H09 per-tenant draft path | `cde71433` |

The two lines are not reconciled line by line. A single reconciliation (master's UUID refusal and naming against the
kernel's encoding and `smtp-outcome`) is a content decision for the unit that enables content, not a catch-up.

**Shell hunks not applied (files owned by another unit: `hooks.server.ts`).** Publishing is wired, but two
behaviours need `PUBLIC_PATHS` entries (exact, per the F1-FIX-03 rule; the f2 list had prefixes): `/newsletter/unsubscribe`
and `/api/newsletter/unsubscribe` (the unsubscribe page and POST must work without a session), and
`/api/internal/newsletter/render`, `/resolve-group`, `/send-mail` (the leaf calls them with `x-internal-auth`; the
element-0 `leaf-trust.ts` already selects the tenant, but without an entry the session guard answers 401 for want of a
session). For content when it is
enabled: `/content/unsubscribe`, `/api/internal/content/portal-publish`. `hooks.boot.test.ts` pins the current 401 for
`/api/internal/newsletter/render` through the session guard (`a tenant-resolved request still goes through Auth.js`);
that case flips with the entry and should use a path that stays guarded. No nav rail entry exists for newsletter in the
source; vault's rail anchor (`{ slot: 'module', moduleId: 'vault' }` in the Verwaltung section) joins `nav-schema.ts`
when vault is enabled.

**K3.** The unit adds no `$env/dynamic/*` mock: its own test edits mock `$lib/server/env/service-env` or nothing. Seven
byte-equal files keep the f2 form until TASK-032's K-scan: `vault-flags.ts`, `vault-extern/+page.server.ts` and
publishing's `collabora-convert.ts` import `$env/dynamic/private`, and four vault tests (`vault-flags.test.ts`,
`vault-authz.test.ts`, `vault/page.server.test.ts`, `vault-extern/page.server.test.ts`) mock it. Converting them needs
the names `VAULT_REVEAL_REQUIRE_STEPUP`, `STEPUP_FRESHNESS_SECONDS`, `VAULTWARDEN_BASE_URL`, `COLLABORA_INTERNAL_URL` on
a reviewed env list (a platform decision, not a module edit).

**Module lane.** Content and vault: 46 unit test files, 419 tests, 0 failed (`node gremion-ui/scripts/module-lane.mjs
-- --reporter=json`; `verify --only unit:module-lane` PASS). The lane copies the shell without the real tree's overlay
output, overlays every half, regenerates the manifest barrel in the scratch app and writes a stand-in for
`handover-vault-links` (the vault page imports handover, which moves with 205d; the stand-in is inert once the real
file lands and a test fails if it goes stale).

**Not carried, with owner.** `lib/handover/vault-refs*` and `lib/server/handover/handover-vault-links*`
(handover, 205d); `lib/modules/manifests/vaultwarden.*` (TASK-157);
`lib/server/boundary/contracts-newsletter-specs.test.ts` (the kernel has no `contracts/newsletter`); finance and
the app migration chains (205d). Publishing and vault have no gremion-ui migration chain of their own (their databases
are the leaf chains `modules/{publishing,vault}/migrations`), so 205c claims no migration number and does not touch
`STURA_RANGES`.

## 5. Named residuals

- **205c (publishing, vault, content verification + K3)** and **205d (finance, handover, the app
  migration chains)**: not in scope tonight (orchestrator R30). Their post-conditions are not met, by
  design: handover's three migrations in `schema_migrations`, finance `CASES.length === 58` / 61 header /
  3 sagas, `modules/finance/test/routes.test.ts`, and the image build. Three open decisions for the next
  push:
  1. migration block numbers, plus the `stura-only-slugs.json` / `STURA_RANGES` conflict at
     `scripts/migrations/register.mjs:279`;
  2. source policy: f2 copy plus catch-up deltas, or a new `extraction-source-f3` cut;
  3. the TASK-075 union runner for app migration chains.
- **TASK-200 residual (a), partly closed**: the disabled-module lane (`gremion-ui/scripts/module-lane.mjs`)
  collects content's 37 unit test files. A real run reports `Test Files 7 failed | 30 passed (37)` and
  `Tests 2 failed | 270 passed (272)`. The causes are content's missing deps and shell files
  (`@resvg/resvg-js`, `$lib/i18n/de`, `$lib/server/newsletter/collabora-convert`, the content manifest
  absent from the barrel, one test reading an undefined `stadt`), all of which land with 205c. The lane is
  not yet a verify part. 205c wires it in once those 7 files are green. Until then the 7 red files are
  known, and residual (a) is **not** counted as closed.

## 6. For the security review (verifier r2 LOW)

- **Shared-backend credential fallback through `serviceEnv`.** `gremion-ui/src/lib/server/env/service-endpoint-names.js`
  is a frozen list of 15 names. It still includes credentials, read process-wide: `HELIOS_SERVICE_PASSWORD`,
  `LIVEKIT_API_SECRET`, `NEXTCLOUD_ADMIN_PASSWORD`, and the token maps `NEXTCLOUD_USER_TOKENS` and
  `NEXTCLOUD_CALDAV_USER_TOKENS`. The kernel copy of
  `modules/elections/app/lib/server/elections/helios-client.ts` honours `ctx.services` for every tenant (f2
  had `ctx.slug === 'default' ? undefined : ctx.services`; the kernel has no `default` slug after TASK-042-b,
  delta entry reason "no default-tenant branch"). So a pooled tenant **without** a per-tenant `services`
  block falls back to the deployment's shared backend and its shared credentials. That is f2's
  default-tenant semantics extended to every tenant. It is not exploited today (one tenant per test env), but
  it is a deployment-wide fallback. Proposed follow-up: once TASK-125 lands, require an explicit per-tenant
  `services` block for pooled tenants and refuse the env fallback for them. The comment above `heliosBase()`
  still describes the f2 default-tenant branch. It is left byte-equal to the blob-pinned delta entry, and
  this note supersedes it.
- **Not re-run in round 3 (no round-3 change touches them):** the integration suites (`auto-join.integration`,
  `election-db`, messaging/elections). Round 1 covered them. The live e2e specs (`module-landing-routes.spec.ts`,
  `room-admin.spec.ts`) need the Keycloak scratch stack plus an image build, and those do not fit a 4-minute
  call on this box. The orchestrator runs them against the redeployed test env (R30-I4) with the JSON reporter:
  `expected >= 1`, `skipped == 0`, `unexpected == 0`.
- **Pre-existing, not this unit:** `scripts/ci-local/tree-claim.test.mjs` fails on plain `origin/main` (5
  unclaimed `modules/messaging/synapse/test/*.test.mjs` files from TASK-198). After the merge, the
  orchestrator claims them as TASK-198's follow-up. Every TASK-205 file is claimed.
