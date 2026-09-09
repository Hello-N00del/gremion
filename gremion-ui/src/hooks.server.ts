import { handle as authHandle } from './auth'
import { redirect, type Handle, type HandleFetch, type HandleServerError } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { readOrMintCorrelationId, CORRELATION_HEADER } from '$lib/server/ports/tracer'
import { canAccess, pageAccessForTenant, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { acrToLoa } from '$lib/auth/step-up'
import { readConfig } from '$lib/server/config'
import { moduleGateResponse } from '$lib/server/module-gate'
import { requireBrand } from '$lib/server/brand'
import { instanceThemeStyleTag } from '$lib/theme/instance-theme'
import { waitForDbReady } from '$lib/server/db'
import { startProvisioningWorker } from '$lib/server/governance/provisioning/worker'
import { verifyBearerJwt } from '$lib/server/jwt-verify'
import { purgeAuditLogsOlderThan, verifyAuditChain } from '$lib/server/audit-db'
import { generateErrId } from '$lib/server/err-id'
import { assertIssMatch } from '$lib/server/tenant/iss-match'
import { roleVocabularyForTenant } from '$lib/server/tenant/role-vocabulary'
import { tenantResolveHandle, tenantForwardFetch } from '$lib/server/tenant/resolve'
import { runControlMigrations } from '$lib/server/tenant/control-migrations'
import { registerDefaultTenant } from '$lib/server/tenant/register-default'
import { runFleetMigrations } from '$lib/server/tenant/fleet'
import { setTenantReadinessFromFleet } from '$lib/server/tenant/readiness'
import { resolveTenantBySlug } from '$lib/server/tenant/registry'
import { getControlDb } from '$lib/server/tenant/control-db'
import { startTenantEvictListener } from '$lib/server/tenant/evict-listener'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
// Session-A inversion A1: importing the generated server-init barrel for
// its side effects runs every module's register.server.ts, which registers that
// module's boot hooks (schedulers, consumers, drains), per-tenant evict hooks,
// and provisioning subsystem factories into the runtime-registry. This hook file
// therefore no longer statically imports any module's server internals
// ($lib/server/{calendar,content,events,messages,files,elections}/*) — it drives
// them through runServerInitHooks() below. (startProvisioningWorker stays a
// direct kernel/core call — the provisioning worker is governance, not a module.)
import '$lib/server/modules/server-init.generated'
import { runServerInitHooks } from '$lib/server/modules/runtime-registry'

// Run on cold start (SvelteKit server boot).
//
// T4.1 (G-014): boot sequencing must be atomic. The old version set
// `_bootComplete = true` BEFORE awaiting runMigrations(), so a migration
// failure would leave the app serving requests against a half-migrated DB.
// Contract (P2.1b T3 / D-READY scopes it):
//   - `_bootComplete` is set to true ONLY after the boot steps return.
//   - A CONTROL-plane/boot failure populates `_bootError` and `_bootComplete`
//     stays false; the authGuard returns a PROCESS-wide 503 until ops restarts
//     the process. process.exitCode is set so an orchestrator's healthcheck
//     loop can recycle the container.
//   - A per-TENANT data-plane migration failure no longer fails boot: it lands
//     in the readiness map (lib/server/tenant/readiness.ts) and that tenant is
//     503-gated at the resolution seam with a lazy re-migration retry, so
//     G-014's "no traffic against a half-migrated DB" holds per tenant.
let _bootComplete = false
let _bootError: Error | null = null
let _bootPromise: Promise<void> | null = null

/**
 * Test/observability hook: read-only view of boot state. Exported so unit
 * tests can verify that a failing migration does NOT flip `_bootComplete`.
 */
export function getBootStatus(): { complete: boolean; error: Error | null } {
  return { complete: _bootComplete, error: _bootError }
}

export function boot(): Promise<void> {
  if (_bootPromise) return _bootPromise
  _bootPromise = (async () => {
    try {
      // Survive a reboot race: if the Docker daemon starts gremion-ui before
      // Postgres is accepting connections, wait (retrying transient startup
      // errors) instead of latching a permanent unhealthy state. A genuine
      // misconfiguration still fails fast via isTransientDbStartupError.
      //
      // The readiness probe pings the CONTROL pool, NOT the default `SELECT 1`
      // via getDb(): getDb() is now fail-closed (requireTenant() THROWS with no
      // ALS scope) and that throw is non-transient, so the default probe would
      // crash boot on the first attempt -> permanent 503. The control pool is
      // the first DB used here (non-ALS, always available), and on the same
      // Postgres instance the data-plane is ready once control responds; the
      // data-plane runMigrations() runs inside the runWithTenant block below.
      await waitForDbReady({ ping: () => getControlDb()`SELECT 1` })

      // P2.1a: migrate the control plane and register this deployment itself as
      // the canonical `default` tenant #1 BEFORE the data-plane migration — the
      // default registry row must exist so resolveTenantBySlug('default') below
      // can build the ALS context the data-plane migration runs inside.
      // Control migrations + default registration touch ONLY the control pool
      // (no ALS), so they can run before any tenant scope is established.
      await runControlMigrations()
      await registerDefaultTenant()

      // P2.1b T2+T3 (D-FLEET / D-READY): the data-plane migration step is a
      // FLEET run over every ACTIVE registry tenant (default included — same
      // path), each applied inside runWithTenant(ctx, …) so the P0.2
      // module-skip uses THAT tenant's config, with the per-tenant outcome
      // ledgered in the control plane's tenant_migration_run. One tenant's
      // failure — the DEFAULT included — no longer fails boot: the outcomes
      // populate the per-tenant readiness map and tenantResolveHandle serves a
      // failed/pending tenant a tenant-scoped 503 with a single-flighted lazy
      // re-migration retry, while every other tenant serves normally. The
      // WORKER plane honors the same map: forEachActiveTenant skips not-ready
      // tenants (and whole ticks pre-population), so background writes never
      // hit a half-migrated tenant DB either (G-014's "no traffic against a
      // half-migrated DB" now holds per tenant on BOTH planes). Only a
      // CONTROL-plane failure (control migrations, default registration,
      // listing the fleet) escapes into the process-wide catch below — nothing
      // can resolve without the control plane.
      const fleetOutcomes = await runFleetMigrations()
      setTenantReadinessFromFleet(fleetOutcomes)
      const failedCount = [...fleetOutcomes.values()].filter((o) => !o.ok).length
      if (failedCount > 0) {
        console.error(
          `[boot] ${failedCount} tenant(s) failed migration — each serves a tenant-scoped 503 with lazy retry, and background workers skip it (D-READY)`,
        )
      }
      console.info('[boot] Migrations complete')

      // Control-plane sanity check: the default tenant must resolve after
      // registration — if it can't, nothing will (process-wide boot failure).
      if (!(await resolveTenantBySlug('default'))) {
        throw new Error('[boot] default tenant not resolvable after registration')
      }

      // G-XPROC (SP-4): subscribe THIS process to cross-process tenant evictions
      // so a CLI suspend/delete busts this app replica's resolution cache +
      // per-tenant runtime immediately, not after the ~30s RESOLUTION_CACHE_TTL.
      // Non-fatal: a listener that won't start degrades to the TTL bound — it
      // must never block boot (the TTL still guarantees eventual eviction).
      try {
        await startTenantEvictListener()
      } catch (err) {
        console.error('[boot] tenant-evict listener failed to start (degrading to ~30s TTL eviction):', err)
      }

      // Session-A inversion A1: run every MODULE-registered boot worker
      // through the runtime-registry server-init seam. The generated barrel
      // imported at the top of this file already loaded each module's
      // register.server.ts, which registered its boot hook(s). This single call
      // replaces the previously-inline starters that named module internals:
      //   - calendar: startNotificationScheduler + startCalDavSyncWorker
      //   - newsletter: the NATS-gated newsletter-audit consumer (events)
      //   - content: the per-tenant content-publish drain interval
      // Each hook owns its own non-fatal try/catch exactly as the inline code did
      // (a worker that won't start must not block boot). KERNEL boot steps that
      // are NOT modules stay inline below (the provisioning worker + audit
      // retention).
      await runServerInitHooks()

      try {
        startProvisioningWorker()
      } catch (err) {
        console.error('[boot] Provisioning worker failed to start:', err)
      }

      // T3.3 (G-024): every 24 h, purge audit_log rows older than the configured
      // security-log retention window (default 90 d, hard cap 180 d enforced by
      // config.ts). .unref() so the interval doesn't keep the process alive during
      // graceful shutdown / test teardown.
      //
      // P2.1b T4: the setInterval callback is a detached async boundary — the
      // ambient ALS scope established during boot does NOT survive into it, so
      // purgeAuditLogsOlderThan -> getDb() would throw "no tenant context"
      // (fail-closed). forEachActiveTenant re-establishes an EXPLICIT
      // runWithTenant scope per ACTIVE tenant (previously only the captured
      // default context), purging each tenant's audit_log with THAT tenant's
      // configured retention window — with per-(worker, tenant) single-flight
      // and per-tenant try/catch + structured log in the helper. readConfig()
      // resolves the CURRENT tenant from the ALS scope (the default tenant's
      // config path is byte-identical to DEFAULT_TENANT's).
      const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
      setInterval(
        () =>
          forEachActiveTenant('audit-retention', async () => {
            const cfg = readConfig()
            const days = cfg.retention?.security_logs_days ?? 90
            const { purged } = await purgeAuditLogsOlderThan(days)
            if (purged > 0) console.info(`[audit-retention] purged ${purged} rows older than ${days}d`)
          }),
        PURGE_INTERVAL_MS,
      ).unref()

      // gremion#22 finding 1 (governance integrity): the kernel carve lost the
      // periodic audit-chain-verification tick the full product wires from #320
      // (INV-1, tamper-evident record) — verifyAuditChain()/readAuditLog() in
      // audit-db.ts had zero production callers. Restoring it here: every 6 h,
      // re-verify the audit_log hash chain per ACTIVE tenant and log LOUDLY if it
      // is broken. The DB trigger (migration 043) makes tampering hard; this tick
      // makes it VISIBLE — an in-place edit or a mid-chain insert/delete surfaces
      // here instead of lying dormant. Modelled exactly on the audit-retention
      // tick above: the setInterval callback is a detached async boundary (the
      // ambient ALS boot scope does NOT survive into it), so verifyAuditChain ->
      // getDb() would fail-closed with "no tenant context"; forEachActiveTenant
      // re-establishes an EXPLICIT runWithTenant scope per ACTIVE tenant (with
      // per-(worker, tenant) single-flight and per-tenant try/catch + structured
      // log already in the helper). Detection only — a broken chain is an
      // operator alert, never an app-halting action. .unref() so it doesn't keep
      // the process alive during graceful shutdown / test teardown.
      const AUDIT_INTEGRITY_INTERVAL_MS = 6 * 60 * 60 * 1000
      setInterval(
        () =>
          forEachActiveTenant('audit-integrity', async () => {
            const r = await verifyAuditChain()
            if (!r.ok) {
              console.error(
                `[audit-integrity] audit_log hash chain BROKEN at id ${r.brokenAtId}`,
              )
            }
          }),
        AUDIT_INTEGRITY_INTERVAL_MS,
      ).unref()

      // (The Content Engine L2 per-minute content-publish drain is now a
      // module-registered server-init hook — see content/register.server.ts —
      // and ran above via runServerInitHooks().)

      _bootComplete = true
    } catch (err) {
      _bootError = err instanceof Error ? err : new Error(String(err))
      console.error('[boot] failed:', err)
      // Signal to orchestrator that this process is unhealthy; the authGuard
      // below will serve 503 in the meantime so we don't accept traffic against
      // a half-migrated DB.
      process.exitCode = 1
    }
  })()
  return _bootPromise
}

boot()

/**
 * Build a SessionUser from a raw Keycloak JWT payload. `vocabulary` is the
 * resolved tenant's role vocabulary (P2.2-auth A2, D-VOCAB) — the caller
 * threads it from `event.locals.tenant`, so role filtering here is
 * per-tenant (the default tenant resolves to the Role enum, byte-identical
 * to the previous Role-enum-values literal).
 */
function sessionUserFromPayload(payload: Record<string, unknown>, vocabulary: readonly string[]): SessionUser | null {
  // Keycloak 26+ may omit 'sub' from access tokens for public clients.
  // Fall back to preferred_username or jti as the user identifier.
  const id = (payload.sub as string | undefined)
    || (payload.preferred_username as string | undefined)
    || (payload.jti as string | undefined)
  if (!id) return null
  const realmRoles = (payload?.realm_access as { roles?: string[] })?.roles ?? []
  const roles = realmRoles.filter((r) => vocabulary.includes(r)) as Role[]
  return {
    id,
    email: (payload.email as string | undefined) ?? '',
    name: (payload.name as string | undefined) ?? (payload.preferred_username as string | undefined) ?? id,
    preferredUsername: payload.preferred_username as string | undefined,
    roles: roles.length ? roles : [Role.Guest],
    groups: (payload.groups as string[] | undefined) ?? [],
    loa: acrToLoa(payload.acr as string | undefined),
    authTime: typeof payload.auth_time === 'number' ? (payload.auth_time as number) : 0,
  }
}

/** True iff the verified token's issuer equals the resolved tenant's issuer. */
export function bearerTenantMatches(tenant: { issuer: string }, payload: Record<string, unknown>): boolean {
  return assertIssMatch({ tokenIss: payload.iss as string | undefined, tenantIssuer: tenant.issuer })
}

/**
 * iss-match backstop (spec §7.3): the verified token's realm must equal the
 * host-resolved tenant's issuer. A mismatch = a token from another realm
 * replayed on this host — refuse BEFORE any data-plane query. 403 (not 401):
 * the caller IS authenticated, just against the wrong tenant.
 */
function tenantMismatchResponse(path: string): Response {
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'TenantMismatch', reason: 'iss_host_mismatch' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('Forbidden: tenant mismatch', { status: 403 })
}

export const authGuard: Handle = async ({ event, resolve }) => {
  // T4.1 (G-014): refuse traffic until boot has completed. If boot threw,
  // there's no point serving anything until the operator restarts — return
  // a permanent 503. If boot is merely still running (cold start, first
  // request beats the migration), hint the client to retry in 5 s.
  if (!_bootComplete) {
    if (_bootError) {
      return new Response('Service Unavailable: boot failed', { status: 503 })
    }
    return new Response('Service Unavailable: booting', {
      status: 503,
      headers: { 'Retry-After': '5' }
    })
  }

  const path = event.url.pathname

  // Default locals to a known shape before any branching. authGuard is the
  // single place that populates `user` and `accessToken`; downstream routes
  // (e.g. /api/finance/**) read `locals.accessToken` directly instead of
  // calling `locals.auth()` a second time (G-006).
  event.locals.user = null
  event.locals.accessToken = null
  event.locals.accessTokenExpires = null

  // Public routes — no auth required
  // /api/setup/seed self-guards with the X-Seed-Token header + an empty-DB check,
  // so it is exempt from the session guard (the one-time production seed runbook
  // calls it unauthenticated with only that header).
  // /api/health is an unauthenticated boot-status probe (container healthcheck +
  // the P0.2 deselection boot-smoke). It returns no secrets — just {status, error}
  // from getBootStatus() — and is reached only after boot completes (the !_bootComplete
  // gate above already 503s every route while booting), so exposing it publicly is safe.
  // /api/public/protocols/[id]/pdf is the #241 no-auth published-PDF download the
  // public portal (gremion-public) redirects the browser to — it self-enforces
  // status='published' + public org-unit visibility, so the session guard is
  // skipped here. The tenant resolver (element 0) still runs.
  const publicPaths = ['/auth/', '/legal/', '/setup', '/api/setup/seed', '/api/health', '/api/public/protocols/']
  // Match on a SEGMENT boundary, not a bare prefix: a plain startsWith(p) also
  // matched every path that merely EXTENDS an entry ('/setupmalicious' extends
  // '/setup', '/api/healthz' extends '/api/health'), which would serve such a
  // route unauthenticated. An entry is public only on an exact hit or a
  // '/'-delimited descendant.
  if (publicPaths.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'))) {
    return resolve(event)
  }

  // For API routes, accept Bearer JWT from mobile/external clients as an
  // alternative to the Auth.js cookie session used by the web frontend.
  if (path.startsWith('/api/')) {
    const authHeader = event.request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const payload = await verifyBearerJwt(token, event.locals.tenant)
      if (payload) {
        const bearerUser = sessionUserFromPayload(payload, roleVocabularyForTenant(event.locals.tenant))
        if (bearerUser) {
          // iss-match backstop: the token verified against SOME realm's JWKS, but
          // it must be THIS host's tenant realm — else it is a cross-tenant replay.
          if (!bearerTenantMatches(event.locals.tenant, payload)) {
            return tenantMismatchResponse(path)
          }
          event.locals.user = bearerUser
          // The verified Bearer JWT IS the upstream access token — route handlers
          // pass it straight through to StuFis.
          event.locals.accessToken = token
          // Override locals.auth so existing API route code (session?.user) works unchanged.
          event.locals.auth = async () =>
            ({ user: bearerUser, expires: new Date((payload.exp as number ?? 0) * 1000).toISOString() }) as Awaited<ReturnType<typeof event.locals.auth>>
          // #256-1: Bearer callers must pass the SAME module-disable gate as
          // cookie sessions — this early return used to skip the gate below,
          // leaving a disabled module's /api prefix reachable to token clients.
          const bearerModuleGate = moduleGateResponse(path)
          if (bearerModuleGate) return bearerModuleGate
          return resolve(event)
        }
      }
    }
  }

  const session = await event.locals.auth()

  // All other routes require authentication
  // Also force re-login when the session has a token refresh error
  const tokenError = (session as unknown as { error?: string })?.error
  if (!session?.user || tokenError) {
    // API routes must answer with a machine-readable 401. A 302 to the HTML
    // login page makes client-side fetch()/res.json() throw "Unexpected
    // token '<'" — this was the Dokumente file-browser symptom, since it
    // lists via a client fetch to /api/files/** rather than SSR. Pages still
    // redirect to login as before.
    if (path.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          error: 'Unauthenticated',
          reason: tokenError ? 'token_refresh_failed' : 'no_session',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }
    redirect(302, `/auth/login?callbackUrl=${encodeURIComponent(path)}`)
  }

  const user = session.user as SessionUser
  event.locals.user = user
  // Lift the upstream access token off the session so downstream routes can
  // read it from locals without re-invoking locals.auth() (G-006).
  event.locals.accessToken = (session as unknown as { accessToken?: string }).accessToken ?? null
  // Mirror the token expiry (instrumentation only) so the files API can record
  // whether the bearer was already expired when Nextcloud rejected it (#161).
  event.locals.accessTokenExpires =
    (session as unknown as { accessTokenExpires?: number }).accessTokenExpires ?? null
  // CR2 + spec §7.3: the session's access-token issuer (set by sessionCallback,
  // Task 26 — session.tokenIss) must equal the host-resolved tenant issuer.
  const sessionTokenIss = (session as unknown as { tokenIss?: string }).tokenIss
  // #256-3: a session WITHOUT a tokenIss claim is a pre-spine cookie (minted
  // before sessionCallback recorded the issuer) — its owner is a legitimate
  // user who needs a clean re-auth, NOT a cross-tenant attacker. A dead-end
  // 403 stranded every logged-in web user for up to 30 days after the spine
  // deploy. Re-auth uses the SAME api/page split as the no-session branch
  // above: pages 302 to login (re-minting a session that carries tokenIss),
  // while /api/ paths answer with the same machine-readable 401 JSON — a
  // cookie-authenticated client fetch() cannot follow a 302 to the HTML login
  // page ("Unexpected token '<'"). A PRESENT but MISMATCHED iss stays the
  // hard 403 below (genuine cross-tenant replay).
  if (!sessionTokenIss) {
    if (path.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ error: 'Unauthenticated', reason: 'stale_session' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }
    redirect(302, `/auth/login?callbackUrl=${encodeURIComponent(path)}`)
  }
  if (!assertIssMatch({ tokenIss: sessionTokenIss, tenantIssuer: event.locals.tenant.issuer })) {
    return tenantMismatchResponse(path)
  }
  const roles = user.roles?.length ? user.roles : [Role.Guest]

  // API routes have their own auth — skip page-level access check
  if (!path.startsWith('/api/')) {
    // Check page-level access — redirect to login, not '/', to avoid redirect loops.
    // P2.2-auth A4 (D-CONST): consult the CURRENT tenant's page-access map.
    // The default tenant (no config.roles override) resolves to the SAME golden
    // PAGE_ACCESS object, so tenant #1 behavior is byte-identical.
    const segment = path.split('/')[1] || 'dashboard'
    if (!canAccess(roles, segment, pageAccessForTenant(event.locals.tenant))) {
      redirect(302, `/auth/login?error=forbidden&callbackUrl=${encodeURIComponent(path)}`)
    }
  }

  // Module disable guard — check after auth so we have role context.
  // The check itself lives in module-gate.ts (#256-1) so the Bearer branch
  // above enforces the identical route-prefix 403; nav-hiding / migration-skip
  // is P0.2.
  //
  // ONLY /api/* is gated HERE: a machine caller gets the bare route-prefix 403.
  // A disabled-module PAGE deep link is handled in +layout.server.ts instead —
  // throwing error() from THIS handle hook would render the bare static error
  // template, NOT +error.svelte (SvelteKit only routes load/render throws to the
  // error page). #290's styled "Modul nicht aktiv" surface therefore lives in
  // the layout load (see +layout.server.ts).
  if (path.startsWith('/api/')) {
    const moduleGate = moduleGateResponse(path)
    if (moduleGate) return moduleGate
  }

  return resolve(event)
}

/**
 * G-011b: defence-in-depth Content-Security-Policy header.
 *
 * Sanitizers (DOMPurify in `routes/api/protocols/[id]/publish` etc.) are
 * the primary XSS gate. This header adds a browser-enforced second layer
 * that limits the blast radius if a sanitizer ever missed a payload — and
 * also closes a class of attacks the server-side sanitizer cannot reach
 * (third-party-frame-based clickjacking, base-tag hijack, form-action
 * exfiltration).
 *
 * Compromises documented for the next tightening pass:
 *   - 'unsafe-inline' on script-src is required for SvelteKit hydration
 *     (the framework injects inline <script>__sveltekit_xxx.data = …</script>
 *     into the SSR'd HTML). Closing it requires nonce/hash-based CSP, which in
 *     SvelteKit 2 is owned by `svelte.config.js kit.csp` ({mode:'auto'}) — that
 *     path emits its OWN CSP (header/meta) with a per-response nonce auto-stamped
 *     on the framework's inline scripts. Because the policy here is set MANUALLY
 *     in cspGuard, simply deleting 'unsafe-inline' from THIS header (without the
 *     kit.csp nonce machinery) would break hydration on every page, and running
 *     both a manual header AND kit.csp produces two conflicting policies. The
 *     migration (move all directives into kit.csp + drop this manual script/style
 *     source) therefore must land together with a full build + hydration smoke
 *     test, which a build-less worktree cannot verify — #259-3 keeps it DEFERRED
 *     rather than ship a CSP that bricks the app. Tracked alongside #259.
 *   - 'unsafe-inline' on style-src: same root cause AND additionally load-bearing
 *     at runtime — Svelte scoped styles and Tailwind utility classes emit inline
 *     <style>/style="" rules that nonces do not cover, so this source stays even
 *     after the script-src nonce migration.
 *   - https:/wss: on connect-src: gremion-ui talks to env-configured Matrix,
 *     Helios, Nextcloud, LiveKit endpoints. An explicit-allowlist would
 *     require importing the runtime config from this hook — feasible but
 *     adds a config-change → hook-rebuild dependency. Kept broad here;
 *     the auth-cookie + same-origin policy on those endpoints provides
 *     the actual access gate.
 *
 * The header is only attached to `text/html` responses; JSON API replies
 * are unaffected (CSP only applies when the body is parsed as a document).
 */
export const CSP_HEADER_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self'",
  // 'self' (not 'none'): the video-call UI embeds the proxied Element Call SPA in
  // a same-origin <iframe> at /element-call/*. Because that document is served by
  // gremion-ui, it inherits this CSP — and 'none' forbids ANY framing, even
  // same-origin, so the iframe rendered as a blocked/broken frame (the browser
  // fetched the doc but never executed it). 'self' permits same-origin embedding
  // while still blocking cross-origin framing, which is the actual clickjacking
  // vector this directive defends against.
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export const cspGuard: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.startsWith('text/html')) {
    response.headers.set('Content-Security-Policy', CSP_HEADER_VALUE)
  }
  return response
}

// ── Newsletter (Task 23, old-path decommission) ─────────────────────────────
//
// The monolith SQLite newsletter store + scheduler were REMOVED once the live
// cutover to NEWSLETTER_BACKEND=service was proven. The newsletter leaf service
// now owns the store and the dispatch scheduler entirely, so there is no
// boot-time init here and no newsletterGuard 503 gate — newsletter routes
// resolve the backend per-request via resolveNewsletterBackendOr503(), which
// already maps a misconfigured/unavailable backend to a graceful 503.

// #288 (HANDOVER-v8 Part E) / gremion#22: inject the curated per-tenant accent
// ramp as a single <style id="__instance-theme"> right before </head>, AFTER
// app.css. The palette's hue derives the whole accent ramp (light + dark) via
// instanceThemeStyleTag; the default tenant (palette=null) yields '' so
// nothing is injected and tenant #1 renders byte-identically. This runs
// downstream of tenantResolveHandle, so
// requireBrand() resolves inside the ALS tenant scope. Injecting at :root level
// (not inline on the shell <div>) is deliberate: it keeps the html.cb-* a11y
// colour-blind overrides at HIGHER specificity so they still win.
export const tenantBrandStyleHandle: Handle = async ({ event, resolve }) => {
  let styleTag = ''
  try {
    styleTag = instanceThemeStyleTag(requireBrand().palette)
  } catch {
    // Unresolved/transient tenant config → no per-tenant accent (default navy).
    styleTag = ''
  }
  if (!styleTag) return resolve(event)
  return resolve(event, {
    // </head> is emitted in the first chunk (head renders before body), so the
    // single replace lands the tag at the end of <head>, after app.css.
    transformPageChunk: ({ html }) => html.replace('</head>', `${styleTag}</head>`),
  })
}

// ── T16: correlation-id ingress handle ──────────────────────────────────────
//
// Propagation-point 1 (P0.5 inventory): the VERY FIRST handle in the sequence.
// Reads x-correlation-id from the incoming request and validates it against
// UUID grammar (RFC-4122, 36 chars, hex groups). Per propagation rule 5:
//   - PRESENT and valid UUID → carry it into event.locals.correlationId.
//   - ABSENT / empty / oversized / non-UUID → MINT a fresh UUID; the client
//     value is NEVER trusted (it is observability-only and has ZERO effect on
//     access control or data visibility).
//
// The id in event.locals flows downstream to:
//   - internalFetch (point 2): forwarded as x-correlation-id to self-calls.
//   - ServiceNewsletterClient (point 6): forwarded as x-correlation-id to leaf.
//   - ACL client spans: wrapped with makeLogTracer for newsletter.acl.<op>.
export const correlationHandle: Handle = ({ event, resolve }) => {
  const raw = event.request.headers.get(CORRELATION_HEADER)
  event.locals.correlationId = readOrMintCorrelationId(raw)
  return resolve(event)
}

// correlationHandle is element 0: it mints/validates the correlation id BEFORE
// tenant resolution, auth, or any data-plane query so every downstream handle
// (including tenantResolveHandle's ALS scope) can read event.locals.correlationId.
// tenantResolveHandle remains element 1 (establishes TenantContext + ALS).
export const handle = sequence(
  correlationHandle,
  tenantResolveHandle,
  tenantBrandStyleHandle,
  authHandle,
  authGuard,
  cspGuard,
)

/**
 * gremion#22 finding 1: SvelteKit `handleFetch` — stamp the tenant trust
 * headers on internal same-origin `event.fetch('/api/...')` sub-requests so
 * the tenant resolver doesn't 403/404 them under the proxy-trust gate. Impl +
 * rationale live beside the resolver in `$lib/server/tenant/resolve`
 * (`tenantForwardFetch`).
 */
export const handleFetch: HandleFetch = tenantForwardFetch

/**
 * v5 Task 4.4: mint a short `ERR-XXXXXX` reference for every unexpected
 * (500-class) error and thread it onto `page.error`. The +error.svelte page
 * renders it as "Referenz ERR-XXXXXX" so a user can quote it to the IT team;
 * the same id is logged alongside the stack here so ops can correlate the two.
 *
 * Expected errors thrown via `error(status, …)` (403/404 etc.) bypass this
 * hook entirely — SvelteKit only calls handleError for *unexpected* throws —
 * so the reference id is naturally scoped to 500s.
 */
export const handleError: HandleServerError = ({ error, status, message }) => {
  const errId = generateErrId()
  console.error(`[error] ${errId} (status ${status}):`, error)
  return { message, errId }
}
