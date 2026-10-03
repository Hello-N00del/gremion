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
