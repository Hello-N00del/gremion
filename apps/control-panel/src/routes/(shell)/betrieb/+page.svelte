<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { formatValue, summarize } from '$lib/betrieb-format'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const LEVEL_LABEL: Record<string, string> = { bad: 'kritisch', warn: 'Warnung', ok: '' }

  const readAt = $derived(new Date(data.readAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
  const summary = $derived(summarize(data.panels))

  let refreshing = $state(false)
  async function refresh() {
    refreshing = true
    try {
      await invalidateAll()
    } finally {
      refreshing = false
    }
  }
</script>

<svelte:head><title>Betrieb · Gremion Betrieb</title></svelte:head>

<div class="head">
  <h1>Betrieb</h1>
  {#if !data.disabled}
    <p class="read">
      Stand {readAt}
      <button type="button" onclick={refresh} disabled={refreshing}>{refreshing ? 'Lädt …' : 'Aktualisieren'}</button>
    </p>
  {/if}
</div>

{#if data.disabled}
  <p class="notice warn">Die Betriebsübersicht ist hier deaktiviert: {data.disabled}</p>
{:else if data.unreachable}
  <p class="notice bad" role="alert">{data.unreachable}</p>
{:else}
  <p class="summary" class:attention={summary.attention}>
    {summary.text}
    Verlauf und Details: Grafana (Ordner „Betrieb“) über den SSH-Tunnel.
  </p>
  <div class="grid">
    {#each data.panels as p (p.id)}
      <section aria-labelledby={`p-${p.id}`}>
        <h2 id={`p-${p.id}`}>{p.title}</h2>
        {#if p.error}
          <p class="cell-note bad">{p.error}</p>
        {/if}
        {#if p.rows.length === 0 && !p.error}
          <p class="cell-note">Keine Daten.</p>
        {:else if p.rows.length > 0}
          <ul>
            {#each p.rows as r, i (`${r.name}-${i}`)}
              <li class={r.level}>
                <span class="name">{r.name}</span>
                <span class="value">
                  {#if r.level !== 'ok'}<span class="flag">{LEVEL_LABEL[r.level]}</span>{/if}
                  {p.id === 'containers' ? (r.value >= 1 ? 'läuft' : 'gestoppt') : p.id === 'unhealthy' ? (r.value > 0 ? 'ungesund' : 'gesund') : formatValue(r.value, p.unit)}
                </span>
              </li>
            {/each}
          </ul>
          {#if p.hidden > 0}
            <p class="cell-note">+ {p.hidden} weitere</p>
          {/if}
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }
  h1 {
    font-size: 1.4rem;
    margin: 1.5rem 0 1rem;
  }
  .read {
    margin: 0;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  button {
    margin-left: 0.5rem;
    font: inherit;
    color: var(--accent);
    background: none;
    border: 1px solid var(--line);
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
  button:disabled {
    color: var(--muted);
    cursor: progress;
  }
  .summary {
    color: var(--muted);
    margin: 0 0 1rem;
  }
  .summary.attention {
    color: var(--warn);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
  }
  section {
    border: 1px solid var(--line);
    padding: 0.75rem 1rem;
    min-width: 0;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.2rem 0;
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
  }
  .name {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .value {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  li.warn .value {
    color: var(--warn);
  }
  li.bad .value {
    color: var(--bad);
    font-weight: 600;
  }
  .flag {
    font-size: 0.8em;
    margin-right: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .cell-note {
    color: var(--muted);
    margin: 0.25rem 0;
  }
  .cell-note.bad {
    color: var(--bad);
  }
  .notice {
    border: 1px solid var(--line);
    padding: 0.75rem 1rem;
  }
  .notice.warn {
    color: var(--warn);
  }
  .notice.bad {
    color: var(--bad);
  }
</style>
