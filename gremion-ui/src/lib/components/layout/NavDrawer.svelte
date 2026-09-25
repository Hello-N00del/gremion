<script module lang="ts">
  export type DrawerCloseReason = 'escape' | 'scrim' | 'close' | 'navigate'
</script>

<script lang="ts">
  // Off-canvas navigation below 768 px (TASK-208, UX-071a AC-2/4/9): a modal
  // role=dialog, mounted only while open, with its close button focused first.
  // Escape, the scrim and the close button close it; a nav link for another
  // route closes it without returning focus (the new page takes it). Theme
  // toggle and logout live here below 768 px (the TopBar drops them).
  import Icon from '$lib/components/ui/Icon.svelte'
  import NavList from './NavList.svelte'
  import NavUser from './NavUser.svelte'
  import LegalMenu from './LegalMenu.svelte'
  import { navDrawer } from './nav-drawer'
  import type { NavItem } from './nav-schema'
  import { resolveBrand, type Brand } from '$lib/brand'
  import { themeMode } from '$lib/stores/theme'
  import { t } from '$lib/i18n'

  let {
    id,
    nav = [],
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    currentHref = null,
    userName = '',
    roles = [],
    brand: brandProp,
    sourceUrl,
    onclose
  }: {
    id: string
    nav?: NavItem[]
    counts?: { approvals: number; liveVotes: number; unread: number }
    currentHref?: string | null
    userName?: string
    roles?: string[]
    brand?: Partial<Brand> | null
    sourceUrl: string
    onclose: (reason: DrawerCloseReason) => void
  } = $props()

  let brand = $derived(resolveBrand(brandProp))

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose('escape')
    }
  }

  // Activating the current page's own link is not a route change: focus goes
  // back to the hamburger as for the close button.
  function onnavigate(href: string) {
    onclose(href === currentHref ? 'close' : 'navigate')
  }
</script>

<div class="nav-drawer-root">
  <!-- The scrim is a pointer affordance only; keyboard users have Escape and the close button. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="nav-scrim" aria-hidden="true" onclick={() => onclose('scrim')}></div>
  <div
    {id}
    class="nav-drawer"
    role="dialog"
    aria-modal="true"
    aria-label={$t('nav.drawer')}
    tabindex="-1"
    use:navDrawer
    {onkeydown}
  >
    <div class="drawer-head">
      <button type="button" class="drawer-close" aria-label={$t('nav.drawer.close')} onclick={() => onclose('close')}>
        <Icon name="x" size={20} />
      </button>
      <div class="drawer-brand">
        <div class="n">{brand.product}</div>
        <div class="s">{brand.orgShort} · {brand.term}</div>
      </div>
    </div>

    <nav class="drawer-nav" aria-label={$t('nav.main')}>
      <NavList {nav} {counts} {currentHref} idPrefix="nav-drawer" {onnavigate} />
    </nav>

    <div class="drawer-actions">
      <button
        type="button"
        class="drawer-action"
        onclick={() => themeMode.set($themeMode === 'dark' ? 'light' : 'dark')}
        aria-pressed={$themeMode === 'dark'}
      >
        <Icon name={$themeMode === 'dark' ? 'sun' : 'moon'} size={18} />
        <span>{$themeMode === 'dark' ? $t('theme.light') : $t('theme.dark')}</span>
      </button>
      <form method="POST" action="/auth/logout" class="drawer-logout">
        <button type="submit" class="drawer-action">
          <Icon name="log-out" size={18} />
          <span>{$t('topbar.logout')}</span>
        </button>
      </form>
    </div>

    <NavUser {userName} {roles} />
    <LegalMenu {sourceUrl} idPrefix="nav-drawer" {onnavigate} />
  </div>
</div>

<style>
  .nav-drawer-root {
    position: fixed;
    inset: 0;
    z-index: 80;
  }
  .nav-scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim, rgba(0, 0, 0, 0.45));
  }
  .nav-drawer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(calc(100vw - 48px), var(--nav-drawer-max, 320px));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-right: 1px solid var(--border);
    box-shadow: var(--sh-3);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform: translateX(0);
    transition: transform var(--nav-motion, 220ms) var(--e-out, ease-out);
  }
  @starting-style {
    .nav-drawer {
      transform: translateX(-100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-drawer {
      transition: none;
    }
  }
  :global(html.reduce-motion) .nav-drawer {
    transition: none;
  }
  .nav-drawer:focus {
    outline: none;
  }
  .drawer-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    border-bottom: 1px solid var(--border);
  }
  .drawer-close {
    width: var(--nav-control, 44px);
    height: var(--nav-control, 44px);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--ink-2);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .drawer-close:hover {
    background: var(--surface-2);
  }
  .drawer-close:focus-visible,
  .drawer-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .drawer-brand {
    min-width: 0;
    line-height: 1.2;
  }
  .drawer-brand .n {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    overflow-wrap: anywhere;
  }
  .drawer-brand .s {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    color: var(--ink-muted);
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }
  .drawer-nav {
    flex: 1 0 auto;
    padding: 0 8px 8px;
  }
  .drawer-actions {
    border-top: 1px solid var(--border);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .drawer-logout {
    display: flex;
    flex-direction: column;
  }
  .drawer-action {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--nav-control, 44px);
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--nav-font, 13.5px);
    text-align: left;
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .drawer-action:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .drawer-action span {
    overflow-wrap: anywhere;
  }
</style>
