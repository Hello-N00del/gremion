<script lang="ts">
  // #289: "Begriffe dieser Instanz" — surfaces the active tenant's term-map
  // (per-tenant display-label overrides keyed by stable internal IDs, see
  // $lib/terms). Display-only. Renders nothing for a tenant with no overrides
  // (StuRa tenant #1), so the panel only appears where it carries information.
  let { terms }: { terms?: Record<string, string> | null } = $props()
  const entries = $derived(Object.entries(terms ?? {}))
</script>

{#if entries.length}
  <aside class="term-map">
    <h3 class="tm-head">Begriffe dieser Instanz</h3>
    <dl class="tm-list">
      {#each entries as [key, label] (key)}
        <div class="tm-row">
          <dt class="mono">{key}</dt>
          <dd>{label}</dd>
        </div>
      {/each}
    </dl>
  </aside>
{/if}

<style>
  .term-map {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg, 14px);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .tm-head { font-size: 13px; font-weight: 600; }
  .tm-list { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .tm-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .tm-row dt {
    font-size: 11px;
    color: var(--ink-muted);
    letter-spacing: .02em;
  }
  .tm-row dd { font-size: 13.5px; color: var(--ink); margin: 0; text-align: right; }
  .mono { font-family: var(--font-mono); }
</style>
