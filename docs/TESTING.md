# Gremion — Testing Guide

This document covers the Gremion governance-kernel test strategy: the
application's static checks and Vitest suites (`gremion-ui`), the open-core
boundary backstop, the module-registry golden, the add-a-module proof, and the
infrastructure-level shell/integration tests.

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
| Static checks | `svelte-check` + `tsc` + custom guards | `gremion-ui` Svelte/TS sources, env/port/domain guards | No |
| Unit tests | Vitest | Server clients, API routes, auth, the module SDK, `@gremion/db`, `@gremion/ports` | No |
| Boundary backstop | Vitest | Open-core dependency-direction (kernel never imports a feature module) | No |
| Integration tests (app) | Vitest | DB-backed boot/migration/registry suites | Yes (Postgres) |
| Shell unit tests | BATS | `scripts/`, `docker/` shell scripts | No |
| Infra integration | BATS | Live stack health + OIDC wiring + legal rendering | Yes (running stack) |
| Linting | shellcheck + yamllint | Shell + YAML files | No |
| Config validation | `docker compose config` | Compose files | No |

The kernel ships exactly two module manifests — `core` and `governance` (both
always-on / `toggleable: false`). The Vitest suites described below assert that
the composed surface is precisely the `[core, governance]` set; there are no
finance/voting/content/calendar/files/messaging suites in the kernel.

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

1. `check-tenant-env-guard.mjs --enforce --root src` — tenancy/env-isolation guard
2. `check-app-port-binding.mjs` — app port-binding guard
3. `check-domain-regex.mjs` — tenant-domain regex guard
4. `check-tenant-secrets-dir.mjs` — per-tenant secrets-dir guard
5. `svelte-kit sync` then `svelte-check --tsconfig ./tsconfig.json` — type +
   Svelte diagnostics across the whole app

```bash
pnpm check          # one-shot
pnpm check:watch    # svelte-check in watch mode (skips the standalone guards)
```

### Unit tests — `pnpm test:unit`

The fast, dependency-free suite. Configured in `vite.config.ts` (`test` block):

- **Includes:** `tests/unit/**/*.test.ts`, `src/**/*.test.ts`, and the
  workspace packages `../packages/db/src/**/*.test.ts` and
  `../packages/ports/src/**/*.test.ts`. The two `@gremion/*` packages are
  `noExternal`'d and collected through `gremion-ui`'s Vitest so their
  dependency-free specs (e.g. `client.test.ts`, `broker.test.ts`) run in the
  same pass. (`@gremion/ports` also carries its own `vitest.config.ts` for
  `pnpm -C packages/ports test`.)
- **Excludes:** `**/*.integration.test.ts` (those need a real Postgres — see
  the integration lane).
- `environment: 'jsdom'`, `globals: true`, `setupFiles: ['tests/unit/setup.ts']`,
  `fileParallelism: false`.

```bash
pnpm test:unit              # run once
pnpm test:unit:watch        # watch mode
pnpm coverage               # vitest run --coverage (v8)
```

### Integration tests — `pnpm test:integration`

DB-backed `src/**/*.integration.test.ts` files (real boot, fleet migrations,
control-plane registry). Configured in `vitest.integration.config.ts`. These
require a real Postgres reachable via `DATABASE_URL` (default
`postgres://gremion:gremion_test@localhost:5432/gremion`) and `CONTROL_DATABASE_URL`
(default `…/control`) with migrations applied. The config defaults safe
build-test placeholder secrets and **fail-closed-guards every DB URL** at
config-load time (`assertSafeTestDbUrl`), so Vitest refuses to boot against a
dangerous URL. `fileParallelism` is off — the suites share one Postgres and
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

Post-carve the feature-module directories are removed, so no kernel file can
resolve one today. The backstop is retained so that if a feature module is ever
re-added in-tree and a kernel file imports it, the test reds immediately. It
also enforces a non-vacuous floor (`scanned > 200`) so a path regression that
wiped most of the tree can't make the guard pass silently, and keeps the
documented-exception `ALLOW` map honest (currently empty).

This single test is what would have caught — all at once — the kernel→feature
couplings that per-directory import rules originally missed.

### Registry golden — `registry.test.ts`

`src/lib/modules/registry.test.ts` pins the composed module surface for the
governance-only kernel:

- **Codegen staleness guard:** the committed `manifests/index.generated.ts`
  must byte-equal a fresh `node scripts/build-module-manifest.mjs --stdout`
  run (EOL-normalised), so the generated barrel can't drift from
  `manifests/*.ts`.
- **Exact id set + order:** the generated barrel exposes exactly
  `['core', 'governance']`, in that registration order, and
  `MODULE_MANIFESTS` (via `registry`) **is** that same array (no second source
  of truth). It is a synchronous array, not a Promise.
- **Always-on:** every kernel manifest is `toggleable: false`.
- **Golden composition:** `composePageAccess()` reproduces the kernel
  `PAGE_ACCESS` map exactly (`dashboard`, `settings`, `systemstatus` from
  `core`; `members`, `committees`, `portal`, `protokolle`, `beschluesse` from
  `governance`); `moduleRoutePrefixes()` is empty (no toggleable modules);
  `composeCapabilities()` is empty (neither manifest declares capabilities).

The codegen barrel is rebuilt by `pnpm --filter gremion-ui prebuild` (which runs
`build-module-manifest.mjs`, `build-module-server-init.mjs`, and the two
migration-manifest builds). Re-run the codegen after adding, removing, or
re-ordering a manifest or the golden reds.

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

Because the kernel has no real toggleable feature module to drop, the throwaway
`demo_vertical` is what exercises the deselect contract; `core`/`governance` are
always-on and never deselect.

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
make test-all        # both
make lint            # shellcheck + yamllint + json + compose config
make health          # service status + endpoint reachability
```

- **Unit (`make test-unit`):** `test/setup.bats`, `test/backup.bats`,
  `test/restore.bats`, `test/configure-keycloak.bats`, `test/legal.bats`.
- **Integration (`make test-integration`):** `test/integration/health.bats`,
  `test/integration/oidc.bats`, `test/integration/legal.bats` — these need a
  running stack (`make up`, or `make setup` then `docker compose up -d
  keycloak`).
- **Lint targets:** `lint-sh` (shellcheck), `lint-yaml` (yamllint against the
  compose + override + `k8s/`), `lint-json` (validates
  `docker/keycloak/realm-export.json`), `lint-compose` (`docker compose
  config`).

### The governance-only stack under test

The default `docker compose` stack is **7 services**: `postgres`, `keycloak`,
`gremion-ui`, `gremion-public`, `legal`, `vector`, `mailpit`. The production profile
(`docker-compose.yml`, `profiles: [production]`) adds `traefik` +
`docker-socket-proxy`, and `docker-compose.prod.yml` adds `pgbouncer` +
`cloudflared`. The infra integration tests verify health and OIDC wiring across
this set — there are no finance, Nextcloud, Matrix/Synapse, LiveKit, or Helios
services to start.

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
`CONTROL_DATABASE_URL`. If Vitest exits before any test runs, check the URL is a
safe test database (the guard rejects anything that looks production-like) and
that Postgres is reachable.
