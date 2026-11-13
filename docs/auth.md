# Authentication & Authorization

Source of truth for how the Gremion kernel app shell (`gremion-ui`) decides who a
request is and what they may do. When the role list, the page→role table, or the
boot gate changes in code, this file changes with it.

This is the operational/technical layer. For the vision, the open-core boundary,
and where the auth slice sits in the kernel architecture, see
[`about-gremion.md`](./about-gremion.md).

> **Modules.** The kernel's own manifests are the always-on `core` and
> `governance` modules. The feature modules in this tree (`modules/`, listed in
> [modules.md](./modules.md)) contribute their manifests at build time: the
> default build composes ten (`core`, `governance`, `elections`, `votes`,
> `content`, `newsletter`, `calendar`, `files`, `messages`, `board`); `finance`
> and `vault` are in `modules/disabled.json` and contribute none. Where a hook
> or helper has a seam for those modules (the module-disable gate, the
> finance-named capability helpers in `group-helpers.ts`), this doc describes
> the kernel behaviour and names the module-contributed part as such. The tables
> of page segments and capabilities below list the kernel's own entries.

---

## 1. Role hierarchy

Enum: [`gremion-ui/src/lib/auth/types.ts`](../gremion-ui/src/lib/auth/types.ts).
Hierarchy + `hasRole` / `canAccess`:
[`gremion-ui/src/lib/auth/index.ts`](../gremion-ui/src/lib/auth/index.ts).

There are **7** roles. Four of them form a containment chain (`ITAdmin` contains
`CouncilAdmin`, `Finance`, `Member` and `Guest`); `Vorstand` and `Auditor` stand beside it.

| Role | String value | Intent |
|------|--------------|--------|
| `Guest` | `guest` | Signed in but no further claims. Sees the dashboard plus the guest-visible governance surfaces (committees, protokolle, beschluesse). Default fallback when an access token carries no recognised realm role. |
| `Member` | `member` | Regular member. Adds the members directory. |
| `Finance` | `finance` | Gates the finance module's write surfaces. Confers itself, `Member` and `Guest`. |
| `Vorstand` | `vorstand` | The standard Vorstand role of every council, assigned per person (Karenz phase 1). A recipient role next to `council-admin`, not a rung of the admin ladder: it confers itself plus member-level page access and deliberately NOT `council-admin`, so it cannot switch modules or reach the admin pages. Nothing implies it: a `council-admin` is a Vorstand only when the realm role is assigned. Phase 2 sends the module notices to the admins and the Vorstand. |
| `CouncilAdmin` | `council-admin` | Council administration (shown as "Gremienverwaltung", no longer as "Vorstand"). Adds the council portal (`/portal`) and may switch feature modules on in Settings > Module ([runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md), "Module self-service by the council"). |
| `ITAdmin` | `it-admin` | Highest privilege. Adds `/systemstatus` and the admin sections of `/settings`; transitively contains everything below. |
| `Auditor` | `auditor` | Standalone finance read-only role. Confers itself and `Guest`; its finance see-all is read at the finance access seam, not through the page-role hierarchy. |

`ROLE_HIERARCHY` in `gremion-ui/src/lib/auth/index.ts`:

```
ITAdmin       -> [ITAdmin, CouncilAdmin, Finance, Member, Guest]
CouncilAdmin  -> [CouncilAdmin, Finance, Member, Guest]
Finance       -> [Finance, Member, Guest]
Vorstand      -> [Vorstand, Member, Guest]
Member        -> [Member, Guest]
Guest         -> [Guest]
Auditor       -> [Auditor, Guest]
```

`hasRole(userRoles, required)` returns true iff any of `userRoles` expands to a
set containing `required`. So `ITAdmin` passes every page check; `Member` passes
`Member` and `Guest` but not `CouncilAdmin`; `Vorstand` passes `Member` and
`Guest` but not `CouncilAdmin`.

**The `vorstand` realm role.** It is a Keycloak realm role like `council-admin`. It is in
the realm template (`docker/keycloak/realm-export.base.json`) and in the `gremion-ui`
client's realm-role scope mappings; a realm created before the role existed gets both from
the reconcile check `vorstand-role` (the host reconcile verb for the customer, see
[runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md)). Existing councils get the
role assigned to the members of their former "Vorstand" committee by a migration-queued
backfill (`role_backfill`, applied by the boot worker; a deleted, disabled or mail-less user
is counted and reported, never an abort). Councils whose committee has another name get the
role but nobody assigned; they assign it in the member admin. `listRoleHolders` returns the
holders of the notice roles (`council-admin` and `vorstand`, de-duplicated) for the phase 2 mails.

The string values (`guest`, `member`, …) are the exact realm-role names expected
from Keycloak. `sessionUserFromPayload`
([`gremion-ui/src/hooks.server.ts`](../gremion-ui/src/hooks.server.ts)) filters
`realm_access.roles` through the resolved tenant's role vocabulary (a tenant
with no `config.roles` override resolves to the `Role` enum values); any realm
role not in the vocabulary is dropped silently, and a user left with no
recognised role defaults to `[Guest]`.

Coarser-grained distinctions that the role hierarchy cannot express (e.g.
council-admin vs. it-admin, or any group a feature module contributes) are
handled by the parallel, non-hierarchical group/capability layer in §7.

---

## 2. PAGE_ACCESS mapping

`PAGE_ACCESS` in
[`gremion-ui/src/lib/auth/index.ts`](../gremion-ui/src/lib/auth/index.ts) maps URL
segment 1 (`/committees/anything` → `committees`) to the minimum required role.
It is **composed from the per-module manifests** via `composePageAccess()` — each
segment is declared by its owning module under `$lib/modules/manifests/*`, where
the per-segment rationale lives. The kernel's own manifests are
[`core.ts`](../gremion-ui/src/lib/modules/manifests/core.ts) and
[`governance.ts`](../gremion-ui/src/lib/modules/manifests/governance.ts); the
enabled modules' manifests are overlaid next to them at build time (see
[architecture.md](./architecture.md), "Manifests and the generated registry").

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
| `module-off`  | `Guest`        | core       | The "Modul nicht aktiv" notice a disabled module's page request is answered with. |
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
(`auth`, `legal`, `setup`, `livekit`, `element-call`, `api`, `healthz`) lists the
directories intentionally allowed to lack an entry.

### Per-tenant page access

`pageAccessForTenant(ctx)` is what the guard and nav consume. A tenant with no
`config.roles` override resolves to the same golden `PAGE_ACCESS` object, so
its behaviour is byte-identical to the composed literal. An override tenant
delegates to the vocabulary-arg compose seam; only an **absent** `config.roles`
means "default" — an explicit `[]` is a narrowing override.

---

## 3. authGuard flow

[`gremion-ui/src/hooks.server.ts`](../gremion-ui/src/hooks.server.ts) exports
`authGuard`, composed in
`sequence(correlationHandle, cspGuard, requestPathHandle, bodySizeGuard, csrfOriginGuard, tenantResolveHandle, tenantBrandStyleHandle, sessionEndpointGuard, authHandleUnlessExempt, authGuard, i18nHandle)`.
The correlation id comes first, the CSP guard wraps everything after it, the
request path is decoded (a bad encoding is a 400), the body-size and CSRF-origin
guards (`lib/server/security/`) run before the tenant is resolved, and Auth.js
(`authHandleUnlessExempt`) is skipped for the boot-and-resolve exempt paths when
no tenant was resolved. Per-request flow of `authGuard`, top to bottom:

### 3.1 Boot-503 short-circuit (G-014, T4.1)

`boot()` runs once on cold start. It waits for the database, runs the
control-plane migrations, then runs the data-plane **fleet** migrations over
every active tenant (an empty fleet is a complete run: boot writes nothing into
the tenant registry and the kernel starts with zero tenants) and only then sets
`_bootComplete = true`. A **control-plane** failure populates `_bootError`; a
transient database start-up error is re-attempted up to a ceiling, and any other
failure (or the ceiling) sets `process.exitCode = 1` so an orchestrator can
recycle the container. A single **tenant's** data-plane migration failure no
longer fails boot: it lands in the per-tenant readiness map and that tenant is
served a tenant-scoped 503 with a lazy re-migration retry, while every other
tenant serves normally.

`authGuard` checks `_bootComplete` first:

- `_bootError` set and not retryable → permanent `503 Service Unavailable: boot failed`.
- Still booting → `503` with `Retry-After: 5` and a German HTML waiting page that reloads itself (`lib/server/waiting-page.ts`).
- Complete → fall through.

Prevents the failure mode where a half-migrated DB still accepts traffic.

### 3.2 Default locals (G-006, T2.1)

Before any branching, `authGuard` initialises `event.locals.user = null`,
`event.locals.accessToken = null`, and `event.locals.accessTokenExpires = null`.
This is the **single place** in the request pipeline that populates the user and
the access token; downstream API routes read `locals.accessToken` directly rather
than calling `locals.auth()` again, avoiding a race-prone double-invocation.

### 3.3 Public paths bypass

These entries (`PUBLIC_PATHS` in `hooks.server.ts`) skip the session lookup and
call `resolve(event)` directly (the handles ahead of `authGuard` still run). The
`/api` entries are exact routes, nothing below them is public:

```
/auth/                                     Sign-in / sign-out / callback
/legal/                                    Datenschutz, Impressum, Barrierefreiheit
/livekit/, /element-call/, /element-call   Messaging module: the LiveKit proxy and the Element Call widget host; their own handlers authorise
/newsletter/unsubscribe, /api/newsletter/unsubscribe, /content/unsubscribe
                                           Unsubscribe links opened by a recipient with no session; single-use token
/api/internal/newsletter/render, /resolve-group, /send-mail, /api/internal/content/portal-publish
                                           Leaf callbacks: each handler refuses without its x-internal-auth secret
/api/setup/seed                            One-shot prod seed — guarded by X-Seed-Token + empty-DB
/api/health                                Unauthenticated boot-status probe (no secrets)
/api/public/protocols/*/pdf                Published-protocol PDF download — self-enforces published + public visibility
```

The first-run setup wizard (`/setup`, `/api/setup/{admins,config,health}`) is
gone: the first administrator of a customer is created by the platform
operator, and `/api/setup/seed` and `/api/setup/test-smtp` are the only
`/api/setup` routes left. `/healthz` and `/api/internal/` are answered earlier,
by the boot-and-resolve exemption described in
[deployment-architecture.md](./deployment-architecture.md).

### 3.4 Bearer JWT path (`/api/**` only)

For `/api/` paths, `authGuard` inspects the `Authorization` header. If
`Bearer <token>` is present:

1. `verifyBearerJwt(token, locals.tenant)`
   ([`gremion-ui/src/lib/server/jwt-verify.ts`](../gremion-ui/src/lib/server/jwt-verify.ts))
   validates against the resolved tenant's Keycloak JWKS, issuer, and `exp`.
2. `sessionUserFromPayload(payload, vocabulary)` builds a `SessionUser`
   (the user id is `sub` and nothing else: a token without `sub` has no
   session and is answered with a machine-readable 401, because the id is the
   audit actor; `realm_access.roles` filtered through the tenant role
   vocabulary; `groups`, `loa`, and `authTime` carried through for §6/§7).
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

Two further rules of this branch: an `internalFetch` self-call carries the
process's `INTERNAL_PUSH_SECRET` as its Bearer and is honoured only on an exact
allow-list of (method, path) pairs and only on the internal hop (otherwise a
distinct 401 `internal_bearer_not_allowed`); and an `Authorization` header that
does not authenticate never falls back to the cookie session (401), because the
CSRF origin guard exempts requests that carry one.

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
`REQUIRED_MODULES` is empty. `defaultModulesConfig()` therefore contains exactly
the toggleable modules of the composed manifests: each defaults to `true` unless
its manifest declares `defaultEnabled: false`. A module can also be **held off**:
`config.modules` pins it to `false` on every read and every write, so the rail,
the pages and the API answer with the module-disabled surface. The held-off set
is currently `elections` (`HELD_OFF_MODULE_IDS`, `gremion-ui/src/lib/modules/held-off.ts`).

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
session). A disabled-module **page** deep link is answered by
`moduleOffPageResponse` (`gremion-ui/src/lib/server/module-off-response.ts`): it
fetches the real `/module-off/<id>` route in-process and returns it with a 403
status, so the styled "Modul nicht aktiv" notice renders inside the shell and the
disabled module's own page and layout loads never run. Disabling a module never
removes a role grant; it just makes that module's routes 403 until it is
re-enabled. The council's admin switches the self-service modules in Settings >
Module (`SWITCHABLE_CATALOGUE_IDS`: `calendar`, `elections`, `votes`; a held-off
module is never offered), and the operator's requests switch the others;
switching off starts the 30-day Karenz ([modules.md](./modules.md)).

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

**The realm flow is OTP-or-deny.** `stepup-2fa` must never hold a REQUIRED OTP
form: for a user with no OTP credential Keycloak would run CONFIGURE_TOTP inside
the step-up and then issue `loa2`, so whoever holds the session (or only the
password) could enroll their own authenticator and pass the fresh-2FA gate. The
flow is the LoA-2 condition plus a REQUIRED subflow `stepup-2fa second factor`
holding the OTP form (ALTERNATIVE) and `deny-access-authenticator`
(ALTERNATIVE): a user with an OTP credential is asked for it, a user without one
is refused. Template, tenant realms and the reconcile check
`stepup-2fa-otp-gate` (which also repairs live realms) all enforce this shape.
**Ops realm (operators).** The control panel and Grafana always sign in at loa2, so
a new operator cannot enrol inside them. `gremion-tenant operator add` therefore
prints the platform realm's account console URL
(`https://<platform domain>/auth/realms/platform/account`): a plain (loa1) sign-in
there runs UPDATE_PASSWORD and CONFIGURE_TOTP; only then does the panel sign-in
(password + OTP) succeed. `test/host/fixtures/executor/kc-token-probe.mjs` proves
both phases against a real Keycloak 26.6.1 (`enrolment` then `flow` in
`kc2661-token-claims.json`).

Residual: a user must enroll their OTP *outside* a step-up (imported members get
only `UPDATE_PASSWORD`, TASK-031 D-5). For a member who has no OTP credential yet, the
password is not the only way in: measured on Keycloak 26.6.1 with the base realm, a
request made by hand with `kc_action=CONFIGURE_TOTP` and neither `prompt` nor `acr_values`
inside a live SSO session opens the setup form without asking for the password
(callback `kc_action_status=success`, one OTP credential added); a step-up (`acr_values=loa2`)
in the same browser then asks only for the code just enrolled and returns `loa2`. So whoever
holds an unlocked session of a member without a second factor, or the password alone, can
enrol their own authenticator and reach `loa2` before the legitimate user does, by going
around the app's own button (which asks for the password, see below). Measured only seconds
after sign-in; whether Keycloak's per-action `max_auth_age` (default 300 s) forces a fresh
authentication for an older session was NOT measured. This is a property of the realm, not
of the app: closing it needs a `max_auth_age` setting on the actions or mandatory first-login
enrollment for members, which remains a product decision (realm work, not part of Settings > Profil).

**Profile and account actions inside the app (members).** Settings > Profil no longer
links to the Keycloak account console (its first API call is refused on a customer realm,
which has no client scopes for it). A member edits their own first and last name in the app
(saved through the admin client for the session's own Keycloak user id, nothing else about the
user changes), and three buttons start Keycloak application-initiated actions through the
normal `gremion-ui` sign-in: UPDATE_PASSWORD, CONFIGURE_TOTP and UPDATE_EMAIL (the last one
only while the realm has that required action enabled). Every one sends `kc_action`,
`prompt=login` and, for a user who has an OTP credential, `acr_values=loa2`, so the password
and the existing one-time code are asked again before the action form opens. A user without
an OTP is not sent `loa2` (the OTP-or-deny flow would refuse them) and re-enters the password
only. Measured on Keycloak 26.6.1 and recorded in the header of
`gremion-ui/src/lib/server/profile/account-actions.ts`; the return `kc_action_status`
(success, cancelled, error) is read once and shown as a notice, the session stays intact.

The realm also carries `passwordPolicy` (`length(12) and notUsername and
notEmail and passwordHistory(3)`) and PKCE S256 on `gremion-ui` (Auth.js sends
`checks: ['pkce', 'state']`); reconcile checks `password-policy` and
`gremion-ui-pkce` and repairs drift on live realms.

**Residual: refresh-token rotation is NOT enabled.** `revokeRefreshToken` /
`refreshTokenMaxReuse` stay at the Keycloak defaults in every template and
reconcile neither checks nor sets them (a test pins this). Rotation with
`refreshTokenMaxReuse 0` accepts a refresh token exactly once, and gremion-ui
can present the same one twice: Auth.js rebuilds the session from the original
cookie on every `auth()` call and two tabs refresh in parallel. `authGuard` now
memoises `locals.auth()` per request, which removes the in-request double
refresh; before rotation can ship the refresh also needs to be single-flight
across concurrent requests (or `refreshTokenMaxReuse 1` as a stopgap), with a
test that two concurrent refreshes with the same token both end in a good
session.

The kernel ships the LoA primitive and threads `loa` / `authTime` onto every
session. The module switch (`lib/server/module-switch/step-up.ts`) and the
erasure orchestrator (`lib/server/erasure/step-up.ts`) call `evaluateStepUp`
with `STEPUP_FRESHNESS_SECONDS` (default 300); `/auth/step-up` is the page that
sends the user through the LoA-2 flow. Other protected actions are owned by the
surfaces that need them.

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

The role enum in §1 is coarse, and its main rungs are a strictly-nested containment chain. Finer,
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
  `{ capabilityId → groups[] }` map. The kernel's own `core` manifest contributes
  the platform group literals; the other composed manifests contribute theirs.
- `PLATFORM_GROUPS` is sourced from the always-on `core` manifest:

  | Constant | Group string | Meaning |
  |----------|--------------|---------|
  | `PLATFORM_GROUPS.admin` | `admin` | Council admin — broad administrative scope. |
  | `PLATFORM_GROUPS.itAdmin` | `it-admin` | IT admin — highest privilege. |

- `capabilitiesForTenant(ctx)` is the tenant-aware accessor (the default tenant
  resolves to the same golden `CAPABILITIES` object); `capabilityGroups(id)`
  returns the any-of group set that grants a capability.

A feature module (finance, etc.) brings its own group literals and capability
ids — those are absent from a build that does not compose that module (finance is
in `modules/disabled.json`).

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
| `canApproveAny()` | `finance.approve.any` | the finance feature contributes this capability; **absent unless finance is composed → `false`** |
| `canEditBudget()` | `finance.budget.edit` | as above → `false` |
| `canApproveBudget()` | `finance.budget.approve` | as above → `false` |
| `canConfigureFints()` | `finance.fints.configure` | as above → `false` |
| `canManageSubOrgs()` | `finance.suborgs.manage` | as above → `false` |

The finance-named helpers are part of the seam, not the kernel feature set. Each
looks up a capability id the **finance module** contributes; in a build that
does not compose finance those ids are absent from the composed `CAPABILITIES` map, so the helper
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
grants visibility (OR semantics), an optional `role`, and an optional `moduleId`.
Items with no `needs` and no `role` are visible to everyone.

`filterNavForSession(navSchema, helpers, roles, disabledModules)` (same module)
applies the helpers:

- An item is hidden when its `moduleId` is in `disabledModules`, when its `role`
  is not held, or when it has `needs` and `helpers.hasAny(...needs)` is false.
- A `section` collapses entirely when **all** of its children are hidden — empty
  sections are pruned so no dangling header renders.

It is wired in
[`gremion-ui/src/routes/+layout.server.ts`](../gremion-ui/src/routes/+layout.server.ts):
the layout load builds the helpers from `session.user.groups` (via
`capabilitiesForTenant(tenant)`), calls `filterNavForSession` and then
`retermNav`, and returns the filtered `nav` plus any badge counts.

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
get the full list while basic members get the narrowed one. The basic view also
passes the viewer, so memberships of `committee_only` units the viewer is not in
are dropped (operator decision D-3; the rule lives in
`lib/server/governance/visibility.ts`).

```ts
const isAdmin = !!user && (hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin))
const viewer = user ? { id: user.id, roles: user.roles ?? [] } : null
const members = await listMembers({ adminView: isAdmin, viewer })
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
| `AUTH_KEYCLOAK_SECRET` | OIDC client secret (set after the realm is created by tenant-create). |
| `AUTH_KEYCLOAK_ISSUER` | Not read by gremion-ui: the issuer comes from the tenant row. Only the dev realm-consistency check reads it from `.env`. |
| `KEYCLOAK_ISSUER_URL` | Listed in `.env.example`; `gremion-ui` does not read it. Bearer verification takes the JWKS URL and issuer from the resolved tenant (`kcInternal` or `issuer`). |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service-account secret for `gremion-ui` → Keycloak admin API calls. |
| `KC_ADMIN_ALLOWLIST_CIDRS` | CIDR allowlist for the Keycloak admin console / Admin REST API. |

OIDC client secrets are placed into the composed per-tenant realm document by
`buildTenantRealmDoc` at tenant-create time (B-01: nothing is substituted at
container start, and no realm is imported at boot).
The Keycloak realm encodes the LoA mapping (`acr.loa.map`) that §5's `ACR_TO_LOA`
mirrors. Keycloak runs in the state project (see
[`architecture.md`](./architecture.md) for the service set).
