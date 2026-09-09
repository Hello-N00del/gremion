<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { NavItem } from './nav-schema'
  import { resolveBrand, type Brand } from '$lib/brand'
  import { roleLabels } from '$lib/auth/labels'
  import { resolveSourceUrl, SOURCE_OFFER_LABEL } from '$lib/source-offer'

  let {
    nav = [],
    activeHref = '',
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    userName = '',
    roles = [],
    groups = [],
    brand: brandProp,
    // AGPL-3.0 section 13 — the offer of the Corresponding Source has to be
    // reachable from the running program, not only from the repository. The
    // layout load supplies the operator's value; the default keeps the offer
    // present even when a caller does not thread it through.
    sourceUrl = resolveSourceUrl()
  }: {
    nav?: NavItem[]
    activeHref?: string
    counts?: { approvals: number; liveVotes: number; unread: number }
    userName?: string
    roles?: string[]
    groups?: string[]
    brand?: Partial<Brand> | null
    sourceUrl?: string
  } = $props()

  // Tenant brand (v4 re-audit slice 10) — prop-drilled from the root layout via
  // AppShell; canonical defaults back-fill so the brand never renders blank.
  let brand = $derived(resolveBrand(brandProp))

  function isActive(href: string): boolean {
    if (href === '/') return activeHref === '/'
    return activeHref === href || activeHref.startsWith(href + '/')
  }

  function badgeCount(item: Extract<NavItem, { kind: 'item' }>): number {
    if (item.badge === 'count') return counts.approvals
    if (item.badge === 'live') return counts.liveVotes
    if (item.badge === 'unread') return counts.unread
    return 0
  }

  function initials(name: string): string {
    if (!name) return '?'
    return name
      .split(' ')
      .map((w) => w[0] ?? '')
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
</script>

{#snippet navItem(item: Extract<NavItem, { kind: 'item' }>)}
  {@const n = badgeCount(item)}
  <a
    href={item.href}
    class="sb-item"
    class:active={isActive(item.href)}
    aria-current={isActive(item.href) ? 'page' : undefined}
  >
    {#if item.icon}
      <Icon name={item.icon} size={16} />
    {/if}
    <span class="sb-label">{item.label}</span>
    {#if n > 0}
      <span class="sb-badge" class:live={item.badge === 'live'}>{n}</span>
    {/if}
  </a>
{/snippet}

<aside class="sidebar" aria-label="Hauptnavigation">
  <div class="sb-brand">
    <!-- P2.2-data: per-tenant logo (config.brand.logo_url → brand.logoUrl).
         Same .sb-logo size/box classes as the letter mark; null = today's
         letter mark, byte-identical. -->
    {#if brand.logoUrl}
      <img class="sb-logo" src={brand.logoUrl} alt={brand.orgShort} />
    {:else}
      <div class="sb-logo" aria-hidden="true">{brand.logoLetter}</div>
    {/if}
    <div class="sb-brand-txt">
      <div class="n">{brand.product}</div>
      <div class="s">{brand.orgShort} · {brand.term}</div>
    </div>
  </div>

  <nav class="sb-nav">
    {#each nav as node (node.kind === 'section' ? `s:${node.label}` : `i:${node.href}`)}
      {#if node.kind === 'section'}
        <div class="sb-section">{node.label}</div>
        {#each node.children as child (child.kind === 'item' ? child.href : child.label)}
          {#if child.kind === 'item'}
            {@render navItem(child)}
          {/if}
        {/each}
      {:else}
        {@render navItem(node)}
      {/if}
    {/each}
  </nav>

  <div class="sb-foot">
    <div class="avatar" aria-hidden="true">{initials(userName)}</div>
    <div style="flex:1; min-width:0;">
      <div class="n">{userName || '—'}</div>
      {#if roleLabels(roles).length > 0}
        <!-- Friendly role labels only — never raw realm-role keys or Keycloak
             group ids (WP-2 identity-leakage fix). -->
        <div class="r">
          {#each roleLabels(roles).slice(0, 2) as label (label)}
            <span class="role-pill"><Icon name="shield" size={9} /> {label}</span>
          {/each}
        </div>
      {/if}
    </div>
    <Icon name="chevron-right" size={14} style="color: var(--ink-faint); flex-shrink: 0;" />
  </div>

  <div class="sb-legal">
    <a href="/legal/impressum">Impressum</a>
    <span aria-hidden="true">·</span>
    <a href="/legal/datenschutz">Datenschutz</a>
    <span aria-hidden="true">·</span>
    <a href="/legal/barrierefreiheit">Barrierefreiheit</a>
  </div>

  <div class="sb-source">
    <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{SOURCE_OFFER_LABEL}</a>
  </div>
</aside>

<style>
  .sidebar {
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    height: 100%;
    width: var(--sidebar-width, 232px);
    flex-shrink: 0;
    overflow: hidden;
  }
  .sb-brand {
    padding: 18px 18px 14px;
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
    line-height: 1.1;
  }
  .sb-brand-txt .n {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .sb-brand-txt .s {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    color: var(--ink-muted);
    text-transform: uppercase;
    margin-top: 2px;
  }
  .sb-section {
    padding: 18px 12px 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-weight: 500;
  }
  .sb-nav {
    padding: 0 8px;
    flex: 1;
    overflow-y: auto;
  }
  .sb-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    color: var(--ink-2);
    cursor: pointer;
    font-size: 13.5px;
    font-weight: 450;
    position: relative;
    text-decoration: none;
    transition: background var(--d-fast) var(--e-out);
    user-select: none;
  }
  .sb-item:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .sb-item.active {
    color: var(--ink);
    background: var(--accent-faint);
  }
  .sb-item.active::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--accent);
    border-radius: 0 2px 2px 0;
  }
  .sb-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-badge {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--ember-soft);
    color: var(--ember);
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 500;
  }
  .sb-badge.live {
    background: var(--pine-soft);
    color: var(--pine);
  }
  .sb-item.active .sb-badge {
    background: var(--accent);
    color: var(--surface);
  }
  .sb-foot {
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--surface);
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
  }
  .sb-foot .n {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-foot .r {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-muted);
    letter-spacing: 0.06em;
    margin-top: 3px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .role-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .sb-legal {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 9px 18px;
    border-top: 1px solid var(--border);
  }
  .sb-legal a {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
    text-decoration: none;
    transition: color var(--d-fast) var(--e-out);
  }
  .sb-legal a:hover {
    color: var(--ink);
  }
  .sb-legal span {
    color: var(--ink-faint);
  }
  /* AGPL section 13 source offer — same muted weight as the legal row, on its
     own line so it is not mistaken for one of the mandated legal pages. */
  .sb-source {
    display: flex;
    justify-content: center;
    padding: 0 18px 9px;
  }
  .sb-source a {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
    text-decoration: none;
    transition: color var(--d-fast) var(--e-out);
  }
  .sb-source a:hover {
    color: var(--ink);
  }
</style>
