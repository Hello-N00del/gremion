import type { PageServerLoad } from './$types'
import { makeAuthHelpers } from '$lib/auth/group-helpers'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getOrgUnitIdsForUser } from '$lib/server/governance/org-units-db'
import { deriveHue } from '$lib/governance/committee-color'
import { getDataProvider, type DashBudgetSummary } from '$lib/server/modules/runtime-registry'

// Dashboard "Auf deine Freigabe" card data. The sidebar/KPI `counts.approvals`
// (root +layout.server.ts) is the GLOBAL pending count; this card instead
// surfaces only what awaits THIS user's signature. The finance data provider
// (Session-A inversion A3a) owns the fetch + eligibility rule + display
// projection — so this kernel route imports no finance internals (no value
// import, no `PendingApproval` type). The provider mirrors the same eligibility
// as finance/approvals/+page.svelte (ApprovalWorkflowService): the approval is
// pending, the user did not create it (no self-approval), and the user is in the
// current stage's required_group (admin is a universal approver).

// --- Real dashboard data (Task 3.6) ---------------------------------------
// Replaces the prior hardcoded placeholders. Every figure is sourced from a
// real loader; where a module has no data the page renders an empty state
// rather than fabricating rows.

export interface DashUpcoming {
  id: string
  startIso: string
  title: string
  where: string
  mine: boolean
  hue: number
}
export type { DashBudgetSummary }
interface DashCommon {
  upcomingEvents: DashUpcoming[]
  nextMeeting: DashUpcoming | null
  budgetSummary: DashBudgetSummary | null
}

async function loadCommon(
  user: SessionUser | undefined,
  fetchFn: typeof fetch,
): Promise<DashCommon> {
  const now = new Date()
  const horizon = new Date(now)
  horizon.setDate(horizon.getDate() + 30)

  // Calendar — next 30 days, via the calendar data provider (Session-A
  // inversion A3a — the kernel dashboard route no longer imports calendar-db). DB
  // unavailability (provider absent OR a throw) degrades to no events (empty
  // state), never an error page.
  const events = await (
    getDataProvider('calendar:upcoming-events')?.({ from: now, to: horizon }) ?? Promise.resolve([])
  ).catch(() => [])

  // "mine" = the event touches an org-unit the user belongs to.
  const myOrgUnits = user
    ? new Set(await getOrgUnitIdsForUser(user.id).catch(() => [] as readonly string[]))
    : new Set<string>()

  const upcomingEvents: DashUpcoming[] = events
    .filter((e) => e.startAt.getTime() >= now.getTime())
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .slice(0, 6)
    .map((e) => ({
      id: e.id,
      startIso: e.startAt.toISOString(),
      title: e.title,
      where: e.location ?? '',
      mine: e.committeeIds.some((c) => myOrgUnits.has(c)),
      // Stable committee hue (calendar/committee mechanism); falls back to the
      // accent hue when the event is untagged.
      hue: e.committeeIds[0] ? deriveHue(e.committeeIds[0]) : 252,
    }))

  const nextMeeting = upcomingEvents[0] ?? null

  // Budget summary — via the finance data provider (Session-A inversion
  // A3a, gremion#22 finding 2). This kernel route no longer imports finance
  // internals (no '/api/finance/summary' fetch, which 404s once finance is
  // carved out): a finance module registers 'finance:dashboard-summary' and owns
  // the request-scoped fetch + 403/empty-state handling. Provider absent OR a
  // throw both degrade to null (no finance panel), matching the calendar
  // provider's degrade above — never a 404, never an error page.
  const budgetSummary: DashBudgetSummary | null = await (
    getDataProvider('finance:dashboard-summary')?.({ fetch: fetchFn }) ?? Promise.resolve(null)
  ).catch(() => null)

  return { upcomingEvents, nextMeeting, budgetSummary }
}

export const load: PageServerLoad = async ({ locals, fetch, parent }) => {
  // Ensure the layout's session/nav/counts are available to the page too.
  await parent()

  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  const groups = user?.groups ?? []
  const helpers = makeAuthHelpers({ user: { groups } })

  // Unplaced-guest branch (Task 3.3, README screen 27 — persona Tom): a session
  // whose effective role is only Guest (not Member-or-above) AND who belongs to
  // zero org-units is "eingeladen, noch nicht zugeordnet". The page renders the
  // empty state instead of the member/approver dashboard. The membership check
  // degrades to "treated as placed" if the governance DB is unreachable, so a
  // transient DB outage never strips a real member down to the guest view.
  if (user && !hasRole(user.roles, Role.Member)) {
    const orgUnitIds = await getOrgUnitIdsForUser(user.id).catch(
      () => null as readonly string[] | null,
    )
    if (orgUnitIds !== null && orgUnitIds.length === 0) {
      return {
        unplaced: true,
        myApprovals: [],
        myApprovalsCount: 0,
        upcomingEvents: [],
        nextMeeting: null,
        budgetSummary: null,
      }
    }
  }

  const common = await loadCommon(user, fetch)

  // Non-approvers get the elections card instead — no need to hit the approvals
  // endpoint.
  if (!helpers.canApproveAny()) {
    return { myApprovals: [], myApprovalsCount: 0, ...common }
  }

  const currentUserId = locals.user?.id ?? null
  const isAdmin = groups.includes('admin')

  // Finance data provider owns the fetch + eligibility + display projection. When
  // finance is OFF (provider unregistered) the card degrades to its empty state —
  // the approver simply sees no pending-signature rows.
  const myApprovalsProvider = getDataProvider('finance:dashboard-my-approvals')
  const { myApprovals, myApprovalsCount } = myApprovalsProvider
    ? await myApprovalsProvider({ fetch, currentUserId, isAdmin, groups })
    : { myApprovals: [], myApprovalsCount: 0 }

  return { myApprovals, myApprovalsCount, ...common }
}
