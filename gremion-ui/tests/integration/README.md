# `tests/integration/` — standalone, isolated-stack integration proofs

These tests are **deliberately separate** from the shared-DB integration lane
(`pnpm test:integration`). That lane's vitest config only collects
`src/**/*.integration.test.ts` against a **shared, FINANCE-ON, fully-migrated**
Postgres. The proofs here need the **opposite** environment and must never run
in — or pollute — that shared DB, so they live outside `src/**` and run in a
**dedicated lane** (`pnpm test:deselection`, config
`vitest.deselection.config.ts`) you invoke by hand against a stack you stand up
for the purpose.

> These are **deliberate local steps** run by hand against a stack you stand
> up for the purpose, not CI gates; CI runs the unit and hygiene suites only.

---

> **Carve note (gremion#22):** this directory used to document TWO proofs —
> `deselection-boot.integration.test.ts` (Pillar-1, a P0.2 boot-smoke that
> flipped a `modules.finance` config toggle per-vertical) and
> `municipal-acceptance.integration.test.ts` (Pillar-2, below). `deselection-
> boot.integration.test.ts` was deleted: its entire premise was a vertical that
> could selectively turn a *present* finance module on/off via config. In the
> governance-only kernel finance isn't toggleable — it was carved out
> unconditionally, there is no `finance.ts` module manifest, no finance
> migrations to skip, and `runMigrations()` no longer reads a
> `modules.finance` flag at all. Its DB criteria (1–3) were already fully
> subsumed by the municipal proof below (same assertions, same fresh
> finance-OFF DB) and its realm/HTTP criteria (4/4b/5) were env-gated and never
> ran outside a hand-built throwaway stack. Pillar-2 is the one proof left in
> this lane.

## `municipal-acceptance.integration.test.ts` — Pillar-2 P2.3 municipal-vertical proof

**Goal:** prove Gremion is a *reusable framework* — the **"Stadt Musterstadt"**
municipal council (Gemeinderat) vertical stands up as a genuinely different,
**finance-OFF** tenant from the SAME framework: it boots finance-OFF, renders
**municipal vocabulary** (Gemeinderat / Ausschuss / Fraktion / Ortschaftsrat)
with **no StuRa-kind leakage**, models a councillor in **one Fraktion across
multiple Ausschüsse**, isolates **the data-plane DB per tenant** (LiveKit /
newsletter are leaf-service concerns outside kernel scope), and carries the
**§4 realm contract**. It maps the 7 acceptance criteria of the municipal-vertical proof design.

Collected via the dedicated `pnpm test:deselection` lane
(`vitest.deselection.config.ts`, `include: ['tests/integration/**/*.integration.test.ts']`)
— same reasoning as the intro above: this file needs a fresh, finance-OFF DB
and must never run against (or pollute) the shared `test:integration` Postgres.

### Prerequisites (the isolated stack)

**Run from the repository root.** A **FRESH, isolated, EMPTY** Postgres (never
the live / staging DB):

```bash
export DATABASE_URL='postgres://gremion:gremion_test@localhost:55432/gremion_muni_test'
export SEED_USER_PASSWORD='pw'   # runSeed requires a seed password
```

> **CONFIG_PATH (gremion#22 — carved-out path fixed).** The old instructions
> here pointed CONFIG_PATH at `examples/verticals/musterstadt/config.json` —
> that demo-verticals fixture was removed and no longer exists in this repo.
> It is also no longer load-bearing for this proof: finance is carved out of
> the governance-only kernel unconditionally (no `finance.ts` module manifest,
> so `runMigrations()` no longer reads a `modules.finance` flag at all — see
> the carve note above), so the finance-OFF boot criterion holds regardless of
> CONFIG_PATH. CONFIG_PATH is the same env `deselection-setup.ts` /
> `tests/integration/setup.ts` fall back on
> (`process.env.CONFIG_PATH ?? '/app/config/config.json'`); leaving it unset
> is fine — `readConfig()` gracefully falls back to `DEFAULT_CONFIG` when the
> path does not exist. To point it at a real, committed fixture instead, use
> one that actually exists in this repo, e.g.:
> ```bash
> export CONFIG_PATH="$PWD/gremion-ui/tests/integration/fixtures/default-config.json"
> ```

> The DB **must start empty.** The suite's `beforeAll` runs `runMigrations()`
> (finance is unconditionally absent from this kernel's migration set — see
> above) then `runSeed(MUNICIPAL_BLUEPRINT)`, seeding the municipal kind
> catalog + org units + Fraktionen. Re-seeding a populated DB is **not** a
> supported scenario (the live `/api/setup/seed` endpoint 409s on a non-empty
> `org_units`), so always start from a fresh volume.

### Run (criteria 1–6)

```bash
pnpm -C gremion-ui test:deselection
# = vitest run --config vitest.deselection.config.ts
```

| # | Assertion | Mechanism |
| --- | --- | --- |
| 1 | Boots finance-OFF | no `finance` schema; no finance/approval row in `schema_migrations`; `public.org_units` present (severability) |
| 2 | Municipal vocabulary, no leakage | `loadOrgSchema()` kinds are **exactly** `administration/committee/council/district_council`; labels render `Gemeinderat`/`Ausschuss`/`Ortschaftsrat`; the StuRa-only `group`=Gruppe residue is pruned (T4) |
| 3 | Councillor in 1 Fraktion + ≥2 Ausschüsse | `caucus_membership` count = 1 and `org_unit_members` of `kind='committee'` ≥ 2 for the Hauptausschuss councillor |
| 4 | Distinct data-plane DB | `dbNameForSlug('musterstadt') === 't_musterstadt'`, ≠ `gremion` / `t_demo` (registry-level) |
| 5 | LiveKit token mint tenant-scoped | `assertRoomInTenantNamespace` rejects a tenant-#1 caller from a `t.musterstadt.*` room and a musterstadt caller from another namespace (cross-tenant) |
| 6 | Newsletter module absent from the kernel | `MODULE_MANIFESTS` (the kernel's generated manifest barrel) never registers a `newsletter` module id — carved out (gremion#22); a tenant that wants it gets it from the modules overlay (`gremion-modules`) |

### Run (criterion 7 — realm contract, env-gated, optional)

Criterion 7 reuses the **R5/R7 §4 realm-contract drift guard**
(`tenant-provision reconcile --verify-only`) against a **THROWAWAY musterstadt
realm** — never the live `sturaos` realm. It `it.skipIf(...)`s off unless the
gate env var is set, so criteria 1–6 always run without a live KC:

```bash
export MUSTERSTADT_RECONCILE_VERIFY=1   # enables criterion 7
# The CLI reads DOMAIN / KC creds / control DB from the operator env, exactly
# as `tenant-provision reconcile --verify-only musterstadt` would on the host.
```

The case shells out to `tenant-provision reconcile --verify-only musterstadt`
and asserts a **zero exit** — i.e. every §4 check (protocol-mapper,
`acr.loa.map`, browser-stepup, `sslRequired=all`) PASSES on the provisioned
realm. A non-zero exit (a FAILed check or a CLI error) fails the case.

### Discipline

- **No live infra from this test.** It connects only to whatever `DATABASE_URL`
  / `DESELECTION_APP_URL` you point it at. Point it at a throwaway stack.
- Tear the isolated Postgres + throwaway KC realm down when done.
- This is the codified proof; the **actual isolated-stack run is a deferred,
  deliberate operator step** (the spine and tooling are committed; spinning up
  the stack is not done automatically).
