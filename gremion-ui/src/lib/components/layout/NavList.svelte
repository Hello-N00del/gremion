<script lang="ts">
  // The navigation links, shared by the column (Sidebar) and the drawer
  // (NavDrawer). `idPrefix` keeps the section-heading ids unique while both
  // are in the DOM. Each section is a list labelled by its heading; each link's
  // accessible name is its label plus its badge count (UX-071a AC-5).
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { NavItem } from './nav-schema'

  type Leaf = Extract<NavItem, { kind: 'item' }>

  let {
    nav = [],
    counts = { approvals: 0, liveVotes: 0, unread: 0 },
    currentHref = null,
    idPrefix,
    onnavigate
  }: {
    nav?: NavItem[]
    counts?: { approvals: number; liveVotes: number; unread: number }
    /** The one nav href that is the current page (nav-active.ts), or null. */
    currentHref?: string | null
    idPrefix: string
    onnavigate?: (href: string) => void
  } = $props()

  function badgeCount(item: Leaf): number {
    if (item.badge === 'count') return counts.approvals
    if (item.badge === 'live') return counts.liveVotes
    if (item.badge === 'unread') return counts.unread
    return 0
  }

  // Top-level leaves between sections are grouped into unlabelled lists.
  type Group = { label: string | null; items: Leaf[]; key: string }
  let groups = $derived.by(() => {
    const out: Group[] = []
    for (const node of nav) {
      if (node.kind === 'section') {
        out.push({ label: node.label, key: `s:${node.label}`, items: node.children.filter((c): c is Leaf => c.kind === 'item') })
      } else {
        const last = out[out.length - 1]
        if (last && last.label === null) last.items.push(node)
        else out.push({ label: null, key: `i:${node.href}`, items: [node] })
      }
    }
    return out
  })
</script>

{#snippet link(item: Leaf)}
  {@const n = badgeCount(item)}
  {@const current = item.href === currentHref}
  <a
    href={item.href}
    class="sb-item"
    class:active={current}
    aria-current={current ? 'page' : undefined}
    aria-label={n > 0 ? `${item.label} ${n}` : item.label}
    data-nav-label={item.label}
    onclick={() => onnavigate?.(item.href)}
  >
    <Icon name={item.icon} size={18} />
    <span class="sb-label nav-rail-hide">{item.label}</span>
    {#if n > 0}
      <span class="sb-badge" class:live={item.badge === 'live'} aria-hidden="true">{n}</span>
    {/if}
  </a>
{/snippet}

{#each groups as group, i (group.key)}
  {#if group.label !== null}
    <div class="sb-section nav-rail-hide" id="{idPrefix}-sec-{i}">{group.label}</div>
    <div class="sb-section-rule nav-rail-only" aria-hidden="true"></div>
    <ul class="sb-list" aria-labelledby="{idPrefix}-sec-{i}">
      {#each group.items as item (item.href)}
        <li>{@render link(item)}</li>
      {/each}
    </ul>
  {:else}
    <ul class="sb-list">
      {#each group.items as item (item.href)}
        <li>{@render link(item)}</li>
      {/each}
    </ul>
  {/if}
{/each}

<style>
  .sb-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .sb-section {
    padding: 18px 12px 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .sb-section-rule {
    height: 1px;
    margin: 10px 12px;
    background: var(--border);
  }
  .sb-item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    color: var(--ink-2);
    cursor: pointer;
    font-size: var(--nav-font, 13.5px);
    font-weight: 450;
    line-height: 1.3;
    position: relative;
    text-decoration: none;
    transition: background var(--d-fast) var(--e-out);
    user-select: none;
  }
  .sb-item :global(svg) {
    flex-shrink: 0;
  }
  .sb-item:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .sb-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
  /* Labels wrap instead of an ellipsis: nothing is clipped at 200 % text or
     with the SC 1.4.12 spacing overrides. */
  .sb-label {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
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
</style>
