# Gremion UI — Testing Guide

Test reference for the Gremion admin shell (`gremion-ui`) and the public portal (`gremion-public`). This file covers **UI testing** only: Vitest unit tests for UI server-clients and Playwright end-to-end tests of the governance surfaces.

- For the kernel's vision, architecture, and governance charter, see [about-gremion.md](about-gremion.md).
- For infrastructure, migration, and integration tests, see [TESTING.md](TESTING.md).

Gremion is the open-core governance kernel: identity & auth (Keycloak OIDC), multi-tenancy, and the governance domain (committees, members, org-unit tree, protocols, resolutions/Beschlüsse, public portal). Feature modules (elections, newsletter, calendar, files, messages, board, users, finance, content, vault, handover) live in their own repositories — one per module — and ship their own tests; nothing in this guide concerns them.

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
│   │   └── config.test.ts                 ← ConfigStore
│   └── routes/
│       ├── api/users/email-export.test.ts
│       ├── api/setup/setup-api.test.ts
│       └── settings/settings.test.ts
└── tests/unit/
    ├── auth.test.ts                       ← session/auth helpers
    ├── session.test.ts
    ├── check-domain-regex.test.ts         ← tenant host/domain matching
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
pnpm exec playwright test tests/e2e/users.spec.ts     # one spec
pnpm test:all                                          # vitest + playwright
```

Config lives in `gremion-ui/playwright.config.ts`:

- `testDir: tests/e2e`, single Chromium project, `fullyParallel: false`, one retry.
- `baseURL` defaults to `http://localhost:5173` (override with `PLAYWRIGHT_BASE_URL`).

### Test locations

```
gremion-ui/tests/e2e/
├── auth.spec.ts          ← login redirect, Keycloak sign-in button, public legal pages
├── navigation.spec.ts    ← protected routes redirect to login; sidebar hidden on login
├── users.spec.ts         ← member invite, role assignment, group creation
├── protocols-b4.spec.ts  ← committee protocols, resolutions (Beschlüsse), Beschlussregister
└── smoke.spec.ts         ← @smoke post-build gate (server boots, root + login render)
```

### Fixture assumptions

Most authenticated specs run against a local dev stack (`pnpm dev` + `docker compose up`) with a pre-seeded Keycloak realm. The `users.spec.ts` suite, for example, assumes:

- A council-admin user: `admin@test.local` / `Test1234!`
- At least one existing group (e.g. `test-gruppe`)

The governance specs read fixtures from env vars with safe fallbacks, e.g. `TEST_COMMITTEE_ID`, `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`, `TEST_GUEST_EMAIL`, `TEST_GUEST_PASSWORD`. Set them to match your seeded realm.

### What the governance specs cover

- **Auth & access** (`auth.spec.ts`): an unauthenticated visit to `/` redirects to `/auth/login`; the login page bounces to the Keycloak theme (German "Anmelden" button); public legal pages (`/legal/impressum`, `/legal/datenschutz`) render without login.
- **Route protection** (`navigation.spec.ts`): protected routes redirect anonymous users to `/auth/login`, and the main navigation is hidden on the login page.
- **Member & group management** (`users.spec.ts`): inviting a member from `/users`, assigning a role and verifying it via `GET /api/users/:id/roles`, and creating a group from `/users/groups` (provisioning stubs return success).
- **Protocols & resolutions** (`protocols-b4.spec.ts`): an admin creates a committee protocol under `/members/committees/:id/protokolle/new`, adds a resolution (Beschluss) with vote tallies, submits it for vote, and confirms a guest can read a draft but cannot edit or submit it; the Beschlussregister at `/members/committees/:id/beschluesse` lists published resolutions.

### The `@smoke` post-build gate

`smoke.spec.ts` is a deliberately narrow net (selected with `playwright test --grep '@smoke'`) that runs against a live `pnpm preview` instance and only asks: *does the server boot, serve the root, and render login without a 5xx?* It does not replicate the full suite (which needs Keycloak, Postgres seeds, etc.). The three smoke tests assert:

1. `GET /` returns a status `< 500` (anonymous root may render the shell or redirect to login).
2. `GET /auth/login` serves the redirect interstitial markup (`role="status"`) — keyed on the ARIA role rather than copy, since the smoke run has no locale cookie.
3. A protected route redirects an anonymous user with a `30x` whose `Location` matches `/auth/login` (checked via a no-follow `page.request.get(..., { maxRedirects: 0 })` to avoid racing the client-side `signIn('keycloak')` bounce).

### Multi-tenant header gating (`SMOKE_TENANT_HOST`)

The tenant resolver (`src/lib/server/tenant/resolve.ts`) selects the tenant from the **leftmost label** of the edge-forwarded host (`x-forwarded-host`) and 404s any request that resolves no **active** tenant — including the bare apex. It requires at least three host labels.

When `SMOKE_TENANT_HOST` is set (e.g. `default.localhost.localdomain`), `playwright.config.ts` stamps it as `x-forwarded-host` on **every** request (both `page.goto` and `page.request.*`) so routes resolve a seeded tenant. Absent the variable — the normal local/dev run — no extra headers are added, making it a byte-identical no-op. A smoke run that sets this var must also seed an active tenant matching the host's leftmost label.

---

## Notes

- **CI.** GitHub Actions workflows ship in `.github/workflows/`. A fork gets its own runners and they run as written. Before opening a PR, run `pnpm check`, `pnpm test:unit` and `pnpm test:e2e` locally — the gates are the same either way.
- **Docker builds run without env vars** — all server factory functions must use `$env/dynamic/private` with `??` fallbacks (not `$env/static/private` and not throws-on-empty validation), so the image builds before runtime env is injected.
- For integration, deselection, and infrastructure tests (e.g. `pnpm test:integration`, `pnpm test:deselection`), see [TESTING.md](TESTING.md) and [LOCAL_TESTING.md](LOCAL_TESTING.md).
