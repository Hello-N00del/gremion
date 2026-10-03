<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { FileWorkspace } from '../../../routes/files/+page.server'

  // Workspace/tags sidebar (Task 3.4) — ported from the v5 prototype
  // (screens.jsx:416-433). Workspaces are seeder-backed org-unit folders passed
  // from the loader; tags are generic document categories (forward-looking
  // filters — Nextcloud systemtags have no WebDAV path, so selecting one does
  // not change the browser path yet). No hardcoded institution strings.
  interface Props {
    workspaces: FileWorkspace[]
    active: string
    onSelect: (id: string) => void
  }

  let { workspaces, active, onSelect }: Props = $props()

  const TAGS = ['Protokolle', 'Anträge', 'Vorlagen', 'Archiv']
</script>

<aside class="ws-sidebar">
  <div class="eyebrow ws-label">Workspaces</div>
  <button
    type="button"
    class="tree-row"
    class:sel={active === ''}
    onclick={() => onSelect('')}
  >
    <Icon name="folder" size={15} />
    <span>Alle Dateien</span>
  </button>
  {#each workspaces as ws (ws.id)}
    <button
      type="button"
      class="tree-row"
      class:sel={active === ws.label}
      onclick={() => onSelect(ws.label)}
      title={ws.label}
    >
      <span class="ws-dot" style="--c-hue: {ws.hue};" aria-hidden="true"></span>
      <span class="ws-name">{ws.label}</span>
    </button>
  {/each}

  <div class="ws-divider" aria-hidden="true"></div>

  <div class="eyebrow ws-label">Tags</div>
  {#each TAGS as tag (tag)}
    <div class="tree-row tree-row-tag">
      <span class="tag-swatch" aria-hidden="true"></span>
      <span class="tag-name">{tag}</span>
    </div>
  {/each}
</aside>

<style>
  /* Generic primitives (.eyebrow) come from app.css; the bespoke tree classes
     resolve to design tokens so .dark auto-switches. */
  .ws-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ws-label {
    padding: 6px 10px;
    margin-bottom: 4px;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--ink-2);
    font-size: 13px;
    cursor: pointer;
  }
  .tree-row:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .tree-row.sel {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 500;
  }
  .tree-row-tag {
    cursor: default;
  }
  .tree-row-tag:hover {
    background: transparent;
    color: var(--ink-2);
  }
  .ws-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
    background: oklch(55% 0.13 var(--c-hue, 252));
  }
  :global(.dark) .ws-dot {
    background: oklch(72% 0.14 var(--c-hue, 252));
  }
  .ws-divider {
    height: 1px;
    background: var(--border);
    margin: 14px 6px;
  }
  .tag-swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
    background: var(--accent);
  }
  .tag-name {
    color: var(--ink-2);
  }
</style>
