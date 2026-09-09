<script lang="ts">
  import Sidebar from './Sidebar.svelte'
  import TopBar from './TopBar.svelte'
  import type { Role } from '$lib/auth'
  import type { NavItem } from './nav-schema'
  import type { Snippet } from 'svelte'
  import type { Brand } from '$lib/brand'

  let {
    nav = [],
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    activeHref = '',
    roles = [],
    userName = '',
    groups = [],
    brand,
    sourceUrl,
    children
  }: {
    nav?: NavItem[]
    counts?: { approvals: number; liveVotes: number; unread: number }
    activeHref?: string
    roles: Role[]
    userName: string
    groups?: string[]
    brand?: Partial<Brand> | null
    /** AGPL section 13 source offer, from the layout load. */
    sourceUrl?: string
    children: Snippet
  } = $props()
</script>

<!-- #288 (HANDOVER-v8 Part E): the per-tenant accent ramp is injected as a
     <style id="__instance-theme"> in <head> AFTER app.css (hooks.server.ts
     tenantBrandStyleHandle), deriving the FULL accent ramp (accent/ink/soft/faint,
     light+dark) from the curated hue. It is NOT set inline here on purpose: an
     inline `style:--accent` on this descendant <div> would override the
     html.cb-* colour-blind a11y accents (higher cascade origin on a more-specific
     element wins), inverting accessibility. `brand` is still passed down for the
     logo/strings. -->
<div class="flex h-screen overflow-hidden" style="background: var(--paper);">
  <Sidebar {nav} {activeHref} {counts} {userName} {roles} {groups} {brand} {sourceUrl} />
  <div class="flex flex-1 flex-col overflow-hidden">
    <TopBar {brand} {nav} unread={counts.unread} />
    <main class="flex-1 overflow-auto p-6 flex flex-col" id="main-content" tabindex="-1">
      {@render children()}
    </main>
  </div>
</div>
