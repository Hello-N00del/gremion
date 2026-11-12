# Gremion UI — Testing Guide

Test reference for the Gremion admin shell (`gremion-ui`) and the public portal (`gremion-public`). This file covers **UI testing** only: Vitest unit tests for UI server-clients and Playwright end-to-end tests of the governance surfaces.

- For the kernel's vision, architecture, and governance charter, see [about-gremion.md](about-gremion.md).
- For infrastructure, migration, and integration tests, see [TESTING.md](TESTING.md).

Gremion is the open-core governance kernel: identity & auth (Keycloak OIDC), multi-tenancy, and the governance domain (committees, members, org-unit tree, protocols, resolutions/Beschlüsse, public portal). The feature modules live under `modules/` and keep their own tests in their own directories (`pnpm --filter ./modules/<id> test`); this guide does not describe them, except where a Playwright spec below drives a module's landing route in the running app.

---

## gremion-ui Unit Tests (Vitest)

### Quick start

```bash
cd gremion-ui
pnpm test:unit          # run once
pnpm test:unit:watch    # watch mode
pnpm coverage           # with V8 coverage report
```

### Test locations

```
gremion-ui/
├── src/
│   ├── lib/server/
│   │   ├── config.test.ts                 ← ConfigStore
│   │   └── keycloak-admin.test.ts         ← KeycloakAdminClient
│   └── routes/
│       ├── api/users/users.test.ts
│       └── settings/modules-section.ssr.test.ts
└── tests/unit/
    ├── auth.test.ts                       ← session/auth helpers
    ├── session.test.ts
    ├── check-tenant-env-guard.test.ts     ← per-tenant env isolation guard
    ├── check-tenant-secrets-dir.test.ts
    ├── assert-safe-test-db-url.test.ts
    └── server/
        └── keycloak-admin.test.ts         ← KeycloakAdminClient HTTP layer
```

> The tree above is illustrative, not exhaustive — it highlights representative suites, not every test file. Run `pnpm test:unit` for the live total.

### Mocking patterns

#### Env vars — `$env/dynamic/private`

All server modules import from `$env/dynamic/private`. Mock it with a **mutable object** defined outside `describe`:

```typescript
const mockEnv = {
  KEYCLOAK_URL: 'http://keycloak:8080',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-secret',
}

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }))

beforeEach(() => {
  // Reset to known values before each test
  mockEnv.KEYCLOAK_URL = 'http://keycloak:8080'
  mockEnv.KEYCLOAK_ADMIN_CLIENT_SECRET = 'test-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()    // ← required: singletons re-read env on next import
})
```

> **Do NOT use `$env/static/private`** in server modules — static vars must exist at Vite build time and break Docker image builds where env is injected at runtime. Always use `$env/dynamic/private` with `??` fallback defaults.

#### fetch — `vi.stubGlobal`

```typescript
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

// Use in tests:
fetchMock.mockResolvedValue(
  new Response(JSON.stringify({ id: 'group-uuid' }), { status: 200 })
)
```

#### URLSearchParams bodies

When passing `URLSearchParams` as a fetch body, always call `.toString()`:

```typescript
body: new URLSearchParams({ grant_type: 'client_credentials', ... }).toString()
```

**Why:** `@mswjs/interceptors` (a transitive test dependency) hooks into Node's `http` module on Linux and reconstructs the `Request` internally. Its `instanceof URLSearchParams` check fails cross-realm, crashing all affected tests. `.toString()` produces the identical encoded string without the type issue. This works fine on Windows but fails on Linux — the form most commonly hit by the Keycloak admin client's token requests.

#### Lazy singletons + `vi.resetModules()`

Server clients such as `keycloak-admin.ts` export lazy singletons. Because the instance is cached at module level, each test file must call `vi.resetModules()` in `afterEach` and re-import the module dynamically inside each test:

```typescript
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('does something', async () => {
  const { getKeycloakAdmin } = await import('$lib/server/keycloak-admin')
  const kc = getKeycloakAdmin()
  // ...
})
```

### Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| All Keycloak-admin tests fail with `Request constructor: Expected init.body to be an instance of URLSearchParams` | `@mswjs/interceptors` cross-realm instanceof check on Linux | Use `.toString()` on any `URLSearchParams` fetch body |
| Tests pass locally, fail on another platform/CI | `vi.mock('$env/dynamic/private')` intercept unreliable on Linux Node | Use `??` fallback defaults in production code; never throw on empty env vars in server factory functions |
| `getKeycloakAdmin()` returns stale env values | Singleton cached from previous test | Add `vi.resetModules()` in `afterEach` and re-import dynamically |

---

## gremion-ui End-to-End Tests (Playwright)

E2E tests exercise the live governance surfaces against a running stack.

### Quick start

```bash
cd gremion-ui
pnpm test:e2e                                          # full suite
pnpm exec playwright test tests/e2e/smoke.spec.ts     # one spec
pnpm test:all                                          # vitest + playwright
```

Config lives in `gremion-ui/playwright.config.ts`:

- `testDir: tests/e2e`, single Chromium project, `fullyParallel: false`, one retry.
- `baseURL` defaults to `http://localhost:5173` (override with `PLAYWRIGHT_BASE_URL`).

### Test locations

```
gremion-ui/tests/e2e/
├── auth.spec.ts                  ← login redirect, Keycloak sign-in button, public legal pages
├── navigation.spec.ts            ← protected route redirects to login; sidebar hidden on login
├── protocols-b4.spec.ts          ← committee protocols, resolutions (Beschlüsse), Beschlussregister
├── smoke.spec.ts                 ← @smoke post-build gate (server boots, root + login render)
├── i18n-locale.spec.ts           ← the server decides the locale; the browser never rewrites it
├── no-third-party-assets.spec.ts ← no request to a third-party font or icon host
├── module-landing-routes.spec.ts ← signed-in: each enabled module's landing route is served, a disabled one is 404
├── room-admin.spec.ts            ← signed-in: messaging room administration
└── shell-responsive.spec.ts      ← signed-in: the responsive navigation shell
```

### Fixture assumptions

Most authenticated specs run against a local dev stack (`pnpm dev` + `docker compose up`) with a pre-seeded Keycloak realm.

`protocols-b4.spec.ts` reads its fixtures from env vars with safe fallbacks: `TEST_COMMITTEE_ID`, `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`, `TEST_GUEST_EMAIL`, `TEST_GUEST_PASSWORD`. Set them to match your seeded realm. The signed-in specs (`module-landing-routes`, `room-admin`, `shell-responsive`) read `E2E_BASE_URL` and `E2E_ADMIN_USER` / `E2E_ADMIN_PASS` (`shell-responsive` also `E2E_MEMBER_USER` / `E2E_MEMBER_PASS`), and a missing variable **fails** every test rather than skipping it, so an unconfigured run cannot pass vacuously.

### What the governance specs cover

- **Auth & access** (`auth.spec.ts`): an unauthenticated visit to `/` redirects to `/auth/login`; the login page bounces to the Keycloak theme (German "Anmelden" button); public legal pages (`/legal/impressum`, `/legal/datenschutz`) render without login.
- **Route protection** (`navigation.spec.ts`): protected routes redirect anonymous users to `/auth/login`, and the main navigation is hidden on the login page.
- **Locale and assets** (`i18n-locale.spec.ts`, `no-third-party-assets.spec.ts`): the raw response carries the server-chosen `lang`, and the login page makes no request to a third-party font or icon host.
- **Module routes** (`module-landing-routes.spec.ts`): the set of modules is read from `modules/` and `modules/disabled.json`, never restated in the spec.
- **Protocols & resolutions** (`protocols-b4.spec.ts`): an admin creates a committee protocol under `/members/committees/:id/protokolle/new`, adds a resolution (Beschluss) with vote tallies, submits it for vote, and confirms a guest can read a draft but cannot edit or submit it; the Beschlussregister at `/members/committees/:id/beschluesse` lists published resolutions.

### The `@smoke` post-build gate

`smoke.spec.ts` is a deliberately narrow net (selected with `playwright test --grep '@smoke'`) that runs against a live `pnpm preview` instance and only asks: *does the server boot, serve the root, and render login without a 5xx?* It does not replicate the full suite (which needs Keycloak, Postgres seeds, etc.). The three smoke tests assert:

1. `GET /` returns a status `< 500` (anonymous root may render the shell or redirect to login).
2. `GET /auth/login` serves the redirect interstitial markup (`role="status"`) — keyed on the ARIA role rather than copy, since the smoke run has no locale cookie.
3. A protected route redirects an anonymous user with a `30x` whose `Location` matches `/auth/login` (checked via a no-follow `page.request.get(..., { maxRedirects: 0 })` to avoid racing the client-side `signIn('keycloak')` bounce).

### Multi-tenant header gating (`SMOKE_TENANT_HOST`)

The tenant resolver (`src/lib/server/tenant/resolve.ts`) selects the tenant from the **whole** edge-forwarded host (`x-forwarded-host`), looked up in the control registry's `tenant_domain` table, and 404s any request whose host is not bound to an **active** tenant — including the bare apex. Nothing is derived from a host label.

When `SMOKE_TENANT_HOST` is set, `playwright.config.ts` stamps it as `x-forwarded-host` on **every** request (both `page.goto` and `page.request.*`) so routes resolve a seeded tenant. Absent the variable — the normal local/dev run — no extra headers are added, making it a byte-identical no-op. A smoke run that sets this var must also bind that exact host to an active tenant (`addTenantDomain`) first; the host does not resolve by itself.

---

## gremion-public

The public portal has its own checks: `pnpm -C gremion-public check` (i18n compile, `svelte-kit sync`, `svelte-check`), `pnpm -C gremion-public test` (Vitest) and `pnpm -C gremion-public test:e2e` (Playwright; `tests/e2e/` holds `public-portal`, `i18n-locale`, `no-third-party-assets` and `portal-header-reflow`).

---

## Notes

- **CI.** GitHub Actions workflows ship in `.github/workflows/`. A fork gets its own runners and they run as written. Before opening a PR, run `pnpm check`, `pnpm test:unit` and `pnpm test:e2e` locally — the gates are the same either way.
- **Docker builds run without env vars** — all server factory functions must use `$env/dynamic/private` with `??` fallbacks (not `$env/static/private` and not throws-on-empty validation), so the image builds before runtime env is injected.
- For integration, deselection, and infrastructure tests (e.g. `pnpm test:integration`, `pnpm test:deselection`), see [TESTING.md](TESTING.md) and [LOCAL_TESTING.md](LOCAL_TESTING.md).
