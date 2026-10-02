<script lang="ts">
  // Browser-suite fixture (TASK-205b): AppShell with the messaging module's REAL slot components handed to the
  // TopBar through the topbarModules contract, exactly the way routes/+layout.svelte composes them from
  // lib/modules/slots/messaging.slot.ts.
  import AppShell from '$lib/components/layout/AppShell.svelte'
  import slot from '$lib/modules/slots/messaging.slot'
  import type { NavItem } from '$lib/components/layout/nav-schema'

  let {
    nav,
    activeHref = '/',
    counts = { approvals: 0, liveVotes: 0, unread: 0 }
  }: {
    nav: NavItem[]
    activeHref?: string
    counts?: { approvals: number; liveVotes: number; unread: number }
  } = $props()

  const Chips = slot.chips!
  const Live = slot.liveCall!
  const Bell = slot.bell!
</script>

{#snippet chips()}<Chips />{/snippet}
{#snippet liveCall()}<Live />{/snippet}
{#snippet bell()}<Bell />{/snippet}

<AppShell
  {nav}
  {counts}
  {activeHref}
  roles={[]}
  userName="Dev Member"
  brand={null}
  sourceUrl="https://example.org/source"
  topbarModules={{ chips, liveCall, bell }}
>
  {#snippet children()}
    <h1>Seite</h1>
    <p>Inhalt</p>
  {/snippet}
</AppShell>
