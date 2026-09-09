<script lang="ts">
  import { page } from '$app/state'
  import { onMount } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { themeMode } from '$lib/stores/theme'
  import { resolveBrand, type Brand } from '$lib/brand'
  import { termFor } from '$lib/terms'
  import { INSTANCE_STATE_META, instanceReady, type InstanceState } from '$lib/instance-status'
  import CommandPalette from '$lib/components/CommandPalette.svelte'
  import type { NavItem } from './nav-schema'

  // Tenant brand (v4 re-audit slice 10) — prop-drilled from AppShell; canonical
  // defaults back-fill so the breadcrumb root never renders blank. `nav` is the
  // role-filtered tree the command palette searches over (PAGE_ACCESS-gated
  // upstream in +layout.server.ts, so it can't surface forbidden pages).
  let {
    brand: brandProp,
    nav = [],
    unread = 0
  }: { brand?: Partial<Brand> | null; nav?: NavItem[]; unread?: number } = $props()
  let brand = $derived(resolveBrand(brandProp))
  // (open-core carve) `unread` is still accepted from AppShell for prop-shape
  // stability but no longer drives a bell badge here — the messages module owns
  // the notification surface and reintroduces it via a registered topbar slot.
  void unread

  // Command palette (⌘K / Ctrl-K). Opens globally; the search field is also a
  // button so it's reachable by pointer + keyboard without the shortcut.
  let paletteOpen = $state(false)

  function onGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      paletteOpen = !paletteOpen
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onGlobalKeydown)
    return () => window.removeEventListener('keydown', onGlobalKeydown)
  })

  const CRUMB_LABELS: Record<string, string> = {
    calendar: 'Kalender',
    files: 'Dokumente',
    finance: 'Finanzen',
    votes: 'Abstimmungen',
    elections: 'Wahlen',
    polls: 'Umfragen',
    members: 'Mitglieder',
    committees: 'Gremien',
    messages: 'Nachrichten',
    settings: 'Einstellungen',
    portal: 'Portal-Verwaltung',
    news: 'Neuigkeiten',
    users: 'Nutzer',
    editor: 'Editor',
    protokolle: 'Protokolle',
    beschluesse: 'Beschlüsse',
    new: 'Neu',
    // Finance sub-pages
    budget: 'Haushaltsplan',
    projects: 'Projekte',
    expenses: 'Ausgaben',
    bookings: 'Buchungen',
    'bank-accounts': 'Konten',
    approvals: 'Freigaben',
    'sub-organisations': 'Suborganisationen',
    // Settings sub-pages
    general: 'Allgemein',
    email: 'E-Mail',
    services: 'Dienste',
    legal: 'Rechtliches',
    backups: 'Sicherungen',
    retention: 'Löschfristen',
    compliance: 'Datenschutz',
    accessibility: 'Barrierefreiheit',
    danger: 'Gefahrenzone',
  }

  // Pages can supply per-segment overrides (typically to substitute a UUID
  // segment with a friendly entity name) by returning `crumbOverrides` from
  // their server load. A `null`/empty value drops the segment entirely.
  // Example: `crumbOverrides: { [params.id]: committee.name, committees: null }`
  type CrumbOverrides = Readonly<Record<string, string | null>>
  let overrides = $derived(
    (page.data as { crumbOverrides?: CrumbOverrides }).crumbOverrides ?? {}
  )

  // #289 (HANDOVER-v8 Part F): the per-tenant term-map (page.data.terms). The
  // 'committees' breadcrumb re-terms (Gremien → Ausschüsse for a Gemeinderat);
  // StuRa tenant #1 has no override so termFor falls back to the literal.
  let terms = $derived(
    (page.data as { terms?: Record<string, string> | null }).terms ?? undefined
  )

  // #264 (HANDOVER-v8 Part C): the instance convergence badge. Shown ONLY when the
  // instance is not fully converged (provisioning/degraded/failed); a ready
  // instance (the normal case for tenant #1) renders no badge. Click → Systemstatus.
  let instanceState = $derived(
    (page.data as { instanceState?: InstanceState }).instanceState ?? 'ready'
  )
  let instanceMeta = $derived(INSTANCE_STATE_META[instanceState] ?? INSTANCE_STATE_META.ready)
  let showInstanceBadge = $derived(!instanceReady(instanceState))

  let crumbs = $derived(
    page.url.pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (seg in overrides) return overrides[seg]
        if (seg === 'committees') return termFor(terms, 'gremien', CRUMB_LABELS.committees)
        return CRUMB_LABELS[seg] ?? seg
      })
      .filter((label): label is string => !!label)
  )
</script>

<header class="topbar">
  <!-- Breadcrumbs (mono / uppercase, per chrome.jsx .crumbs) -->
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="/" class="root" class:last={crumbs.length === 0}>{brand.product}</a>
    {#each crumbs as crumb, i (i)}
      <span class="sep" aria-hidden="true">/</span>
      <span class:last={i === crumbs.length - 1}>{crumb}</span>
    {/each}
  </nav>

  <!-- Search affordance — opens the ⌘K command palette -->
  <button
    type="button"
    class="search"
    onclick={() => (paletteOpen = true)}
    aria-label="Befehlspalette öffnen (Strg + K)"
    aria-haspopup="dialog"
  >
    <Icon name="search" size={14} aria-hidden="true" />
    <span>Antrag, Datei, Person…</span>
    <span class="k" aria-hidden="true">⌘ K</span>
  </button>

  <CommandPalette bind:open={paletteOpen} {nav} />

  <!-- #264: instance convergence badge — only when NOT fully converged. -->
  {#if showInstanceBadge}
    <a
      href="/systemstatus"
      class="topbar-status inst"
      class:danger={instanceMeta.tone === 'danger'}
      title="Bereitstellung & Konvergenz · Systemstatus öffnen"
    >
      <Icon name={instanceMeta.icon} size={11} aria-hidden="true" />
      INSTANZ · {instanceMeta.label}
    </a>
  {/if}

  <!-- (open-core carve) The CALL·LIVE / Matrix status chips and the /messages
       notification bell belonged to the messages/video module and were removed
       with it; a re-added module supplies its own status chip + bell via a
       registered topbar slot. -->

  <!-- Theme toggle -->
  <button
    type="button"
    class="icon-btn"
    onclick={() => themeMode.set($themeMode === 'dark' ? 'light' : 'dark')}
    aria-label={$themeMode === 'dark' ? 'Helles Thema' : 'Dunkles Thema'}
    aria-pressed={$themeMode === 'dark'}
    title={$themeMode === 'dark' ? 'Helles Thema' : 'Dunkles Thema'}
  >
    <Icon name={$themeMode === 'dark' ? 'sun' : 'moon'} size={16} />
  </button>

  <!-- Logout -->
  <form method="POST" action="/auth/logout" class="logout">
    <button type="submit" class="icon-btn" aria-label="Abmelden" title="Abmelden">
      <Icon name="log-out" size={16} />
    </button>
  </form>
</header>

<style>
  .topbar {
    height: 56px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 24px;
    min-width: 0;
  }
  .crumbs {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .crumbs .sep {
    color: var(--ink-faint);
  }
  .crumbs .last {
    color: var(--ink);
  }
  .crumbs .root {
    color: var(--ink-muted);
    text-decoration: none;
    transition: color var(--d-fast) var(--e-out);
  }
  .crumbs .root:hover {
    color: var(--ink);
  }
  .search {
    margin-left: auto;
    max-width: 260px;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--ink-muted);
    white-space: nowrap;
    overflow: hidden;
    /* button reset — .search used to be a <div> */
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color var(--d-fast) var(--e-out);
  }
  .search:hover {
    border-color: var(--border-strong);
    color: var(--ink-2);
  }
  .search > span {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12.5px;
  }
  .search .k {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 5px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .topbar-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 100px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 500;
    background: var(--surface-2);
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .topbar-status .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pine);
    box-shadow: 0 0 0 2px var(--pine-soft);
  }
  .call-live {
    background: var(--pine-soft);
    color: var(--pine);
    border-color: transparent;
  }
  .call-live .pulse {
    background: var(--pine);
    box-shadow: 0 0 0 2px var(--pine-soft);
  }
  /* #264 instance convergence badge — warn tone by default, danger for failed.
     Rendered as an <a> to /systemstatus; reset link defaults. */
  .topbar-status.inst {
    background: var(--ember-soft);
    color: var(--ember-ink);
    border-color: transparent;
    text-decoration: none;
    cursor: pointer;
  }
  .topbar-status.inst:hover {
    color: var(--ink);
  }
  .topbar-status.inst.danger {
    background: var(--rust-soft);
    color: var(--rust-ink);
  }
  .icon-btn {
    width: 32px;
    height: 32px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    cursor: pointer;
    color: var(--ink-2);
    background: transparent;
    border: none;
    position: relative;
    flex-shrink: 0;
    transition: background var(--d-fast) var(--e-out);
  }
  .icon-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  /* Unread count badge on the notification bell. Anchored top-right like the old
     placeholder dot, but carries the real count (capped 99+). Hidden entirely
     when unread is 0 (the {#if} drops the element). */
  .icon-btn .count {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 100px;
    display: grid;
    place-items: center;
    background: var(--ember);
    color: var(--paper);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    box-shadow: 0 0 0 2px var(--surface);
  }
  /* The bell is now an <a>; reset its link defaults to match the icon buttons. */
  a.icon-btn {
    text-decoration: none;
  }
  .logout {
    display: flex;
    flex-shrink: 0;
  }
  /* Hide the lower-priority chips first as the bar narrows */
  @media (max-width: 720px) {
    .search {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .topbar-status {
      display: none;
    }
  }
</style>
