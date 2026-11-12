# Gremion — Testing Guide

This document covers the Gremion governance-kernel test strategy: the
`make verify` gate, the application's static checks and Vitest suites
(`gremion-ui`), the open-core boundary backstop, the module-registry golden, the
add-a-module proof, and the infrastructure-level shell/integration tests.

For the vision, architecture, and governance charter the kernel implements, see
[about-gremion.md](about-gremion.md). This guide is the operational/technical
layer — how the kernel is verified, not what it is.

> Gremion is the open core carved out of the StuRaOS monorepo. The admin shell
> app is `gremion-ui` and the public portal app is `gremion-public`; those names
> appear throughout the test config and are kept here verbatim.

---

## Overview

| Test type | Tool | Scope | Requires Docker? |
|-----------|------|-------|-----------------|
| The gate | `make verify` (`scripts/verify/verify.mjs`) | The suites in `scripts/verify/required-suites.txt`, each judged for vacuity; see "The verify gate" | Some parts |
| Static checks | `svelte-check` + `tsc` + custom guards | `gremion-ui` Svelte/TS sources, env/port/domain guards | No |
| Unit tests | Vitest | Server clients, API routes, auth, the module SDK, `@gremion/db`, `@gremion/ports`, `@gremion/storage` | No |
| Browser tests | Vitest browser mode (Chromium) | The responsive navigation shell components | No |
| Boundary backstop | Vitest | Open-core dependency-direction (kernel never imports a feature module) | No |
| Integration tests (app) | Vitest | DB-backed boot/migration/registry suites | Yes (Postgres) |
| Shell unit tests | BATS | `test/*.bats` (scripts, realm, backup) and `test/host/*.bats` (the distribution-host tooling) | No |
| Infra integration | BATS | Live stack health + OIDC wiring + legal rendering + login theme | Yes (running stack) |
| Linting | shellcheck + yamllint + oxlint + the `lint-*` guards | Shell, YAML, JS/TS, compose and the repository guards | No |
| Config validation | `docker compose config` | Compose files | No |

The kernel's own manifests are `core` and `governance` (both always-on /
`toggleable: false`); the build overlays the enabled modules' manifests next to
them, so the composed surface the Vitest suites assert is the ten manifests of
the default build (see "Registry golden" below). The module packages carry their
own suites (`pnpm --filter ./modules/<id> test`); `modules/disabled.json` lists
the modules the default build leaves out.

---

## The verify gate

`make verify` (also `pnpm verify`) runs `scripts/verify/verify.mjs`: every suite
named in `scripts/verify/required-suites.txt` — `typecheck`, `unit`,
`integration`, `migration-hash`, `carve-lint`, `isolation`, `census`,
`expand-contract`, `render-guards`, `boundary-lint`, `vendor-mail`,
`observability` — judged by the fail-closed vacuity rules in
`scripts/verify/lib/guard.mjs` (a suite that collected nothing, or skipped
everything, fails). It writes a result record
(`scripts/verify/out/<sha>.json`) that `scripts/verify/check-record.mjs` reads.
There is no skip flag: the only argument is `--only <suite[,suite]>`, and
`unit:<part>` and `integration:<part>` name the parts of the two large suites
(for example `unit:ui`, `unit:ports`, `unit:modules`, `unit:bats-1-of-2`,
`integration:fresh-init`).

CI (`.github/workflows/ci.yml`) splits the same suites over the legs
`verify-static`, `verify-render-ops`, `verify-unit-ui`, `verify-unit-packages`,
`verify-unit-host`, the two BATS shards (`verify-unit-bats-1`,
`verify-unit-bats-2`), `verify-integration-db`, `verify-integration-brokers`,
`verify-integration-events-alert` and `verify-census`, and the `Lint` job fails when a
required suite is run by none of them or by more than one
(`scripts/check-ci-verify-coverage.mjs`). The `unit:node` part runs
`scripts/**/*.test.mjs`, which includes the tests of the documentation guards:
`scripts/check-doc-translations.mjs` (German twins) and
`scripts/check-module-docs.mjs` (`docs/modules.md` against `modules/`).
`make lint-hygiene` runs `scripts/kernel-hygiene-check.mjs` and `make
lint-compliance` the marketing-copy check over `README.md` and
`docs/about-gremion.md`.

---

## Application tests (`gremion-ui`)

All commands run from the `gremion-ui/` package. The package uses **pnpm**
(`packageManager: pnpm@10.33.0`).

```bash
cd gremion-ui
pnpm install
```

### Static checks — `pnpm check`

`pnpm check` is the kernel's first gate. It runs, in order:

0. `precheck` — `interim-module-overlay.mjs` overlays the enabled modules' app
   halves onto `src/`
1. `node src/lib/i18n/compile.js` — compile the i18n catalogue
2. `check-tenant-env-guard.mjs --enforce --root src` — tenancy/env-isolation guard
3. `check-app-port-binding.mjs` — app port-binding guard
4. `check-tenant-secrets-dir.mjs` — per-tenant secrets-dir guard
5. `svelte-kit sync` then `svelte-check --tsconfig ./tsconfig.json` — type +
   Svelte diagnostics across the whole app

```bash
pnpm check          # one-shot
pnpm check:watch    # svelte-check in watch mode (skips the standalone guards)
```

### Unit tests — `pnpm test:unit`

The fast, dependency-free suite. Configured in `vite.config.ts` (`test` block):

- **Includes:** `tests/unit/**/*.test.ts`, `src/**/*.test.ts`,
  `scripts/install-git-hooks.test.ts`, and the workspace packages
  `../packages/db/src/**/*.test.ts`, `../packages/ports/src/**/*.test.ts` and
  `../packages/storage/src/**/*.test.ts`. The `@gremion/*` packages are
  collected through `gremion-ui`'s Vitest so their dependency-free specs (e.g.
  `client.test.ts`, `broker.test.ts`) run in the same pass. (`@gremion/ports`
  also carries its own `vitest.config.ts` for `pnpm -C packages/ports test`.)
- **Excludes:** `**/*.integration.test.ts` (those need a real Postgres — see
  the integration lane) and `**/*.browser.test.ts`.
- `environment: 'jsdom'`, `globals: true`, `setupFiles: ['tests/unit/setup.ts']`,
  `fileParallelism: false`.

```bash
pnpm test:unit              # run once
pnpm test:unit:watch        # watch mode
pnpm coverage               # vitest run --coverage (v8)
pnpm test:browser           # the Chromium projects `browser` and `browser-dsf2`
```

`vite.config.ts` defines three Vitest projects: `unit` (the jsdom run above),
`browser` and `browser-dsf2` (the real-Chromium responsive-shell suite,
`*.browser.test.ts`; a run that collects none fails).

### Integration tests — `pnpm test:integration`

DB-backed `src/**/*.integration.test.ts` files (real boot, fleet migrations,
control-plane registry). Configured in `vitest.integration.config.ts`. These
require a real Postgres reachable via `DATABASE_URL` (default
`postgres://gremion:gremion_test@localhost:5432/gremion`) and `CONTROL_DATABASE_URL`
(default `…/control`) with migrations applied, and **`GREMION_PRODUCTION_STACK`**
in the environment: the production `${STACK}` on this host, or `none` when the
host runs no production unit. It has no default. The config defaults safe
build-test placeholder secrets and **fail-closed-guards every DB URL** at
config-load time (`assertNonProductionDbUrl`, the spec B §6 no-truncate guard):
Vitest refuses to boot while `GREMION_PRODUCTION_STACK` is unset, against a
`postgres-<production stack>` host, against loopback while a production stack
exists, and against any host that is not stack-qualified (`postgres-<stack>`).
On a development box: `GREMION_PRODUCTION_STACK=none pnpm test:integration`. `fileParallelism` is off — the suites share one Postgres and
truncate shared tables in `beforeEach`.

```bash
# bring up a Postgres + apply migrations first, then:
pnpm test:integration
```

There is also a separate **deselection boot-smoke** lane
(`pnpm test:deselection`, `vitest.deselection.config.ts`) that proves a module
toggled OFF on a fresh, isolated DB boots cleanly. It collects
`tests/integration/**/*.integration.test.ts` and is **not** a CI lane — run it
against an isolated stack per `tests/integration/README.md`.

### E2E — `pnpm test:e2e`

Playwright (`playwright test`). `pnpm test:all` runs the unit suite then
Playwright.

---

## The open-core backstop, registry golden, and module proof

Three Vitest suites guard the kernel's open-core boundary and module SDK. They
run in the ordinary `pnpm test:unit` pass — they are listed separately here
because they are the load-bearing kernel-specific guarantees.

### Boundary backstop — `kernel-clean.test.ts`

`src/lib/server/boundary/kernel-clean.test.ts` is the comprehensive
dependency-direction guard: it walks **every** kernel source file under
`src/` and asserts each imports **zero** feature-module code. The kernel
(everything that is not a feature module) may never import a feature module;
the only sanctioned exceptions are the SDK seams (`modules/registry`,
`modules/types`, the runtime-registry) and per-module `register.server.ts`
composition roots.

Files under the module-owned directories (the overlaid module halves) are
exempt as importers, so the boundary stays a single source of truth. The
tracked kernel tree resolves no module directory today; the backstop is what
reds the moment a kernel file imports one. It also enforces a non-vacuous floor
(`scanned > 200`) so a path regression that wiped most of the tree can't make the
guard pass silently, and keeps the documented-exception `ALLOW` map honest
(currently empty).

This single test is what would have caught — all at once — the kernel→feature
couplings that per-directory import rules originally missed.

### Registry golden — `registry.test.ts`

`src/lib/modules/registry.test.ts` pins the composed module surface of the
default build (the kernel manifests plus the enabled modules' overlaid ones):

- **Codegen staleness guard:** the committed `manifests/index.generated.ts`
  must byte-equal a fresh `node scripts/build-module-manifest.mjs --stdout`
  run (EOL-normalised), so the generated barrel can't drift from
  `manifests/*.ts`.
- **Exact id set + order:** the generated barrel exposes exactly `core`,
  `governance`, `elections`, `votes`, `content`, `newsletter`, `calendar`,
  `files`, `messages`, `board`, in that registration order, and
  `MODULE_MANIFESTS` (via `registry`) **is** that same array (no second source
  of truth). It is a synchronous array, not a Promise.
- **Always-on:** the two kernel manifests are `toggleable: false`.
- **Golden composition:** `composePageAccess()` reproduces the composed
  `PAGE_ACCESS` map exactly (`dashboard`, `module-off`, `settings`,
  `systemstatus` from `core`; `members`, `committees`, `portal`, `protokolle`,
  `beschluesse` from `governance`; then each enabled module's own segments);
  `moduleRoutePrefixes()` is exactly the toggleable modules' prefixes in
  registration order (the two kernel manifests add none); `composeCapabilities()`
  is pinned the same way.

The codegen barrel is rebuilt by `pnpm --filter gremion-ui prebuild` (which runs
the module overlay with `--migrations`, `build-module-manifest.mjs`,
`build-module-server-init.mjs`, and the two migration-manifest builds). Re-run
the codegen after adding, removing, or re-ordering a manifest or the golden reds.

### Add-a-module proof — `add-a-module.proof.test.ts`

`src/lib/modules/add-a-module.proof.test.ts` is the executable companion to the
add-a-module playbook. It proves the module-SDK contract: a **net-new** vertical
module (`demo_vertical`, a throwaway manifest deliberately **not** registered in
the real barrel) plugs into every composition seam — page-access,
route-prefixes, capabilities, nav, realm (KC groups/roles + scope mappings),
default-config toggle, migration gating, and OFF→ON runtime catch-up — purely
from its manifest, with **zero** edits to the shared composition files. The
deselect half proves that disabling a toggleable module removes it from every
one of those seams.

The seams come in two shapes, each injected the way the existing golden tests
do:

- **List-parameterised pure seams** (`composeNavSchema`, `composeRealm`,
  `disabledModuleMigrationFiles`, `moduleReenableCatchup`) take the mock
  manifest list as an argument.
- **Global-set seams** (`composePageAccess`, `moduleRoutePrefixes`,
  `composeCapabilities`, `defaultModulesConfig`, and via `moduleRoutePrefixes`
  the module-gate) read the global `MODULE_MANIFESTS`; the test `vi.doMock`s the
  `$lib/modules/manifests` barrel so the global set is the two real kernel
  manifests (`core`, `governance`) plus `demo_vertical`.

The throwaway `demo_vertical` is what exercises the generic deselect contract
without naming a real module; `core`/`governance` are always-on and never
deselect. The per-module deselection of the real modules is pinned separately by
`scripts/check-module-deselectable.test.mjs`.

---

## Mocking patterns (Vitest)

### Env vars — `$env/dynamic/private`

Server modules import from `$env/dynamic/private`. Mock it with a **mutable
object** defined outside `describe`, and reset it in `beforeEach`:

```typescript
const mockEnv = {
  AUTH_KEYCLOAK_ISSUER: 'https://example.test/auth/realms/gremion',
}

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules() // singletons re-read env on next import
})
```

> **Do not use `$env/static/private`** in server modules — static vars must
> exist at Vite build time and break Docker image builds where env is injected
> at runtime. Always use `$env/dynamic/private` with a `??` fallback default,
> and never throw on an empty env var in a server factory.

### fetch — `vi.stubGlobal`

```typescript
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
```

### URLSearchParams bodies

When passing a `URLSearchParams` as a fetch body, always call `.toString()`:

```typescript
body: new URLSearchParams({ grant_type: 'client_credentials' }).toString()
```

**Why:** `@mswjs/interceptors` (a transitive test dep) hooks Node's `http`
module on Linux and reconstructs the `Request` internally; its
`instanceof URLSearchParams` check fails cross-realm and crashes the affected
tests in CI. `.toString()` produces the identical encoded string without the
type issue.

### Lazy singletons + `vi.resetModules()`

Server clients (e.g. the Keycloak admin client) export lazy module-level
singletons. Because the instance is cached at module scope, call
`vi.resetModules()` in `afterEach` and re-import the module dynamically inside
each test so it re-reads the mocked env.

### Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Request constructor: Expected init.body to be an instance of URLSearchParams` | `@mswjs/interceptors` cross-realm `instanceof` on Linux | Call `.toString()` on any `URLSearchParams` fetch body |
| Tests pass locally, fail in CI | `vi.mock('$env/dynamic/private')` intercept is unreliable on Linux Node | Use `??` fallbacks in production code; never throw on empty env in a server factory |
| A server-client singleton returns stale env values | Singleton cached from a previous test | Add `vi.resetModules()` in `afterEach` and re-import dynamically |

---

## Infrastructure tests (BATS)

The repo's shell scripts and infra wiring are covered by BATS. These are
independent of the application Vitest suites and driven by the root `Makefile`.

### Prerequisites

BATS is an **external prerequisite** — it is not vendored in this repo. Install
it once, globally, and the `Makefile` picks it up from `PATH`:

```bash
npm install -g bats          # any platform
# or: sudo apt-get install -y bats     (Debian/Ubuntu)
# or: brew install bats-core           (macOS)

bats --version               # verify
```

> **Historical note.** `.gitmodules` used to declare `bats-core`,
> `bats-support` and `bats-assert`, but the gitlinks were never committed — the
> repo had a `.gitmodules` and **zero** tree entries of mode `160000`. A
> submodule init was therefore always a no-op, and the vendored BATS path never
> existed in any clone; every runner silently fell back to `bats` on `PATH`,
> which is what actually ran the suite. The declaration and
> `test/install-bats.sh` were dropped rather than pinned to SHAs: no `.bats`
> file in this repo loads `bats-support` or `bats-assert` (they all load only
> `test/test_helper/common.bash`), so two of the three were dead weight — and
> vendoring a test runner buys nothing over one global install.
>
> Enforced by `scripts/kernel-hygiene-check.mjs` (checks `a1`–`a9`), which fails
> if any doc or build file starts recommending a submodule route again.

Linting tools (also run in CI):

```bash
sudo apt-get install shellcheck   # or: brew install shellcheck
pip install yamllint
```

### Running

```bash
make test            # unit (no containers)
make test-integration  # requires a running stack
make test-all        # unit + integration + the NATS, nats-auth and events proofs
make lint            # the lint-* targets: shellcheck, yamllint, json, compose and the repository guards
make lint-js         # oxlint (see docs/lint.md); run by the verify carve-lint suite
make verify          # the verify gate
make health          # service status + Keycloak/legal reachability (its gremion-ui line reads NOT REACHABLE locally, see LOCAL_TESTING.md)
```

- **Unit (`make test-unit`):** globbed, not listed: `test/*.bats` (setup,
  backup, restore, configure-keycloak, legal, realm fixtures and others) and
  `test/host/*.bats` (the distribution-host tooling). `test/integration/` is
  deliberately not matched. `test/host/no-host-literals.bats` asserts the recipe
  still collects every file under `test/host`.
- **Integration (`make test-integration`):** `test/integration/health.bats`,
  `test/integration/oidc.bats`, `test/integration/legal.bats` and
  `test/integration/login-theme.bats` — these need a running stack (`make up`; a
  bare `docker compose` addresses neither dev project, a single service is
  started with the `$DS` prefix from
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md#default-services--host-ports-local-dev),
  for example `$DS up -d keycloak`).
- **Windows development box:** `make test-unit` cannot run there; `make
  test-host-docker` runs `test/host/*.bats` in a Linux image.
- **Lint targets:** `lint-sh` (shellcheck), `lint-yaml` (yamllint against the
  compose files, the override, the app files and `k8s/`), `lint-json` (validates
  `docker/keycloak/realm-export.base.json`), `lint-compose` (`docker compose
  config`), and the repository guards (`lint-hygiene`, `lint-pooled-stack`,
  `lint-module-scan` and the rest of the `lint` aggregate in the `Makefile`).

### The stack under test

The infra integration tests run against a stack started with `make up` (the
state project plus the `blue` app project, `docker-compose.yml` with its override
and `docker-compose.app.yml` with `docker-compose.app.dev.yml`; see
[architecture.md](architecture.md), "Component overview"). They verify health,
OIDC wiring, legal rendering and the login theme of the services that start
without a module profile; the Nextcloud, Matrix/Synapse, LiveKit and module
services start only under their compose profiles and are not part of this set.

### Writing a BATS test

Each `.bats` file is a collection of `@test` blocks:

```bash
#!/usr/bin/env bats
load 'test_helper/common'

@test "my script does the right thing" {
    run bash scripts/my-script.sh --some-flag
    [ "$status" -eq 0 ]
    [[ "$output" == *"expected output"* ]]
}
```

Key BATS variables: `$status` (exit code), `$output` (stdout), `$lines`
(line array). Use the helpers in `test/test_helper/common.bash`
(`setup_temp_dir` / `teardown_temp_dir`).

For a new script: create `test/<name>.bats`, add `load 'test_helper/common'`,
cover (script exists + executable, has `set -euo pipefail`, validates required
env, expected output for known inputs, graceful failure for invalid inputs),
then add it to the `Makefile` `test-unit` target.

Integration tests go in `test/integration/`; use
`run docker compose exec -T <service> <command>` for container checks,
`run curl -sf <url>` for HTTP checks, and `skip "reason"` for steps that
require manual setup.

> **Keycloak readiness:** the management health endpoint
> (`/auth/health/ready`) runs on internal port 9000, not mapped in local dev or
> CI. To verify Keycloak is up from a test, hit `/auth/realms/master` (or the
> governance realm) instead.

---

## Troubleshooting

### BATS not found

BATS is external — install it and make sure `PATH` picks it up:

```bash
npm install -g bats
command -v bats && bats --version
```

### Integration tests fail with "container not running"

```bash
make ps     # which services are up
make up     # start them
```

### shellcheck false positives

Add an inline disable with a reason, e.g.:

```bash
# shellcheck disable=SC2086  # word splitting intentional here
echo $unquoted_var
```

### yamllint errors

```bash
yamllint -c .yamllint.yml docker-compose.yml
# common fixes: trailing spaces, indentation, missing document start
```

### Vitest: integration suite refuses to boot

The integration config fail-closed-guards `DATABASE_URL` /
`CONTROL_DATABASE_URL`. If Vitest exits before any test runs, read the
`[no-truncate-guard]` line: it names the variable and the fix. Most often
`GREMION_PRODUCTION_STACK` is unset (`none` on a host without a production
unit), or the URL is not a test database on loopback / not a `postgres-<stack>`
host of a non-production stack. Then check that Postgres is reachable.
