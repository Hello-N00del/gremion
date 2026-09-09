import type { LayoutServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { Role } from '$lib/auth'
import { disabledModuleForPath } from '$lib/server/module-gate'
import { makeAuthHelpers } from '$lib/auth/group-helpers'
import { capabilitiesForTenant } from '$lib/auth/capabilities'
import { filterNavForSession, navSchema, retermNav } from '$lib/components/layout/nav-schema'
import { getDb } from '$lib/server/db'
import { readConfig, type GremionConfig } from '$lib/server/config'
import { requireBrand } from '$lib/server/brand'
import { resolveBrand, type Brand } from '$lib/brand'
import { getDataProvider } from '$lib/server/modules/runtime-registry'
import { instanceStateForTenant } from '$lib/server/tenant/instance-state'
import { resolveSourceUrl } from '$lib/source-offer'

type Counts = { approvals: number; liveVotes: number; unread: number }

// Resolve the per-tenant brand server-side. requireBrand fails closed on an
// unresolved tenant — but in the request path tenantResolveHandle has already
// established the TenantContext. The try/catch only degrades a transient config
// read error to the NEUTRAL client fallback (never an institution identity).
function loadBrand(): Brand {
  try {
    return requireBrand()
  } catch (e) {
    // Reaching here means a transient config-read error for an
    // already-resolved tenant. Degrade the cosmetic shell brand to the NEUTRAL
    // fallback — but log it, so a persistently broken tenant config is
    // observable rather than silently neutral-branded.
    console.warn('[brand] requireBrand failed; using neutral fallback brand:', e)
    return resolveBrand()
  }
}

// Sidebar badge counts. Cheap, indexed COUNT(*)s run on every navigation, so
// they degrade to zero on any DB error rather than crashing the whole shell
// (same resilience posture as the /votes load's external lookups). `approvals`
// is the global pending count, gated to users who can approve; per-stage
// eligibility filtering happens on the Freigaben page itself. `liveVotes` counts
// tracked, non-archived committee elections (open/closed state lives in external
// Helios — too expensive to fetch per request).
//
// Session-A inversion A3a: the finance approvals COUNT is now a finance
// data provider on the runtime-registry — the kernel shell no longer imports any
// finance internals. We invoke it ONLY when the session can approve AND finance
// is enabled, so a finance-OFF tenant never even issues the query (the genuine-
// gate). An absent finance module (provider unregistered) degrades to 0. The
// always-on liveVotes COUNT (committee_elections) stays kernel-owned, unchanged.
async function loadCounts(canApprove: boolean, financeEnabled: boolean): Promise<Pick<Counts, 'approvals' | 'liveVotes'>> {
  try {
    const sql = getDb()
    const approvals =
      canApprove && financeEnabled
        ? await (getDataProvider('finance:pending-approvals-count')?.() ?? Promise.resolve(0))
        : 0
    const [votesRow] =
      await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM committee_elections WHERE archived_at IS NULL`
    return { approvals, liveVotes: votesRow?.n ?? 0 }
  } catch {
    return { approvals: 0, liveVotes: 0 }
  }
}

// Matrix unread badge count. Same store the /messages page reads — a single
// short `/sync` against Synapse, summing each room's notification_count. The
// Matrix logic itself now lives in the messages module's data provider (Session-A
// inversion A3a), so the kernel shell no longer imports messages
// internals; here we just invoke the registered provider. An absent messages
// module (provider unregistered) degrades to 0 — identical resilience posture to
// the provider's own Matrix/auth-error fallback.
async function loadUnread(accessToken: string | null): Promise<number> {
  const provider = getDataProvider('messages:unread-count')
  if (!provider) return 0
  return provider(accessToken)
}

export const load: LayoutServerLoad = async (event) => {
  // Register the unread dependency so the messages page can re-run this load
  // (refreshing the Matrix unread total in `counts`) by calling
  // `invalidate('app:unread')` after marking a room read — without a full
  // navigation. The sidebar + top-bar bell both read `counts.unread`.
  event.depends('app:unread')
  const session = await event.locals.auth()
  const groups = (session?.user as { groups?: string[] } | undefined)?.groups ?? []
  const roles = (session?.user as { roles?: Role[] } | undefined)?.roles ?? []
  // P2.2-auth A4 (D-CONST): the nav filter routes through the tenant-aware
  // capability accessor. The default tenant (no config.roles override) resolves
  // to the SAME golden CAPABILITIES object, so tenant #1 nav is byte-identical.
  const helpers = makeAuthHelpers({ user: { groups } }, capabilitiesForTenant(event.locals.tenant))
  // Boot-green module read (Pillar-1 P0.2): read enabled modules once so a
  // finance-OFF vertical (no finance schema) never even ISSUES a finance query
  // below. Fail-safe to {} on any config error. (Task 6 reuses `modules` to
  // build the disabled-module nav filter.)
  let modules: Record<string, boolean> = {}
  // #289 (HANDOVER-v8 Part F): the per-tenant term-map (display-label overrides).
  // Read alongside modules from the same config; absent for StuRa tenant #1, so
  // termFor falls back to the built-in literals (byte-identical originator).
  let terms: Record<string, string> | undefined
  // Keep the resolved config so the #290 module gate below reuses it (no second
  // readConfig); null when the config read failed (degrade, don't gate).
  let cfg: GremionConfig | null = null
  try {
    cfg = readConfig()
    modules = cfg.modules
    terms = cfg.terms
  } catch {
    cfg = null
    modules = {}
    terms = undefined
  }
  const financeEnabled = modules.finance === true
  // #290 (HANDOVER-v8 Part D): a disabled-module PAGE deep link throws HERE (in the
  // layout LOAD) so SvelteKit renders the styled +error.svelte "Modul nicht aktiv"
  // surface — a throw from the handle hook only reaches the bare static error
  // template (see hooks.server.ts). /api/* stays gated in the hook (bare 403). The
  // moduleId rides the message so +error.svelte can name the module + offer
  // "Module verwalten". Reuses the already-read cfg; the event.url guard is
  // defensive (a real LayoutServerLoadEvent always has url) so a malformed event
  // can never 500 the whole shell. Runs after auth (locals.user set by authGuard).
  const disabledModule = cfg && event.url ? disabledModuleForPath(event.url.pathname, cfg) : null
  if (disabledModule) error(403, `module-disabled:${disabledModule}`)
  // Guest is the baseline tier — every visitor (even unauthenticated) sees the
  // guest-gated workspace items, so floor the role set at Guest. hasRole([]) is
  // false for *every* role, which would otherwise hide even Übersicht/Kalender.
  const disabledModules = new Set(Object.entries(modules).filter(([, on]) => on === false).map(([id]) => id))
  // Filter by role/module, THEN re-term the surviving labels per the active
  // tenant's vocabulary (#289). Tenant #1 (no `terms`) → labels unchanged.
  const nav = retermNav(
    filterNavForSession(navSchema, helpers, [...roles, Role.Guest], disabledModules),
    terms,
  )
  const brand = loadBrand()
  // `terms` is shipped to the client so route screens (Committees, Dashboard,
  // Kalender) and the TopBar breadcrumbs can re-term their own headings via
  // $lib/terms.termFor. `null` (not undefined) so the payload key is explicit.
  const termsPayload = terms ?? null
  // #264 (HANDOVER-v8 Part C): cheap in-memory convergence state for the topbar
  // badge + dashboard banner. The default tenant is migrated at boot → 'ready',
  // so the badge/banner stay hidden in the normal case (instanceReady).
  const instanceState = instanceStateForTenant(event.locals.tenant)
  const emptyCounts: Counts = { approvals: 0, liveVotes: 0, unread: 0 }
  // AGPL-3.0 section 13: the running program offers its Corresponding Source.
  // An operator running a MODIFIED build sets PUBLIC_SOURCE_URL to their own
  // repository — pointing at upstream would make the offer false.
  // Read from process.env, not `$env/dynamic/public`: this value is needed on
  // the SERVER only (it is embedded in the payload below), and the public env
  // module exists to ship variables to the CLIENT. `$env/dynamic/private`
  // cannot supply it either — SvelteKit excludes every name starting with the
  // public prefix from that module, so it would always read undefined and the
  // offer would silently fall back to upstream on a modified build.
  const sourceUrl = resolveSourceUrl(process.env.PUBLIC_SOURCE_URL)
  // #290 (HANDOVER-v8 Part D): expose module enablement to the Dashboard so it
  // strips finance KPIs/CTAs on a finance-OFF tenant (no dead links). The default
  // tenant runs finance ON, so the dashboard is byte-identical for tenant #1.
  if (!session) return { session: null, nav, counts: emptyCounts, brand, terms: termsPayload, instanceState, financeEnabled, sourceUrl }
  const { user, expires } = session as { user: typeof session.user; expires: string }
  // Fetch DB-backed badge counts and the Matrix unread total in parallel — the
  // Matrix /sync is independent of the Postgres COUNT(*)s.
  const accessToken = (event.locals as { accessToken?: string | null }).accessToken ?? null
  const [dbCounts, unread] = await Promise.all([
    loadCounts(helpers.canApproveAny(), financeEnabled),
    loadUnread(accessToken),
  ])
  const counts: Counts = { ...dbCounts, unread }
  return { session: { user, expires }, nav, counts, brand, terms: termsPayload, instanceState, financeEnabled, sourceUrl }
}
