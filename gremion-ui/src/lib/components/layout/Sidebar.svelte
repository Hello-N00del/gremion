<script lang="ts">
  // The navigation column (TASK-208): an icon rail or the expanded sidebar at
  // 768 px and above, not rendered into the layout below (the drawer takes
  // over). Rail vs expanded is decided by CSS (navShellCss: media query plus
  // the html.nav-rail / html.nav-expanded class set before first paint), so
  // SSR and the first paint agree without JS; `mode` only drives ARIA and the
  // rail tooltip once the shell has hydrated.
  import NavList from './NavList.svelte'
  import NavToggle from './NavToggle.svelte'
  import NavUser from './NavUser.svelte'
  import LegalMenu from './LegalMenu.svelte'
  import RailTooltip from './RailTooltip.svelte'
  import type { NavItem } from './nav-schema'
  import type { NavMode } from './nav-state'
  import { resolveBrand, type Brand } from '$lib/brand'
  import { resolveSourceUrl } from '$lib/source-offer'
  import { navHrefs, resolveActiveHref } from './nav-active'
  import { DEFAULT_NAV_LABELS, type NavLabels } from './nav-labels'

  let {
    nav = [],
    activeHref = '',
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    userName = '',
    roles = [],
    brand: brandProp,
    // AGPL-3.0 section 13 — the offer of the Corresponding Source has to be
    // reachable from the running program, not only from the repository. The
    // layout load supplies the operator's value; the default keeps the offer
    // present even when a caller does not thread it through.
    sourceUrl = resolveSourceUrl(),
    mode = null,
    ontoggle,
    suppressCurrent = false,
    labels = DEFAULT_NAV_LABELS
  }: {
    nav?: NavItem[]
    activeHref?: string
    counts?: { approvals: number; liveVotes: number; unread: number }
    userName?: string
    roles?: string[]
    /** Accepted for prop-shape stability; the footer shows friendly role labels only (WP-2). */
    groups?: string[]
    brand?: Partial<Brand> | null
    sourceUrl?: string
    /** The hydrated navigation form; null before hydration. */
    mode?: NavMode | null
    ontoggle?: () => void
    /** While the drawer is open its copy carries aria-current, not this one. */
    suppressCurrent?: boolean
    /** Translated strings (AppShell passes navLabels($t)). */
    labels?: NavLabels
  } = $props()

  // Tenant brand (v4 re-audit slice 10) — prop-drilled from the root layout via
  // AppShell; canonical defaults back-fill so the brand never renders blank.
  let brand = $derived(resolveBrand(brandProp))

  // One current link: the longest matching nav href (nav-active.ts).
  let currentHref = $derived(suppressCurrent ? null : resolveActiveHref(navHrefs(nav), activeHref))

  let column: HTMLElement | undefined = $state()
</script>

<!-- A plain column, not an <aside>: the <nav> inside is the landmark. -->
<div class="nav-col sidebar" bind:this={column}>
  <div class="sb-brand">
    <!-- P2.2-data: per-tenant logo (config.brand.logo_url → brand.logoUrl).
         Same .sb-logo size/box classes as the letter mark; null = today's
         letter mark, byte-identical. -->
    {#if brand.logoUrl}
      <img class="sb-logo" src={brand.logoUrl} alt={brand.orgShort} />
    {:else}
      <div class="sb-logo" aria-hidden="true">{brand.logoLetter}</div>
    {/if}
    <div class="sb-brand-txt nav-expanded-only">
      <div class="n">{brand.product}</div>
      <div class="s">{brand.orgShort} · {brand.term}</div>
    </div>
    <NavToggle expanded={mode === null || mode === 'drawer' ? null : mode === 'expanded'} {ontoggle} {labels} />
  </div>

  <nav class="sb-nav" aria-label={labels['nav.main']}>
    <NavList {nav} {counts} {currentHref} idPrefix="nav-col" />
  </nav>

  <NavUser {userName} {roles} />
  <LegalMenu {sourceUrl} idPrefix="nav-col" {labels} />

  <RailTooltip container={column} enabled={mode === 'rail'} />
</div>

<style>
  .sidebar {
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    height: 100%;
    flex-shrink: 0;
    overflow: hidden;
    transition: width var(--nav-motion) var(--e-out);
  }
  .sb-brand {
    padding: 12px 8px 10px 18px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--border);
  }
  .sb-logo {
    width: 30px;
    height: 30px;
    border-radius: 4px;
    background: var(--ink);
    color: var(--paper);
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.02em;
    position: relative;
    flex-shrink: 0;
  }
  .sb-logo::after {
    content: '';
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 8px;
    height: 8px;
    background: var(--ember);
    border-radius: 2px;
  }
  .sb-brand-txt {
    flex: 1;
    min-width: 0;
    line-height: 1.1;
  }
  .sb-brand-txt .n {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  .sb-brand-txt .s {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    color: var(--ink-muted);
    text-transform: uppercase;
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .sb-nav {
    padding: 0 8px 8px;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
</style>
