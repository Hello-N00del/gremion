<script lang="ts">
  import type { TreeNodeDTO } from '../../../routes/committees/+page.server'
  import OrgTree from './OrgTree.svelte'
  let { nodes, selectedId, onselect, depth = 0 }:
    { nodes: TreeNodeDTO[]; selectedId: string | null; onselect: (n: TreeNodeDTO) => void; depth?: number } = $props()
  let open = $state<Record<string, boolean>>({})
  const isOpen = (id: string) => open[id] ?? depth === 0
</script>

<ul class="org-tree" class:nested={depth > 0}>
  {#each nodes as n (n.id)}
    <li>
      <div class="node-row" class:selected={n.id === selectedId} style="--c-hue: {n.hue};">
        {#if n.children.length}
          <button class="twisty" aria-label="Aufklappen" onclick={() => (open[n.id] = !isOpen(n.id))}>{isOpen(n.id) ? '▾' : '▸'}</button>
        {:else}
          <span class="twisty-spacer"></span>
        {/if}
        <button class="node-main" onclick={() => onselect(n)}>
          <span class="node-mono">{n.abbr}</span>
          <span class="node-label">{n.label}</span>
          <span class="authority-dot" class:advisory={n.authority === 'advisory'} class:deciding={n.authority === 'deciding'} title={n.authority === 'deciding' ? 'Beschließend' : 'Beratend'} aria-hidden="true"></span>
          <span class="node-kind mono">{n.kind_friendly}</span>
          <span class="node-count mono">{n.memberCount}</span>
        </button>
      </div>
      {#if n.children.length && isOpen(n.id)}
        {#if n.childTerm}<div class="child-term mono">{n.childTerm}</div>{/if}
        <OrgTree nodes={n.children} {selectedId} {onselect} depth={depth + 1} />
      {/if}
    </li>
  {/each}
</ul>

<style>
  .org-tree {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .org-tree.nested {
    margin-left: 18px;
    padding-left: 12px;
    border-left: 1px solid var(--line);
    margin-top: 4px;
  }
  .node-row {
    --c: hsl(var(--c-hue) 55% 45%);
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 10px;
  }
  .node-row.selected {
    background: color-mix(in srgb, var(--c) 12%, var(--surface));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent);
  }
  .twisty,
  .twisty-spacer {
    width: 28px;
    min-height: 44px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
  }
  .twisty {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink-muted);
    font-size: 12px;
    border-radius: 8px;
  }
  .twisty:hover { color: var(--ink); }
  .node-main {
    flex: 1 1 auto;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 4px 10px 4px 0;
    border-radius: 10px;
    color: var(--ink);
  }
  .node-main:hover { background: color-mix(in srgb, var(--line) 30%, transparent); }
  .node-mono {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 11.5px;
    color: #fff;
    background: var(--c);
    width: 30px; height: 30px;
    border-radius: 8px;
    display: grid; place-items: center;
    flex: 0 0 auto;
  }
  .node-label { font-size: 14px; font-weight: 600; }
  .authority-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    flex: 0 0 auto;
    background: var(--ink-muted);
  }
  .authority-dot.deciding { background: hsl(150 45% 45%); }
  .authority-dot.advisory { background: hsl(40 70% 50%); }
  .node-kind {
    font-size: 10.5px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .node-count {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-muted);
  }
  .mono { font-family: var(--font-mono); }
  .child-term {
    font-size: 10.5px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: .05em;
    margin: 6px 0 2px 30px;
  }
</style>
