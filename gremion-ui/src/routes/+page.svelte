<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { page } from '$app/state'
  import type { PageData } from './$types'
  import type { SessionUser } from '$lib/auth/types'
  import { makeAuthHelpers } from '$lib/auth/group-helpers'
  import { moduleHref } from '$lib/modules/registry'
  import { resolveBrand } from '$lib/brand'
  import { termFor } from '$lib/terms'
  import { INSTANCE_STATE_META, instanceReady, type InstanceState } from '$lib/instance-status'
  import ConvergenceBanner from '$lib/components/dashboard/ConvergenceBanner.svelte'
  import UnplacedGuestCard from '$lib/components/dashboard/UnplacedGuestCard.svelte'
  import PageHead from '$lib/components/dashboard/PageHead.svelte'
  import FeaturedMeeting from '$lib/components/dashboard/FeaturedMeeting.svelte'
  import KpiRow from '$lib/components/dashboard/KpiRow.svelte'
  import UpcomingEventsCard from '$lib/components/dashboard/UpcomingEventsCard.svelte'
  import MyApprovalsCard from '$lib/components/dashboard/MyApprovalsCard.svelte'
  import ActiveVotesCard from '$lib/components/dashboard/ActiveVotesCard.svelte'
  import ExternalServicesCard from '$lib/components/dashboard/ExternalServicesCard.svelte'
  import type { Upcoming, BudgetSummary, MyApproval } from '$lib/components/dashboard/types'

  let { data }: { data: PageData } = $props()

  // Tenant brand (v4 re-audit slice 10) — portal domain.
  let brand = $derived(resolveBrand(page.data.brand))

  // #289 (HANDOVER-v8 Part F): re-term institution nouns from the tenant term-map;
  // StuRa tenant #1 has no override → literal fallbacks (byte-identical).
  let terms = $derived((page.data as { terms?: Record<string, string> | null }).terms ?? undefined)
  let gremienPlural = $derived(termFor(terms, 'gremien', 'Gremien'))
  // Singular falls back to the tenant's plural term (consistent vocab), then the
  // literal; tenant #1 (no terms) stays "Gremium".
  let gremiumSingular = $derived(termFor(terms, 'gremienSingular', termFor(terms, 'gremien', 'Gremium')))
  let councilAdmin = $derived(termFor(terms, 'councilAdmin', 'Vorstand'))

  // #290 (HANDOVER-v8 Part D): module enablement (from the layout payload). A
  // finance-OFF tenant must not show finance KPIs/CTAs. Absent → ON (tenant #1).
  let financeEnabled = $derived((page.data as { financeEnabled?: boolean }).financeEnabled !== false)

  // #264 (HANDOVER-v8 Part C): the convergence banner — shown only when the
  // instance is not fully converged. Tenant #1 is 'ready' → banner hidden.
  let instanceState = $derived((page.data as { instanceState?: InstanceState }).instanceState ?? 'ready')
  let instanceMeta = $derived(INSTANCE_STATE_META[instanceState] ?? INSTANCE_STATE_META.ready)
  let showConvBanner = $derived(!instanceReady(instanceState))

  let user = $derived(data.session?.user as SessionUser | undefined)
  let groups = $derived(user?.groups ?? [])
  let firstName = $derived(user?.name?.split(' ')[0] ?? 'StuRa')
  // Unplaced guest (Task 3.3): invited but assigned to no org-unit yet.
  let unplaced = $derived(data.unplaced === true)
  let helpers = $derived(makeAuthHelpers({ user: { groups } }))
  let canApprove = $derived(helpers.canApproveAny())
  let isStaff = $derived(
    helpers.hasAny('ref-finanzen', 'ref-finanzen-kv', 'ref-finanzen-hv', 'admin', 'it-admin')
  )
  let isMember = $derived(!isStaff)
  // A card that links into a module this instance does not run is a 404 dressed
  // as navigation. Both slots below ask the manifests whether the destination
  // exists before offering it.
  const votesHref = moduleHref('votes')
  const approvalsHref = moduleHref('finance', '/approvals')
  const newExpenseHref = moduleHref('finance', '/expenses')
  let showApprovals = $derived(canApprove && financeEnabled && approvalsHref !== null)
  let showSecondCard = $derived(showApprovals || votesHref !== null)

  // Real, cheap counts loaded by the root +layout.server.ts.
  let approvalsCount = $derived(data.counts?.approvals ?? 0)
  let liveVotesCount = $derived(data.counts?.liveVotes ?? 0)
  let unreadCount = $derived(data.counts?.unread ?? 0)

  // --- Real dashboard data (Task 3.6) ------------------------------------
  // Sourced from +page.server.ts (calendar events, finance summary). Where a
  // module has no data, the template renders an empty state — no fake rows.
  let upcoming = $derived((data.upcomingEvents ?? []) as Upcoming[])
  let nextMeeting = $derived((data.nextMeeting ?? null) as Upcoming | null)
  let myEventCount = $derived(upcoming.filter((u) => u.mine).length)

  let budgetSummary = $derived((data.budgetSummary ?? null) as BudgetSummary | null)

  // "Auf deine Freigabe" — real approvals awaiting THIS user's signature,
  // filtered + projected by +page.server.ts from /api/finance/approvals/pending.
  // (The sidebar/KPI counts.approvals is the GLOBAL pending queue — distinct.)
  let myApprovals = $derived((data.myApprovals ?? []) as MyApproval[])
  let myApprovalsCount = $derived(data.myApprovalsCount ?? 0)

  // (open-core carve) The "start the next meeting's video call" affordance posted to
  // /api/video/meeting-room and opened the Element Call widget via the call store.
  // Video/Matrix is a feature module, not part of the governance kernel — the CTA
  // and its handler were removed here, as was the Matrix · Element Web handoff card
  // (it displayed the tenant's matrix homeserver, a brand field dropped in the
  // carve). A re-added messages/video module supplies these via registered
  // dashboard slots.
</script>

<PageTitle title="Übersicht" />

<div class="dash">
  {#if showConvBanner}
    <!-- #264: instance not fully converged → banner linking to Systemstatus. -->
    <ConvergenceBanner {instanceMeta} />
  {/if}
  {#if unplaced}
    <!-- Unplaced guest (screen 27): invited, not yet assigned to a Gremium. -->
    <UnplacedGuestCard {gremiumSingular} {councilAdmin} />
  {:else}
    <PageHead
      {nextMeeting}
      {firstName}
      {isMember}
      {financeEnabled}
      {approvalsCount}
      {liveVotesCount}
      {myEventCount}
      {gremienPlural}
      {newExpenseHref}
    />

    <FeaturedMeeting {nextMeeting} />

    <KpiRow
      {isMember}
      {financeEnabled}
      upcomingCount={upcoming.length}
      {myEventCount}
      {liveVotesCount}
      {unreadCount}
      {approvalsCount}
      {budgetSummary}
      {gremienPlural}
    />

    <!-- Two columns: upcoming + (approvals | votes), when either module runs -->
    <div class="grid-2" class:one-col={!showSecondCard}>
      <UpcomingEventsCard {isMember} {upcoming} />

      {#if showApprovals && approvalsHref}
        <MyApprovalsCard {myApprovals} {myApprovalsCount} href={approvalsHref} />
      {:else if votesHref}
        <ActiveVotesCard {liveVotesCount} href={votesHref} />
      {/if}
    </div>

    <ExternalServicesCard domain={brand.domain} />
  {/if}
</div>

<style>
  .dash {
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
  }

  /* Two columns: upcoming + (approvals | elections) */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-top: 20px;
  }
  /* No second card to place — the remaining card takes the full width instead
     of sitting beside a gap where a carved-out module used to be. */
  .grid-2.one-col {
    grid-template-columns: 1fr;
  }

  @media (max-width: 860px) {
    .grid-2 {
      grid-template-columns: 1fr;
    }
  }
</style>
