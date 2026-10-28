import { handle as authHandle } from './auth'
import { sessionEndpointGuard } from '$lib/server/security/session-endpoint-guard'
import { csrfOriginGuard } from '$lib/server/security/csrf-origin-guard'
import { redirect, type Handle, type HandleFetch, type HandleServerError } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { building } from '$app/environment'
import { readOrMintCorrelationId, CORRELATION_HEADER } from '$lib/server/ports/tracer'
import { canAccess, pageAccessForTenant, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { acrToLoa } from '$lib/auth/step-up'
import { readConfig } from '$lib/server/config'
import { RETENTION_DEFAULTS } from '$lib/retention-tiers'
import { moduleGateResponse, disabledModuleForPublicPath, disabledModuleForPath } from '$lib/server/module-gate'
import { moduleOffPageResponse } from '$lib/server/module-off-response'
import { requireBrand } from '$lib/server/brand'
import { instanceThemeStyleTag } from '$lib/theme/instance-theme'
import { waitForDbReady, isTransientDbStartupError } from '$lib/server/db'
import { isBootAndResolveExempt } from '$lib/server/boot-exempt'
import { decodeRequestPath, requestPath } from '$lib/server/request-path'
import { startProvisioningWorker } from '$lib/server/governance/provisioning/worker'
import { verifyBearerJwt } from '$lib/server/jwt-verify'
import { isInternalBearerRequest } from '$lib/server/internal-fetch'
import { purgeAuditLogsOlderThan, verifyAuditChain } from '$lib/server/audit-db'
import { generateErrId } from '$lib/server/err-id'
import { assertIssMatch } from '$lib/server/tenant/iss-match'
import { roleVocabularyForTenant } from '$lib/server/tenant/role-vocabulary'
import { tenantResolveHandle, tenantForwardFetch } from '$lib/server/tenant/resolve'
import { createI18nHandle } from '$lib/i18n/server/i18n-handle'
import { runControlMigrations } from '$lib/server/tenant/control-migrations'
import { runFleetMigrations } from '$lib/server/tenant/fleet'
import { setTenantReadinessFromFleet } from '$lib/server/tenant/readiness'
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
//     stays false; the authGuard returns a PROCESS-wide 503 meanwhile.
//     TASK-023 splits the failure by isTransientDbStartupError:
//       * TRANSIENT (Postgres went away mid-boot): the memo is dropped, so the
//         next boot() call re-attempts, and ONE re-attempt is scheduled on an
//         unref()'d timer (BOOT_RETRY_DELAY_MS, Q2). process.exitCode is NOT
//         touched (Q3): the process is healing, not failing. The healing has a
//         ceiling: the BOOT_MAX_TRANSIENT_FAILURES-th consecutive transient
//         failure is treated as non-transient.
//       * NON-TRANSIENT (bad credentials, a schema fault, an exhausted startup
//         budget -- Q1): process.exitCode = 1 and bootRuntime.exit(1), so the
//         container's restart policy recycles it instead of it latching a
//         permanent 503.
//     The waiting itself (500 ms doubling to a 30 s ceiling) is
//     waitForDbReady's; this layer only decides between re-attempt and exit.
//   - A per-TENANT data-plane migration failure no longer fails boot: it lands
//     in the readiness map (lib/server/tenant/readiness.ts) and that tenant is
//     503-gated at the resolution seam with a lazy re-migration retry, so
//     G-014's "no traffic against a half-migrated DB" holds per tenant.
let _bootComplete = false
let _bootError: Error | null = null
let _bootErrorRetryable = false
let _bootPromise: Promise<void> | null = null
let _bootAttemptId = 0
let _bootRetryPending = false

/** Q2: delay before the one scheduled re-attempt after a transient boot failure. */
export const BOOT_RETRY_DELAY_MS = 5_000
/**
 * The re-attempt ceiling. Each attempt starts waitForDbReady's budget afresh, so
 * a database that answers the readiness ping but keeps cutting a later boot step
 * off with a transient-looking error would otherwise re-attempt forever while
 * /healthz stays green. This many consecutive transient failures exit 1.
 */
export const BOOT_MAX_TRANSIENT_FAILURES = 10
let _bootTransientFailures = 0

/**
 * The two process-level side effects of boot, behind a seam so tests can observe
 * them. `schedule` unrefs its timer: a pending re-attempt must never keep a
 * shutting-down process alive.
 */
export const bootRuntime = {
  exit(code: number): void {
    process.exit(code)
  },
  schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(fn, ms).unref()
  },
}

/**
 * F1-FIX-03 / S1a#4: delays of the one post-boot run of each audit tick. The
 * 24 h / 6 h intervals have no initial run, so a process restarted more often
 * than that (every deploy) never purged or verified. The integrity run is
 * scheduled after the retention run, so it normally checks the purged table.
 */
export const AUDIT_RETENTION_BOOT_DELAY_MS = 90_000
export const AUDIT_INTEGRITY_BOOT_DELAY_MS = 150_000

/**
 * One unref'd run of a fleet tick after boot. The tick's per-tenant failures are
 * handled inside forEachActiveTenant; anything that still escapes (listing the
 * fleet) is logged here instead of becoming an unhandled rejection.
 */
function schedulePostBootRun(label: string, tick: () => Promise<unknown>, delayMs: number): void {
  bootRuntime.schedule(() => {
    tick().catch((err: unknown) => {
      console.error(`[${label}] post-boot run failed:`, err)
    })
  }, delayMs)
}

function scheduleBootRetry(): void {
  if (_bootRetryPending) return
  _bootRetryPending = true
  bootRuntime.schedule(() => {
    _bootRetryPending = false
    void boot()
  }, BOOT_RETRY_DELAY_MS)
}

/**
 * Test/observability hook: read-only view of boot state. Exported so unit
 * tests can verify that a failing migration does NOT flip `_bootComplete`.
 */
export function getBootStatus(): { complete: boolean; error: Error | null } {
  return { complete: _bootComplete, error: _bootError }
}

export function boot(): Promise<void> {
  if (_bootPromise) return _bootPromise
  const attemptId = ++_bootAttemptId
  _bootPromise = (async () => {
    // Yield once, so _bootPromise holds this attempt before any failure below
    // can drop it.
    await Promise.resolve()
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

      // P2.1a: migrate the control plane BEFORE the data-plane migration.
      // Control migrations touch ONLY the control pool (no ALS), so they run
      // before any tenant scope is established.
      //
      // TASK-042 (PRD-PLAT-012, TRD-075): boot WRITES NOTHING into the tenant
      // registry. There is no deployment-derived tenant #1 any more; every
      // customer is created by the platform operator (TASK-043), and a platform
      // with zero customers boots healthy and serves no tenant content.
      await runControlMigrations()

      // P2.1b T2+T3 (D-FLEET / D-READY): the data-plane migration step is a
      // FLEET run over every ACTIVE registry tenant (zero included: an empty
      // fleet is a complete run), each applied inside runWithTenant(ctx, …) so
      // the P0.2 module-skip uses THAT tenant's config, with the per-tenant
      // outcome ledgered in the control plane's tenant_migration_run. One
      // tenant's failure no longer fails boot: the outcomes
      // populate the per-tenant readiness map and tenantResolveHandle serves a
      // failed/pending tenant a tenant-scoped 503 with a single-flighted lazy
      // re-migration retry, while every other tenant serves normally. The
      // WORKER plane honors the same map: forEachActiveTenant skips not-ready
      // tenants (and whole ticks pre-population), so background writes never
      // hit a half-migrated tenant DB either (G-014's "no traffic against a
      // half-migrated DB" now holds per tenant on BOTH planes). Only a
      // CONTROL-plane failure (control migrations, listing the fleet) escapes into the process-wide catch below — nothing
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

      // TASK-042: the former "default tenant must resolve" sanity check is gone
      // (zero tenants is a valid, healthy state). Its control-plane-check role is
      // kept by runFleetMigrations above: listActiveTenants() reads the control
      // plane, and its failure still reaches the catch below (exit 1).

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
      // security-log retention window (default 27 d, hard cap 29 d enforced by
      // config.ts through `$lib/retention-tiers`, so a row lives at most 30 d:
      // [D R29-I6]). .unref() so the interval doesn't keep the process alive
      // during graceful shutdown / test teardown.
      //
      // P2.1b T4: the setInterval callback is a detached async boundary — the
      // ambient ALS scope established during boot does NOT survive into it, so
      // purgeAuditLogsOlderThan -> getDb() would throw "no tenant context"
      // (fail-closed). forEachActiveTenant re-establishes an EXPLICIT
      // runWithTenant scope per ACTIVE tenant, purging each tenant's audit_log
      // with THAT tenant's configured retention window — with per-(worker,
      // tenant) single-flight and per-tenant try/catch + structured log in the
      // helper. readConfig() resolves the CURRENT tenant from the ALS scope.
      const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
      const auditRetentionTick = () =>
        forEachActiveTenant('audit-retention', async () => {
          const cfg = readConfig()
          // [D R29-I6] fallback = the tier registry default (27 d), never a literal 90.
          const days = cfg.retention?.security_logs_days ?? RETENTION_DEFAULTS.security_logs_days
          const { purged } = await purgeAuditLogsOlderThan(days)
          if (purged > 0) console.info(`[audit-retention] purged ${purged} rows older than ${days}d`)
        })
      setInterval(auditRetentionTick, PURGE_INTERVAL_MS).unref()
      // F1-FIX-03 / S1a#4: plus ONE run shortly after boot. The interval alone
      // never fires in a process that restarts more often than every 24 h (every
      // deploy), so retention would silently never run.
      schedulePostBootRun('audit-retention', auditRetentionTick, AUDIT_RETENTION_BOOT_DELAY_MS)

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
      const auditIntegrityTick = () =>
        forEachActiveTenant('audit-integrity', async () => {
          const r = await verifyAuditChain()
          if (!r.ok) {
            console.error(
              `[audit-integrity] audit_log hash chain BROKEN at id ${r.brokenAtId}`,
            )
          }
        })
      setInterval(auditIntegrityTick, AUDIT_INTEGRITY_INTERVAL_MS).unref()
      // F1-FIX-03 / S1a#4: plus ONE run after boot (scheduled after the
      // retention run), for the same reason as above.
      schedulePostBootRun('audit-integrity', auditIntegrityTick, AUDIT_INTEGRITY_BOOT_DELAY_MS)

      // (The Content Engine L2 per-minute content-publish drain is now a
      // module-registered server-init hook — see content/register.server.ts —
      // and ran above via runServerInitHooks().)

      _bootComplete = true
      _bootError = null
      _bootErrorRetryable = false
      _bootTransientFailures = 0
    } catch (err) {
      _bootError = err instanceof Error ? err : new Error(String(err))
      const transient = isTransientDbStartupError(err)
      if (transient) _bootTransientFailures++
      _bootErrorRetryable = transient && _bootTransientFailures < BOOT_MAX_TRANSIENT_FAILURES
      if (_bootErrorRetryable) {
        // Self-heal: drop the memo so the next boot() re-attempts, and make sure
        // one re-attempt happens even if nothing else calls boot(). The authGuard
        // serves 503 booting (Retry-After: 5) in the meantime.
        console.error(
          `[boot] failed (transient ${_bootTransientFailures}/${BOOT_MAX_TRANSIENT_FAILURES}), re-attempting in ${BOOT_RETRY_DELAY_MS} ms:`,
          err,
        )
        if (_bootAttemptId === attemptId) _bootPromise = null
        scheduleBootRetry()
      } else {
        // Not something waiting fixes (or waiting has not fixed it): exit, so the
        // restart policy recycles the container. exitCode first, in case exit is
        // intercepted.
        console.error(
          transient
            ? `[boot] failed (transient ${_bootTransientFailures}/${BOOT_MAX_TRANSIENT_FAILURES}: re-attempt ceiling reached), exiting 1:`
            : '[boot] failed (non-transient), exiting 1:',
          err,
        )
        process.exitCode = 1
        bootRuntime.exit(1)
      }
    }
  })()
  return _bootPromise
}

// Not while SvelteKit builds: its analyse step imports this module, and a
// non-transient boot failure (no database configured at build time) exits 1,
// which would kill `vite build`.
if (!building) void boot()

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

/**
 * The session guard's public allow-list (see authGuard). Exported so the pin in
 * hooks.boot.test.ts reads the shipped list, not a copy of it.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/auth/',
  '/legal/',
  // TASK-205b (carve-keep hunk re-applied, MODULE: messaging): the LiveKit proxy and the same-origin Element
  // Call SPA are page trees their own handlers/widget tokens authorise; '/element-call' itself is the exact
  // entry document (an entry without a trailing slash is an exact route).
  '/livekit/',
  '/element-call/',
  '/element-call',
  // TASK-205c (carve-keep hunk re-applied, MODULE: publishing): the unsubscribe link in a sent newsletter is opened
  // by a recipient with no session. The page and its API are EXACT routes (nothing below them is public); the API
  // consumes a single-use token and answers 400/404/410 without a valid one. The three callbacks are the publishing
  // leaf's LEAF_CALLBACK_ROUTES keys (tenant/leaf-trust.ts): each handler refuses without INTERNAL_NEWSLETTER_SECRET
  // in x-internal-auth (constantTimeEqual), and nothing else under /api/internal/newsletter/ is public. Content's
  // callback and unsubscribe join with the content half when it is enabled.
  '/newsletter/unsubscribe',
  '/api/newsletter/unsubscribe',
  '/api/internal/newsletter/render',
  '/api/internal/newsletter/resolve-group',
  '/api/internal/newsletter/send-mail',
  '/api/setup/seed',
  '/api/health',
  '/api/public/protocols/*/pdf',
]

/**
 * F1-FIX-03 / S1a#28: how a PUBLIC_PATHS entry matches.
 *   - ends in '/'  -> a PAGE subtree ('/auth/' holds the Auth.js endpoints,
 *                     '/legal/' the legal pages); never used for /api.
 *   - contains '*' -> an exact route whose '*' is ONE non-empty segment.
 *   - otherwise    -> an exact route, nothing below it.
 * The /api entries used to be subtrees (and '/api/health' also matched
 * '/api/health/<anything>'), so any route later added below a public one was
 * served without a session.
 */
function matchesPublicPath(entry: string, path: string): boolean {
  if (entry.endsWith('/')) return path.startsWith(entry)
  if (!entry.includes('*')) return path === entry
  const want = entry.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return false
  return want.every((seg, i) => (seg === '*' ? got[i].length > 0 : seg === got[i]))
}

/**
 * F1-FIX-03 / H11: the exact (method, path) pairs whose handlers accept the
 * internalFetch Bearer (`Authorization: Bearer <INTERNAL_PUSH_SECRET>`, G-075)
 * in place of a session. The guard used to verify every /api Bearer as a
 * Keycloak JWT, so each internalFetch self-call got a 401 here before the
 * handler's own isInternalBearerRequest() branch could run.
 *
 * Kept exact on purpose: one method, one anchored pattern per route, the id
 * restricted to the characters the route really uses (an encoded `%2F..` id can
 * never match). A new internal consumer is added here together with its
 * handler's own isInternalBearerRequest() check. The route still authorises the
 * caller itself; this list only decides which requests the session guard may
 * hand over without a user.
 */
export interface InternalBearerRoute {
  readonly method: 'PATCH'
  readonly pattern: RegExp
}

// Round 2 (review LOW): every entry is frozen too, not only the array, so no
// importer can re-point a pattern or method on this security allow-list.
export const INTERNAL_BEARER_ROUTES: readonly InternalBearerRoute[] = Object.freeze([
  // news/[id]/edit page actions -> PATCH (body / publish / unpublish).
  Object.freeze({ method: 'PATCH', pattern: /^\/api\/news\/[0-9]{1,12}$/ } as const),
  // Content editor autosave -> PATCH (title / body / channel toggle).
  Object.freeze({ method: 'PATCH', pattern: /^\/api\/content\/posts\/[0-9A-Za-z-]{1,64}$/ } as const),
])

function isInternalBearerRoute(method: string, path: string): boolean {
  return INTERNAL_BEARER_ROUTES.some((r) => r.method === method && r.pattern.test(path))
}

/** The 401 reason for an internal Bearer the guard refused (never 'no_session'). */
export const INTERNAL_BEARER_REJECTED_REASON = 'internal_bearer_not_allowed'

interface InternalBearerRejection {
  method: string
  path: string
  /** The resolver validated x-internal-host-trust (the request is on the internal hop). */
  tenantSelectionTrusted: boolean
  /** (method, path) is on INTERNAL_BEARER_ROUTES. */
  allowListed: boolean
  /** The Bearer constant-time-matched INTERNAL_PUSH_SECRET. */
  secretMatches: boolean
}

/**
 * F1-FIX-03 round 2 (review MEDIUM): leave a server-side trace of WHY an
 * internal Bearer was refused. Only the request shape and the three verdicts
 * are logged; the token never is.
 */
function logInternalBearerRejected(ctx: InternalBearerRejection): void {
  console.warn('[authGuard] internal Bearer rejected', ctx)
}

function internalBearerRejected(ctx: InternalBearerRejection): Response {
  logInternalBearerRejected(ctx)
  return new Response(JSON.stringify({ error: 'Unauthenticated', reason: INTERNAL_BEARER_REJECTED_REASON }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

export const authGuard: Handle = async ({ event, resolve }) => {
  const path = requestPath(event)

  // Default locals to a known shape before any branching. authGuard is the
  // single place that populates `user` and `accessToken`; downstream routes
  // (e.g. /api/finance/**) read `locals.accessToken` directly instead of
  // calling `locals.auth()` a second time (G-006).
  event.locals.user = null
  event.locals.accessToken = null
  event.locals.accessTokenExpires = null

  // TASK-023: a request on the closed BOOT_AND_RESOLVE_EXEMPT_PATHS list that
  // the resolver handed on WITHOUT a tenant (/healthz; an /api/internal/ call
  // naming no tenant, which only the container network can make).
  const unresolvedExempt = isBootAndResolveExempt(path) && !event.locals.tenant
  // Such a request with no matching route would have SvelteKit render its 404
  // through the root layout, whose load needs locals.auth and a tenant — neither
  // exists here (Auth.js was skipped), so it would surface as a 500. Answer the
  // 404 without rendering anything.
  if (unresolvedExempt && !event.route?.id) return new Response('Not Found', { status: 404 })

  // T4.1 (G-014): refuse traffic until boot has completed. If boot failed for
  // good, the process is exiting — return 'boot failed'. If boot is still
  // running or re-attempting after a transient failure, hint the client to
  // retry in 5 s.
  // TASK-023: an unresolved exempt request is answered during boot too. A
  // tenant-resolved request is gated like any other: the per-tenant readiness
  // gate is inert until the boot fleet runs, so this 503 is what keeps it off a
  // half-migrated database.
  if (!_bootComplete) {
    if (unresolvedExempt) return resolve(event)
    if (_bootError && !_bootErrorRetryable) {
      return new Response('Service Unavailable: boot failed', { status: 503 })
    }
    return new Response('Service Unavailable: booting', {
      status: 503,
      headers: { 'Retry-After': '5' }
    })
  }

  // TASK-023: an unresolved exempt request is not session-authenticated either —
  // /healthz is public by design, and an /api/internal/ handler authenticates
  // its caller itself (a static guard in boot-exempt.test.ts enforces that). A
  // tenant-resolved /api/internal/ request — anything through the edge — takes
  // the session, Bearer, iss-match and module gates below exactly as before.
  if (unresolvedExempt) return resolve(event)

  // Public routes — no auth required (PUBLIC_PATHS, below this handle).
  // TASK-042 Q1: '/setup' is gone with the first-run wizard; a request for it is
  // answered like any unknown path (Q9: no authGuard change).
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
  // Never a bare prefix: a plain startsWith(p) also matched every path that
  // merely EXTENDS an entry ('/api/healthz' extends '/api/health'), and a
  // '/'-delimited descendant rule made every /api entry a whole subtree
  // (S1a#28). See matchesPublicPath for the three entry shapes.
  if (PUBLIC_PATHS.some((p) => matchesPublicPath(p, path))) {
    // F5 r2: public video proxy (/element-call, /livekit/) is a messages feature -> 403 when messages is OFF.
    if (disabledModuleForPublicPath(path)) return new Response('Module disabled', { status: 403 })
    return resolve(event)
  }

  // Set when an internalFetch-hop Bearer failed to authenticate (see below), so
  // the no-session 401 carries the distinct 'internal_bearer_not_allowed' reason.
  let internalBearerMismatch = false

  // For API routes, accept Bearer JWT from mobile/external clients as an
  // alternative to the Auth.js cookie session used by the web frontend.
  if (path.startsWith('/api/')) {
    const authHeader = event.request.headers.get('Authorization')
    if (authHeader !== null && /^Bearer /i.test(authHeader)) {
      // F1-FIX-03 / H11: an internalFetch self-call. Honoured only when all of
      // these hold: the (method, path) is on the exact allow-list, the request
      // arrived on the internal hop (the resolver validated its
      // x-internal-host-trust secret, so it never came through the edge), and
      // the Bearer constant-time-matches INTERNAL_PUSH_SECRET. No user is set:
      // the handler authorises the internal caller itself. The module-disable
      // gate applies exactly as for every other caller.
      // Round 2 (review MEDIUM): the secret on a route off the allow-list or
      // off the internal hop is refused HERE with a logged, distinct 401
      // (internal_bearer_not_allowed). It used to fall through to the JWT path
      // and end as an anonymous-looking 'no_session', which is exactly how H11
      // stayed invisible.
      const internalTrusted = event.locals.tenantSelectionTrusted === true
      const internalAllowListed = isInternalBearerRoute(event.request.method, path)
      const internalSecretMatches = isInternalBearerRequest(event.request)
      if (internalSecretMatches) {
        if (internalTrusted && internalAllowListed) {
          const internalModuleGate = moduleGateResponse(path)
          if (internalModuleGate) return internalModuleGate
          return resolve(event)
        }
        return internalBearerRejected({
          method: event.request.method,
          path,
          tenantSelectionTrusted: internalTrusted,
          allowListed: internalAllowListed,
          secretMatches: true,
        })
      }
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
      // Round 2 (review MEDIUM): a Bearer that is neither the secret nor a
      // verified JWT, on a request carrying the internalFetch hop marker
      // (x-internal-host-trust, valid or not): an internal caller whose secret
      // does not match this process. Logged, and the 401 below names it; the
      // session fallback itself is unchanged.
      if (event.request.headers.has('x-internal-host-trust')) {
        internalBearerMismatch = true
        logInternalBearerRejected({
          method: event.request.method,
          path,
          tenantSelectionTrusted: internalTrusted,
          allowListed: internalAllowListed,
          secretMatches: false,
        })
      }
    }
    // An Authorization header that did not authenticate (garbage Bearer, a
    // non-Bearer scheme, a bare "Bearer") must NEVER fall back to the cookie
    // session: the CSRF origin guard exempts requests carrying Authorization, so
    // honouring a cookie here would let a cross-site request ride it.
    if (authHeader !== null) {
      return new Response(
        JSON.stringify({
          error: 'Unauthenticated',
          reason: internalBearerMismatch ? INTERNAL_BEARER_REJECTED_REASON : 'no_session',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }
  }

  const session = await event.locals.auth()
  // Memoise for the rest of the request. Auth.js rebuilds the session from the
  // ORIGINAL cookie header on every auth() call, so a second call (root layout
  // load, +page.server loads, handleFetch sub-requests) after the access token
  // expired would run a second refresh with the refresh token the first one
  // already used. Harmless while refresh tokens are reusable; fatal the day
  // rotation is switched on (see docs/auth.md, refresh-token rotation residual).
  event.locals.auth = async () => session

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
          reason: tokenError
            ? 'token_refresh_failed'
            : internalBearerMismatch
              ? INTERNAL_BEARER_REJECTED_REASON
              : 'no_session',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }
    redirect(302, `/auth/login?callbackUrl=${encodeURIComponent(event.url.pathname)}`)
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
    redirect(302, `/auth/login?callbackUrl=${encodeURIComponent(event.url.pathname)}`)
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
      redirect(302, `/auth/login?error=forbidden&callbackUrl=${encodeURIComponent(event.url.pathname)}`)
    }
  }

  // Module disable guard — check after auth so we have role context.
  // The check itself lives in module-gate.ts (#256-1) so the Bearer branch
  // above enforces the identical route-prefix 403; nav-hiding / migration-skip
  // is P0.2.
  //
  // /api/* gets the bare machine-readable 403. A disabled-module PAGE deep link
  // answers 403 with the styled in-shell "Modul nicht aktiv" page: the notice is
  // a real route (routes/module-off/[id]) fetched in-process and returned with
  // the 403 status, so the disabled module's own page/layout loads never run and
  // the page renders INSIDE the root +layout.svelte. (A throw from the ROOT
  // layout load cannot do this — SvelteKit renders the static error template
  // when the root layout load fails.) See module-off-response.ts.
  if (path.startsWith('/api/')) {
    const moduleGate = moduleGateResponse(path)
    if (moduleGate) return moduleGate
  } else {
    const disabled = disabledModuleForPath(path)
    if (disabled) return moduleOffPageResponse(event, disabled)
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

// TASK-062 (brief §3): exactly one exported i18nHandle, placed after
// authGuard in the sequence below. Resolves event.locals.locale, runs the
// rest of the chain inside Paraglide's request scope and fills app.html's
// <html lang> placeholder with the resolved value via transformPageChunk,
// the same mechanism tenantBrandStyleHandle already uses
// for the per-tenant accent tag — both survive sequence() (brief §4).
export const i18nHandle: Handle = createI18nHandle((locals) => locals.tenant?.id ?? null)

/**
 * A Response whose headers can be written. A Response from fetch() or
 * Response.redirect()/error() has an immutable header guard, and set() throws
 * a TypeError on it; such a response is re-wrapped once (same body stream,
 * status and headers) instead of losing its security headers. The writability
 * probe IS the nosniff write (cspGuard sets it again, idempotently). Any other
 * error is a real fault and propagates (round 2, review LOW).
 */
function withWritableHeaders(response: Response): Response {
  try {
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return response
  } catch (err) {
    if (!(err instanceof TypeError)) throw err
    // Response.error() (status 0) cannot be re-wrapped; it carries no body a
    // browser would render, so it passes through as it is.
    if (response.status < 200 || response.status > 599) return response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }
}

/**
 * F1-FIX-03 / S1a#17: sits right after correlationHandle (position 1), so it
 * wraps EVERY downstream response, the early returns included (tenant
 * 404/429/503, authGuard 401/403/503, the module gate). It used to be the
 * innermost handle, which those returns never passed through.
 *
 * nosniff goes on every response: MIME sniffing matters most on the non-HTML
 * ones (attachments, file downloads, JSON). Referrer-Policy is the browser
 * default, set only when the handler did not choose one. The CSP stays scoped
 * to text/html (see CSP_HEADER_VALUE).
 */
export const cspGuard: Handle = async ({ event, resolve }) => {
  const response = withWritableHeaders(await resolve(event))
  if (response.status < 200 || response.status > 599) return response
  response.headers.set('X-Content-Type-Options', 'nosniff')
  if (!response.headers.has('referrer-policy')) {
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  }
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

// TASK-023: Auth.js builds its config from the resolved tenant and throws
// without one, so a request the resolver handed on unresolved (/healthz, an
// /api/internal/ call naming no tenant — see boot-exempt.ts) skips it; the
// authGuard below is what answers such a request. A tenant-resolved request
// goes through Auth.js exactly as before.
/**
 * Decode the request path ONCE (400 on a malformed escape) and expose it as
 * event.locals.decodedPath; every later path check reads that value, never the
 * raw event.url.pathname (which the router does not match on).
 */
export const requestPathHandle: Handle = ({ event, resolve }) => {
  const decoded = decodeRequestPath(event.url.pathname)
  if (decoded === null) return new Response('Bad Request', { status: 400 })
  event.locals.decodedPath = decoded
  return resolve(event)
}

export const authHandleUnlessExempt: Handle = ({ event, resolve }) =>
  isBootAndResolveExempt(requestPath(event)) && !event.locals.tenant
    ? resolve(event)
    : authHandle({ event, resolve })

// correlationHandle is element 0: it mints/validates the correlation id BEFORE
// tenant resolution, auth, or any data-plane query so every downstream handle
// (including tenantResolveHandle's ALS scope) can read event.locals.correlationId.
// cspGuard is element 1 (F1-FIX-03 / S1a#17): it wraps every later handle, so
// their early returns carry the security headers too. It reads no tenant state.
// tenantResolveHandle follows it (establishes TenantContext + ALS).
export const handle = sequence(
  correlationHandle,
  cspGuard,
  requestPathHandle,
  csrfOriginGuard,
  tenantResolveHandle,
  tenantBrandStyleHandle,
  sessionEndpointGuard,
  authHandleUnlessExempt,
  authGuard,
  i18nHandle,
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
