<script lang="ts">
  // Browser-suite fixture (TASK-208): the root layout's skip link and an
  // aria-live status region around AppShell with fixture navigation, the way
  // routes/+layout.svelte mounts it. Links never navigate the test page.
  import AppShell from '../AppShell.svelte'
  import type { NavItem } from '../nav-schema'
  import type { Role } from '$lib/auth'

  let {
    nav,
    activeHref = '/',
    roles = [],
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    wideMain = 0,
    withModules = false
  }: {
    nav: NavItem[]
    activeHref?: string
    roles?: Role[]
    counts?: { approvals: number; liveVotes: number; unread: number }
    wideMain?: number
    withModules?: boolean
  } = $props()
</script>

<a href="#main-content" class="sr-only focus:not-sr-only" data-testid="skip-link">Zum Inhalt springen</a>
<div role="status" aria-live="polite" class="sr-only" data-testid="app-status"></div>

<div data-shell-fixture style="display: contents">
  <AppShell {nav} {counts} {activeHref} {roles} userName="Dev Member" brand={null} sourceUrl="https://example.org/source">
    {#snippet children()}
      <h1>Seite</h1>
      <p>Inhalt</p>
      {#if wideMain > 0}
        <div data-testid="wide-main" style="width: {wideMain}px; height: 10px; flex-shrink: 0;"></div>
      {/if}
      <button type="button">Aktion im Inhalt</button>
    {/snippet}
  </AppShell>
</div>
