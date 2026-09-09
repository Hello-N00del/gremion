# Authentication & Authorization

Source of truth for how the Gremion kernel app shell (`gremion-ui`) decides who a
request is and what they may do. When the role list, the page→role table, or the
boot gate changes in code, this file changes with it.

This is the operational/technical layer. For the vision, the open-core boundary,
and where the auth slice sits in the kernel architecture, see
[`about-gremion.md`](./about-gremion.md).

> **Carved-out modules.** The kernel ships only the always-on `core` and
> `governance` modules. Finance, files, messaging, calendar, voting/elections,
> content/newsletter, the task board, and the mobile app live in the separate
> private module repos. Where a hook or helper has a seam for those modules
> (e.g. the module-disable gate, or the finance-named capability helpers in
> `group-helpers.ts`), this doc describes the kernel behaviour — the seam is
> present and inert until such a module is installed.

---

## 1. Role hierarchy

Enum: [`gremion-ui/src/lib/auth/types.ts`](../gremion-ui/src/lib/auth/types.ts).
Hierarchy + `hasRole` / `canAccess`:
[`gremion-ui/src/lib/auth/index.ts`](../gremion-ui/src/lib/auth/index.ts).

There are **4** roles, forming a strict containment chain — `ITAdmin` contains
every other role and `Guest` contains only itself.

| Role | String value | Intent |
|------|--------------|--------|
| `Guest` | `guest` | Signed in but no further claims. Sees the dashboard plus the guest-visible governance surfaces (committees, protokolle, beschluesse). Default fallback when an access token carries no recognised realm role. |
| `Member` | `member` | Regular member. Adds the members directory. |
| `CouncilAdmin` | `council-admin` | Elected council admin (Vorstand). Adds the council portal (`/portal`). |
| `ITAdmin` | `it-admin` | Highest privilege. Adds `/systemstatus` and the admin sections of `/settings`; transitively contains everything below. |

`ROLE_HIERARCHY` in `gremion-ui/src/lib/auth/index.ts`:

```
ITAdmin       → [ITAdmin, CouncilAdmin, Member, Guest]
CouncilAdmin  → [CouncilAdmin, Member, Guest]
Member        → [Member, Guest]
Guest         → [Guest]
```

`hasRole(userRoles, required)` returns true iff any of `userRoles` expands to a
set containing `required`. So `ITAdmin` passes every check; `Member` passes
`Member` and `Guest` but not `CouncilAdmin`.

The string values (`guest`, `member`, …) are the exact realm-role names expected
from Keycloak. `sessionUserFromPayload`
([`gremion-ui/src/hooks.server.ts`](../gremion-ui/src/hooks.server.ts)) filters
`realm_access.roles` through the resolved tenant's role vocabulary (the default
tenant resolves to the four `Role` enum values); any realm role not in the
vocabulary is dropped silently, and a user left with no recognised role defaults
to `[Guest]`.

Coarser-grained distinctions that the four-role chain cannot express (e.g.
council-admin vs. it-admin, or any group a feature module contributes) are
handled by the parallel, non-hierarchical group/capability layer in §7.

---

## 2. PAGE_ACCESS mapping

`PAGE_ACCESS` in
[`gremion-ui/src/lib/auth/index.ts`](../gremion-ui/src/lib/auth/index.ts) maps URL
segment 1 (`/committees/anything` → `committees`) to the minimum required role.
It is **composed from the per-module manifests** via `composePageAccess()` — each
segment is declared by its owning module under `$lib/modules/manifests/*`, where
the per-segment rationale lives. In the kernel that is two manifests:
[`core.ts`](../gremion-ui/src/lib/modules/manifests/core.ts) and
[`governance.ts`](../gremion-ui/src/lib/modules/manifests/governance.ts).

`authGuard` extracts the segment via `path.split('/')[1] || 'dashboard'` and
calls `canAccess(roles, segment, pageAccessForTenant(tenant))`. **Segments not in
the table are denied by default** — `canAccess` returns `false` on `undefined`,
which trips a redirect to `/auth/login?error=forbidden`. In `pnpm dev` an unknown
segment throws instead, so a new route directory without a matching manifest
entry surfaces loudly rather than silently 403-ing.

The kernel's composed entries, verbatim from the manifests:

| Page segment | Minimum role | Owning manifest | Notes |
|--------------|-------------|-----------------|-------|
| `dashboard`   | `Guest`        | core       | Default landing for any authenticated user. |
| `settings`    | `Member`       | core       | Reachable by every signed-in member (Konto sections); the Verwaltung/System admin sections are gated inside the page by `isITAdmin` and each `/api/settings*` endpoint keeps its own it-admin gate. |
| `systemstatus`| `ITAdmin`      | core       | Provisioning-convergence page (control-plane vs. silo data-plane + active-module catalog); retry/repair actions gate further inside the page. |
| `members`     | `Member`       | governance | Members directory. |
| `committees`  | `Guest`        | governance | Gremien & Referate — council structure, guest-visible (matches protokolle/beschluesse). |
| `portal`      | `CouncilAdmin` | governance | Council portal. |
| `protokolle`  | `Guest`        | governance | Minutes archive — read-only, public-authenticated. |
| `beschluesse` | `Guest`        | governance | Resolutions (Beschlüsse) archive — read-only, public-authenticated. |

When adding a top-level route, add its segment to the owning module's manifest
`pages` list (not to a literal map). A build-time coverage test
(`page-access-coverage.test.ts`) compares the composed `Object.keys(PAGE_ACCESS)`
against `src/routes/*` and fails CI on drift; `PAGE_ACCESS_PUBLIC_SEGMENTS`
(`auth`, `legal`, `setup`, `api`) lists the directories intentionally allowed to
lack an entry.

### Per-tenant page access

`pageAccessForTenant(ctx)` is what the guard and nav consume. The default tenant
(no `config.roles` override) resolves to the same golden `PAGE_ACCESS` object, so
its behaviour is byte-identical to the composed literal. An override tenant
delegates to the vocabulary-arg compose seam; only an **absent** `config.roles`
means "default" — an explicit `[]` is a narrowing override.

---

## 3. authGuard flow

[`gremion-ui/src/hooks.server.ts`](../gremion-ui/src/hooks.server.ts) exports
`authGuard`, composed in
`sequence(correlationHandle, tenantResolveHandle, tenantBrandStyleHandle, authHandle, authGuard, cspGuard)`.
Per-request flow, top to bottom:

### 3.1 Boot-503 short-circuit (G-014, T4.1)

`boot()` runs once on cold start. It waits for the database, runs the
control-plane migrations, registers the default tenant, then runs the data-plane
**fleet** migrations over every active tenant and only then sets
`_bootComplete = true`. A **control-plane** failure populates `_bootError` and
sets `process.exitCode = 1` so an orchestrator can recycle the container. A
single **tenant's** data-plane migration failure no longer fails boot: it lands
in the per-tenant readiness map and that tenant is served a tenant-scoped 503
with a lazy re-migration retry, while every other tenant serves normally.

`authGuard` checks `_bootComplete` first:

- `_bootError` set → permanent `503 Service Unavailable: boot failed`.
- Still booting → `503 Service Unavailable: booting` with `Retry-After: 5`.
- Complete → fall through.

Prevents the failure mode where a half-migrated DB still accepts traffic.

### 3.2 Default locals (G-006, T2.1)

Before any branching, `authGuard` initialises `event.locals.user = null`,
`event.locals.accessToken = null`, and `event.locals.accessTokenExpires = null`.
This is the **single place** in the request pipeline that populates the user and
the access token; downstream API routes read `locals.accessToken` directly rather
than calling `locals.auth()` again, avoiding a race-prone double-invocation.

### 3.3 Public paths bypass

These prefixes skip the session lookup and call `resolve(event)` directly (the
correlation + tenant-resolve handles ahead of `authGuard` still run):

```
/auth/                       Sign-in / sign-out / callback
/legal/                      Datenschutz, Impressum, Barrierefreiheit
/setup                       First-run setup wizard
/api/setup/seed              One-shot prod seed — guarded by X-Seed-Token + empty-DB
/api/health                  Unauthenticated boot-status probe (no secrets)
/api/public/protocols/       Published-protocol PDF download — self-enforces published + public visibility
```

### 3.4 Bearer JWT path (`/api/**` only)

For `/api/` paths, `authGuard` inspects the `Authorization` header. If
`Bearer <token>` is present:

1. `verifyBearerJwt(token, locals.tenant)`
   ([`gremion-ui/src/lib/server/jwt-verify.ts`](../gremion-ui/src/lib/server/jwt-verify.ts))
   validates against the resolved tenant's Keycloak JWKS, issuer, and `exp`.
2. `sessionUserFromPayload(payload, vocabulary)` builds a `SessionUser`
   (`sub` / `preferred_username` / `jti` fallback for the user id;
   `realm_access.roles` filtered through the tenant role vocabulary; `groups`,
   `loa`, and `authTime` carried through for §6/§7).
3. **iss-match backstop:** the token verified against *some* realm, but it must be
   *this* host's tenant realm — `bearerTenantMatches` compares the token `iss`
   against the resolved tenant issuer. A mismatch returns `403 TenantMismatch`
   (the caller is authenticated, just against the wrong tenant) before any
   data-plane query.
4. `locals.user`, `locals.accessToken`, and a synthesised `locals.auth` are
   populated. The Bearer token IS the upstream Keycloak access token consumed by
   the server-side handlers.
5. The module-disable gate (§4) runs, then `resolve(event)` returns — the cookie
   path is skipped.

External / service clients authenticate this way; the web frontend never does.

### 3.5 Auth.js session path (everything else)

1. `session = await event.locals.auth()` materialises the SvelteKitAuth session
   from the encrypted cookie.
2. If `!session?.user` **or** the session carries `error` (set by the `jwt`
   callback on refresh/decode failure — see §6): a `/api/` path answers with a
   machine-readable `401` JSON (a 302 to the HTML login page makes a client
   `fetch().json()` throw `Unexpected token '<'`); a page redirects to
   `/auth/login?callbackUrl=<encoded path>`.
3. `event.locals.user = session.user`; lift the upstream Keycloak access token
   and its expiry into `locals.accessToken` / `locals.accessTokenExpires`.
4. **Session iss checks.** A session without a recorded `tokenIss` claim is a
   stale pre-spine cookie — re-auth via the same api/page split as step 2 (401
   JSON for `/api/`, 302 to login for pages). A **present but mismatched** issuer
   is a genuine cross-tenant replay and returns the hard `403 TenantMismatch`.
5. Non-API routes: `canAccess(roles, segment, pageAccessForTenant(tenant))`.
   Failure → redirect to `/auth/login?error=forbidden&callbackUrl=…` (not `/`,
   to avoid a loop when the user lacks dashboard access).
6. `/api/**` routes skip the page-level check (each handler enforces its own role
   rules) and run the module-disable gate (§4); then `resolve(event)`.

---

## 4. Module-disable gate

The kernel composes its route map and module toggles from the manifests. Both
kernel manifests (`core`, `governance`) are `toggleable: false`, and
`REQUIRED_MODULES` is empty, so `defaultModulesConfig()` is `{}` — **the kernel
has no toggleable modules and nothing is gated off by default**. The gate machinery
nonetheless ships, because a feature module installed on top of the kernel is
toggleable per tenant.

[`gremion-ui/src/lib/server/module-gate.ts`](../gremion-ui/src/lib/server/module-gate.ts)
exposes:

- `disabledModuleForPath(pathname, config?)` — the id of the toggleable module
  that owns `pathname` **and** is disabled in the current tenant's config, or
  `null`. The prefix→module map comes from `moduleRoutePrefixes()` (composed from
  the manifests, P0.1).
- `moduleGateResponse(pathname, config?)` — returns a bare `403 Module disabled`
  for a disabled-module `/api/*` prefix, else `null`.

`authGuard` calls `moduleGateResponse` for `/api/*` paths on **both** the Bearer
and cookie branches (#256-1: a Bearer caller must pass the same gate as a cookie
session). A disabled-module **page** deep link is handled in
`+layout.server.ts` instead — the layout load throws so SvelteKit can render the
styled "Modul nicht aktiv" surface (a throw from this hook would render only the
bare static error template). Disabling a module never removes a role grant; it
just makes that module's routes 403 until it is re-enabled in `/settings`.

---

## 5. Level of Assurance (LoA) / ACR step-up

The kernel models a two-tier Level of Assurance so a sensitive governance action
(for example confirming a resolution or a Vier-Augen-style approval contributed by
a module) can require a fresh, stronger authentication than the ambient session.

Pure helpers live in
[`gremion-ui/src/lib/auth/step-up.ts`](../gremion-ui/src/lib/auth/step-up.ts)
(provider-agnostic and clock-injected, so they are deterministically testable):

```ts
export const LOA = { PASSWORD: 1, STEP_UP: 2 } as const

// Mirrors the realm acr.loa.map; unknown/absent → 0.
export const ACR_TO_LOA = { loa1: 1, loa2: 2, '1': 1, '2': 2 }
export function acrToLoa(acr): number              // → 0 | 1 | 2

export function evaluateStepUp(
  subject: { loa: number; authTime: number },
  requiredLoa: number,
  opts: { nowMs: number; freshnessSeconds: number },
): { ok: true } | { ok: false; requiredLoa: number; reason: 'loa' | 'stale' }
```

How it is sourced and enforced:

- Keycloak issues the authentication context in the access-token `acr` claim and
  the authentication time in `auth_time`. `sessionUserFromPayload` maps `acr`
  through `acrToLoa` onto `SessionUser.loa` and copies `auth_time` to
  `SessionUser.authTime` (epoch seconds).
- `evaluateStepUp` is the decision: a `requiredLoa` of `PASSWORD` always passes;
  a higher requirement fails with reason `'loa'` if the subject's assurance is
  too low, or `'stale'` if the step-up authentication is older than
  `freshnessSeconds`. Anchoring freshness on the server-side authentication time
  (rather than trusting the token alone) keeps the freshness window honest even
  when Keycloak omits a usable timestamp.

The kernel ships the LoA primitive and threads `loa` / `authTime` onto every
session. The concrete protected actions that *call* `evaluateStepUp` are owned by
the surfaces that need them (governance and feature modules); a fresh kernel with
no such action has no live caller.

---

## 6. Token decode rules (post-G-018 / T4.3)

Decoding the Keycloak access token to extract realm roles + groups lives in
[`gremion-ui/src/lib/auth/decode.ts`](../gremion-ui/src/lib/auth/decode.ts) as
`safeDecodeAccessToken`. It uses `jose.decodeJwt` (payload-only — signature and
issuer are already enforced upstream by Auth.js / `verifyBearerJwt`).

The function returns a discriminated union:

```ts
type DecodedAccessToken =
  | { realmRoles: string[]; sub?: string; groups: string[]; preferredUsername?: string }
  | { error: 'TokenDecodeFailed' }
```

Callers must handle the `error` branch — there is no silent fallback to `{}`.
The `jwt` callback in [`gremion-ui/src/auth.ts`](../gremion-ui/src/auth.ts)
propagates the failure to the session as `{ ...token, error: 'TokenDecodeFailed' }`
on both the initial-login path and the refresh path. `authGuard` then sees
`session.error` and forces re-login (§3.5 step 2). An undecodable token **always**
triggers re-authentication.

Typed error values produced by the `jwt` callback, all of which force re-login:

- `RefreshTokenMissing` — no refresh token in the session.
- `RefreshTokenExpired` — Keycloak returned non-2xx on refresh.
- `RefreshTokenFailed`  — network / throw inside the refresh fetch.
- `TokenDecodeFailed`   — `safeDecodeAccessToken` returned the error branch
  (initial login or post-refresh).

---

## 7. Group-based capabilities

The four-role enum in §1 is a coarse, strictly-nested containment chain. Finer,
non-hierarchical distinctions — and any capability a feature module contributes —
ride on a parallel **group/capability** layer.

### 7.1 Where groups come from

Keycloak issues the user's group memberships in the OIDC access-token `groups`
claim. `safeDecodeAccessToken` (§6) extracts them, the `jwt` callback in
[`gremion-ui/src/auth.ts`](../gremion-ui/src/auth.ts) lifts them onto the session, and
they surface as **`session.user.groups: string[]`** (typed in
[`gremion-ui/src/lib/auth/types.ts`](../gremion-ui/src/lib/auth/types.ts)).

Groups are flat strings — there is no containment relationship between them. A
user can hold any subset.

### 7.2 The capability seam

[`gremion-ui/src/lib/auth/capabilities.ts`](../gremion-ui/src/lib/auth/capabilities.ts)
is the kernel-side capability seam. It is client-safe and **must not** depend on
any feature module:

- `CapabilityId` is the generic kernel id type (`string`); concrete per-module
  unions narrow it inside the owning module.
- `CAPABILITIES` is built by the registry's `composeCapabilities()` — the single
  composition point. Every installed module contributes its own
  `{ capabilityId → groups[] }` map. In the kernel only `core` contributes,
  exposing the platform group literals.
- `PLATFORM_GROUPS` is sourced from the always-on `core` manifest:

  | Constant | Group string | Meaning |
  |----------|--------------|---------|
  | `PLATFORM_GROUPS.admin` | `admin` | Council admin (Vorstand) — broad administrative scope. |
  | `PLATFORM_GROUPS.itAdmin` | `it-admin` | IT admin — highest privilege. |

- `capabilitiesForTenant(ctx)` is the tenant-aware accessor (the default tenant
  resolves to the same golden `CAPABILITIES` object); `capabilityGroups(id)`
  returns the any-of group set that grants a capability.

A feature module (finance, etc.) brings its own group literals and capability
ids — those are absent from a kernel-only build.

### 7.3 The role-helper API

[`gremion-ui/src/lib/auth/group-helpers.ts`](../gremion-ui/src/lib/auth/group-helpers.ts)
exports `makeAuthHelpers(session, capabilities?)`, which reads **only**
`session.user.groups` (it accepts both the full `SessionUser` and the lighter
`{ user: { groups } }` shape used in tests and server loads). The optional second
argument lets a tenant-aware caller pass `capabilitiesForTenant(tenant)`; the
default is the golden `CAPABILITIES`.

The helpers are pure `hasAny(...)` checks over the group set:

| Helper | Returns true iff the user is in any group granting | Kernel behaviour |
|--------|----------------------------------------------------|------------------|
| `hasGroup(g)` | exactly `g` | always available — low-level membership test |
| `hasAny(...gs)` | any of `gs` | always available — building block |
| `canApproveAny()` | `finance.approve.any` | the finance feature contributes this capability; **absent in the kernel → `false`** |
| `canEditBudget()` | `finance.budget.edit` | as above → `false` |
| `canApproveBudget()` | `finance.budget.approve` | as above → `false` |
| `canConfigureFints()` | `finance.fints.configure` | as above → `false` |
| `canManageSubOrgs()` | `finance.suborgs.manage` | as above → `false` |

The finance-named helpers are part of the seam, not the kernel feature set. Each
looks up a capability id the **finance module** contributes; in a kernel-only
build those ids are absent from the composed `CAPABILITIES` map, so the helper
resolves an empty group list and degrades to `false` (the capability is simply
ungranted) rather than crashing. They light back up automatically when the
finance module is installed.

> These predicates gate **UI affordances** (which buttons/links to render). They
> are not the last line of defence — the relevant API routes re-check eligibility
> server-side. The UI mirrors the server rules so it never offers a button the
> API will only reject.

### 7.4 Sidebar nav `needs[]` + `filterNavForSession`

[`gremion-ui/src/lib/components/layout/nav-schema.ts`](../gremion-ui/src/lib/components/layout/nav-schema.ts)
declares the sidebar as a `navSchema: NavItem[]`. Each `item` or `section` may
carry an optional **`needs: string[]`** — the list of groups, **any** of which
grants visibility (OR semantics). Items with no `needs` are visible to everyone.

`filterNavForSession(navSchema, helpers)` (same module) applies the helpers:

- An item is hidden when it has `needs` and `helpers.hasAny(...needs)` is false.
- A `section` collapses entirely when **all** of its children are hidden — empty
  sections are pruned so no dangling header renders.

It is wired in
[`gremion-ui/src/routes/+layout.server.ts`](../gremion-ui/src/routes/+layout.server.ts):
the layout load builds the helpers from `session.user.groups` (via
`capabilitiesForTenant(tenant)`), calls `filterNavForSession`, and returns the
filtered `nav` plus any badge counts.

Some nav items are gated by **role** (`Role.*`) rather than `needs[]` groups — in
particular Portal-Verwaltung (`/portal`) is gated by `Role.CouncilAdmin` (see
`nav-schema.ts`).

### 7.5 Page-level view-gate (the `/members` admin list)

Nav filtering only hides links; it does **not** enforce anything against a direct
URL hit. `/members` itself is **not** group-403'd — every signed-in member
reaches it (`PAGE_ACCESS` gates the segment at `Role.Member`). What the page does
instead is gate the *admin view* server-side in its `load`
([`gremion-ui/src/routes/members/+page.server.ts`](../gremion-ui/src/routes/members/+page.server.ts)):
it computes an `isAdmin` flag by **role** and passes it to the loader, so admins
get the full list while basic members get the narrowed one.

```ts
const isAdmin = !!user && (hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin))
const members = await listMembers({ adminView: isAdmin })
return { members, isAdmin }
```

When a surface genuinely needs a hard group-scoped 403 (rather than a
view-narrowing flag), rebuild the helpers from `locals` and throw in the `load`,
keeping the `needs` on the matching nav item and the `hasAny(...)` in the gate in
lockstep — change one, change both.

### 7.6 Relationship to the §1 role enum

The two layers coexist: `authGuard` (§3) always runs the coarse `PAGE_ACCESS`
role check on every non-API page request. The group helpers add a **finer** gate
*on top of* that coarse check — they never replace it. A segment reachable by a
given role per `PAGE_ACCESS` may still have individual sub-features and buttons
gated by the group/capability layer for that specific user.

---

## 8. Keycloak configuration

The kernel uses Keycloak as the OIDC provider for both the cookie session (web
frontend) and the Bearer path (service/external clients). The relevant
environment (see [`.env.example`](../.env.example)):

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | SvelteKitAuth cookie/session encryption secret. |
| `AUTH_KEYCLOAK_ID` | OIDC client id for the app shell (`gremion-ui`). |
| `AUTH_KEYCLOAK_SECRET` | OIDC client secret (set after realm import). |
| `AUTH_KEYCLOAK_ISSUER` | Issuer URL, e.g. `http://keycloak:8080/auth/realms/<realm>`. |
| `KEYCLOAK_ISSUER_URL` | Issuer used by the server-side JWKS / Bearer verification. |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service-account secret for `gremion-ui` → Keycloak admin API calls. |
| `KC_ADMIN_ALLOWLIST_CIDRS` | CIDR allowlist for the Keycloak admin console / Admin REST API. |

OIDC client secrets are substituted into `realm-export.json` at container start.
The Keycloak realm encodes the LoA mapping (`acr.loa.map`) that §5's `ACR_TO_LOA`
mirrors. Keycloak runs as one of the kernel's default services (see
[`about-gremion.md`](./about-gremion.md) for the governance-only service set).
