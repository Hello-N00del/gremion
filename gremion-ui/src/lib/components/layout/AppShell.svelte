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
  import { onMount, tick, untrack } from 'svelte'
  import { t } from '$lib/i18n'
  import { resolveSourceUrl } from '$lib/source-offer'
  import { MQ_COLUMN, MQ_WIDE, navShellCss } from './nav-constants'
  import { applyNavPrefClass, createNavPrefStore, modeFromMatches, type NavMode, type NavPref } from './nav-state'
  import { navHrefs, resolveActiveHref } from './nav-active'
  import { navLabels } from './nav-labels'

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
  // The two media queries' matches: the same test the CSS applies, so JS and
  // CSS never disagree (fractional widths under zoom included).
  let matches = $state<{ column: boolean; wide: boolean } | null>(null)
  let ready = $state(false)
  let drawerOpen = $state(false)
  let hamburger: HTMLButtonElement | undefined = $state()
  let shell: HTMLElement | undefined = $state()

  // null until hydrated: SSR renders no state-dependent ARIA it could get wrong.
  let mode = $derived<NavMode | null>(matches === null ? null : modeFromMatches(matches.column, matches.wide, pref))
  let currentHref = $derived(resolveActiveHref(navHrefs(nav), activeHref))

  onMount(() => {
    pref = prefs.read()
    const column = matchMedia(MQ_COLUMN)
    const wide = matchMedia(MQ_WIDE)
    const sync = () => {
      matches = { column: column.matches, wide: wide.matches }
      if (column.matches && drawerOpen) void closeDrawer('resize')
    }
    sync()
    column.addEventListener('change', sync)
    wide.addEventListener('change', sync)
    // The command palette lives behind the drawer's inert background, so the
    // Ctrl/Cmd+K shortcut is swallowed while the drawer is open.
    const onKey = (e: KeyboardEvent) => {
      if (drawerOpen && (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    ready = true
    return () => {
      column.removeEventListener('change', sync)
      wide.removeEventListener('change', sync)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  // Any route change closes the drawer, whatever started it (browser back,
  // goto(), a redirect) — not only a click on one of the drawer's links.
  let lastHref = untrack(() => activeHref)
  $effect(() => {
    const href = activeHref
    if (href !== lastHref) {
      lastHref = href
      if (drawerOpen) void closeDrawer('navigate')
    }
  })

  function toggleSidebar() {
    const next: NavPref = mode === 'expanded' ? 'rail' : 'expanded'
    pref = next
    prefs.write(next)
    applyNavPrefClass(document.documentElement, next)
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
     TASK-208: .app-shell is 100dvh, with a vh fallback line — see navShellCss. -->
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
    labels={navLabels($t)}
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
      activePath={activeHref}
      {userName}
      {roles}
      {brand}
      {sourceUrl}
      onclose={(reason) => void closeDrawer(reason)}
    />
  {/if}
</div>

<style>
  .nav-hamburger {
    width: var(--nav-control);
    height: var(--nav-control);
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
