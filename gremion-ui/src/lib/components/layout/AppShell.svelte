<script lang="ts">
  import Sidebar from './Sidebar.svelte'
  import TopBar from './TopBar.svelte'
  import NavDrawer, { type DrawerCloseReason } from './NavDrawer.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { Role } from '$lib/auth'
  import type { NavItem } from './nav-schema'
  import type { Snippet } from 'svelte'
  import type { Brand } from '$lib/brand'
  import type { TopbarModuleSlot } from './topbar-slot'
  import { onMount, tick } from 'svelte'
  import { t } from '$lib/i18n'
  import { resolveSourceUrl } from '$lib/source-offer'
  import { MQ_COLUMN, MQ_WIDE, navShellCss } from './nav-constants'
  import { applyNavPrefClass, createNavPrefStore, effectiveNavMode, type NavMode, type NavPref } from './nav-state'
  import { navHrefs, resolveActiveHref } from './nav-active'

  let {
    nav = [],
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    activeHref = '',
    roles = [],
    userName = '',
    groups = [],
    brand,
    sourceUrl = resolveSourceUrl(),
    topbarModules,
    bodyContext,
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
    /** TASK-208: module chips / live-call indicator / bell for the TopBar. */
    topbarModules?: TopbarModuleSlot
    /** TASK-208: the TopBar's body-context slot. */
    bodyContext?: Snippet
    children: Snippet
  } = $props()

  const DRAWER_ID = 'nav-drawer'
  // The whole layout-critical CSS comes from nav-constants.ts, so SSR's <head>
  // already carries the breakpoints and widths for the first paint.
  const SHELL_CSS = `<style id="__nav-shell">${navShellCss()}</style>`

  const prefs = createNavPrefStore(() => localStorage)

  let pref = $state<NavPref | null>(null)
  let width = $state<number | null>(null)
  let ready = $state(false)
  let drawerOpen = $state(false)
  let status = $state('')
  let hamburger: HTMLButtonElement | undefined = $state()
  let shell: HTMLElement | undefined = $state()

  // null until hydrated: SSR renders no state-dependent ARIA it could get wrong.
  let mode = $derived<NavMode | null>(width === null ? null : effectiveNavMode(width, pref))
  let currentHref = $derived(resolveActiveHref(navHrefs(nav), activeHref))

  onMount(() => {
    pref = prefs.read()
    const column = matchMedia(MQ_COLUMN)
    const wide = matchMedia(MQ_WIDE)
    const sync = () => {
      width = window.innerWidth
      if (column.matches && drawerOpen) void closeDrawer('resize')
    }
    sync()
    column.addEventListener('change', sync)
    wide.addEventListener('change', sync)
    ready = true
    return () => {
      column.removeEventListener('change', sync)
      wide.removeEventListener('change', sync)
    }
  })

  function toggleSidebar() {
    const next: NavPref = mode === 'expanded' ? 'rail' : 'expanded'
    pref = next
    prefs.write(next)
    applyNavPrefClass(document.documentElement, next)
    status = next === 'expanded' ? $t('nav.sidebar.expanded') : $t('nav.sidebar.collapsed')
  }

  function openDrawer() {
    // Blur first: modal.ts then records <body> as its restore target, and the
    // shell alone decides where focus goes on close (see nav-drawer.ts).
    hamburger?.blur()
    drawerOpen = true
  }

  async function closeDrawer(reason: DrawerCloseReason | 'resize') {
    if (!drawerOpen) return
    drawerOpen = false
    // After this tick the drawer is unmounted: inert released, trap removed.
    await tick()
    if (reason === 'navigate') return
    if (reason === 'resize') {
      const col = shell?.querySelector<HTMLElement>('.nav-col')
      const target =
        col?.querySelector<HTMLElement>('a[aria-current="page"]') ?? col?.querySelector<HTMLElement>('a[href], button')
      target?.focus()
      return
    }
    hamburger?.focus()
  }
</script>

<svelte:head>
  {@html SHELL_CSS}
</svelte:head>

<!-- #288 (HANDOVER-v8 Part E): the per-tenant accent ramp is injected as a
     <style id="__instance-theme"> in <head> AFTER app.css (hooks.server.ts
     tenantBrandStyleHandle), deriving the FULL accent ramp (accent/ink/soft/faint,
     light+dark) from the curated hue. It is NOT set inline here on purpose: an
     inline `style:--accent` on this descendant <div> would override the
     html.cb-* colour-blind a11y accents (higher cascade origin on a more-specific
     element wins), inverting accessibility. `brand` is still passed down for the
     logo/strings.
     TASK-208: .app-shell is 100dvh (100vh fallback) — see navShellCss. -->
<div class="app-shell" style="background: var(--paper);" data-nav-ready={ready ? '' : undefined} bind:this={shell}>
  <Sidebar
    {nav}
    {activeHref}
    {counts}
    {userName}
    {roles}
    {groups}
    {brand}
    {sourceUrl}
    {mode}
    ontoggle={toggleSidebar}
    suppressCurrent={drawerOpen}
  />
  <div class="app-shell-body">
    <TopBar {brand} {nav} unread={counts.unread} modules={topbarModules} {bodyContext}>
      {#snippet leading()}
        <button
          bind:this={hamburger}
          type="button"
          class="nav-hamburger nav-drawer-only"
          aria-label={$t('nav.menu')}
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? DRAWER_ID : undefined}
          onclick={openDrawer}
        >
          <Icon name="menu" size={20} />
        </button>
      {/snippet}
    </TopBar>
    <main class="app-main" id="main-content" tabindex="-1">
      {@render children()}
    </main>
  </div>
  {#if drawerOpen}
    <NavDrawer
      id={DRAWER_ID}
      {nav}
      {counts}
      {currentHref}
      {userName}
      {roles}
      {brand}
      {sourceUrl}
      onclose={(reason) => void closeDrawer(reason)}
    />
  {/if}
  <div class="sr-only" role="status" aria-live="polite">{status}</div>
</div>

<style>
  .nav-hamburger {
    width: var(--nav-control, 44px);
    height: var(--nav-control, 44px);
    flex-shrink: 0;
    margin-left: -4px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--ink-2);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .nav-hamburger:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .nav-hamburger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
</style>
