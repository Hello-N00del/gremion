<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { formatValue, summarize } from '$lib/betrieb-format'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  type Panel = PageData['panels'][number]
  type Row = Panel['rows'][number]

  const LEVEL_LABEL: Record<string, string> = { bad: 'kritisch', warn: 'Warnung', ok: 'ok' }

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

  /** The status tiles: how many rows are fine, and the ones that are not. */
  function status(p: Panel): { good: number; total: number; bad: Row[] } {
    const bad = p.rows.filter((r) => r.level !== 'ok')
    return { good: p.rows.length - bad.length, total: p.rows.length + p.hidden, bad }
  }

  const value = (p: Panel, r: Row) => formatValue(r.value, p.unit)
</script>

<svelte:head><title>Betrieb · Gremion Betrieb</title></svelte:head>

<div class="dash">
  <div class="toolbar">
    <h1>Betrieb</h1>
    {#if !data.disabled}
      <span class="summary {summary.attention ? 'attention' : 'calm'}">{summary.text}</span>
      <span class="spacer"></span>
      <span class="read">Stand {readAt}</span>
      <button type="button" onclick={refresh} disabled={refreshing} aria-label="Daten neu laden">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class:spin={refreshing}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        {refreshing ? 'Lädt' : 'Aktualisieren'}
      </button>
    {/if}
  </div>

  {#if data.disabled}
    <p class="notice warn">Die Betriebsübersicht ist hier deaktiviert: {data.disabled}</p>
  {:else if data.unreachable}
    <p class="notice bad" role="alert">{data.unreachable}</p>
  {:else}
    <div class="grid">
      {#each data.panels as p (p.id)}
        <section class="panel kind-{p.display}" class:wide={p.wide} aria-labelledby={`p-${p.id}`}>
          <header><h2 id={`p-${p.id}`} title={p.title}>{p.title}</h2></header>
          <div class="body">
            {#if p.error}
              <p class="state bad"><span aria-hidden="true">!</span> {p.error}</p>
            {:else if p.rows.length === 0}
              <p class="state">Keine Daten</p>
            {:else if p.display === 'stat'}
              <div class="stats">
                {#each p.rows as r, i (`${r.name}-${i}`)}
                  <div class="stat {r.level}">
                    <span class="big">{value(p, r)}</span>
                    <span class="label">{r.name}{#if r.level !== 'ok'}<span class="sr"> ({LEVEL_LABEL[r.level]})</span>{/if}</span>
                  </div>
                {/each}
              </div>
            {:else if p.display === 'status'}
              {@const s = status(p)}
              {#if p.id === 'unhealthy'}
                <div class="stat {s.bad.length ? 'bad' : 'ok'}">
                  <span class="big">{s.bad.length}</span>
                  <span class="label">von {s.total} ungesund</span>
                </div>
              {:else}
                <div class="stat {s.bad.length ? 'bad' : 'ok'}">
                  <span class="big">{s.good}<span class="of"> / {s.total}</span></span>
                  <span class="label">laufen</span>
                </div>
              {/if}
              {#if s.bad.length}
                <ul class="problems">
                  {#each s.bad as r, i (`${r.name}-${i}`)}
                    <li><span class="dot bad" aria-hidden="true"></span>{r.name}<span class="sr"> ({p.id === 'unhealthy' ? 'ungesund' : 'gestoppt'})</span></li>
                  {/each}
                </ul>
              {/if}
            {:else if p.display === 'bars'}
              <ul class="bars">
                {#each p.rows as r, i (`${r.name}-${i}`)}
                  <li class={r.level}>
                    <span class="name" title={r.name}>{r.name}</span>
                    <span class="track" aria-hidden="true"><span class="fill" style:width={`${Math.max(0, Math.min(100, r.value))}%`}></span></span>
                    <span class="num">{value(p, r)}{#if r.level !== 'ok'}<span class="sr"> ({LEVEL_LABEL[r.level]})</span>{/if}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <table>
                <tbody>
                  {#each p.rows as r, i (`${r.name}-${i}`)}
                    <tr class={r.level}>
                      <td class="name">{r.name}</td>
                      <td class="num">{value(p, r)}{#if r.level !== 'ok'}<span class="sr"> ({LEVEL_LABEL[r.level]})</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if p.hidden > 0}
              <p class="more">+ {p.hidden} weitere</p>
            {/if}
          </div>
        </section>
      {/each}
    </div>
    <p class="foot">Verlauf und Details: Grafana, Ordner „Betrieb“, über den SSH-Tunnel.</p>
  {/if}
</div>

<style>
  /* Grafana's dark theme, scoped to the dashboard canvas: the page reads like the
     provisioned dashboard whatever the shell's colour scheme. */
  .dash {
    --g-canvas: #111217;
    --g-panel: #181b1f;
    --g-border: rgba(204, 204, 220, 0.12);
    --g-text: #ccccdc;
    --g-muted: rgba(204, 204, 220, 0.65);
    --g-track: rgba(204, 204, 220, 0.08);
    --g-green: #73bf69;
    --g-orange: #ff9830;
    --g-red: #f2495c;
    --g-blue: #6e9fff;
    background: var(--g-canvas);
    color: var(--g-text);
    margin: 1rem 0 0;
    padding: 1rem;
    border-radius: 4px;
    min-height: 60vh;
    font-size: 14px;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
  }
  h1 {
    font-size: 1.15rem;
    font-weight: 500;
    margin: 0;
  }
  .summary {
    font-size: 0.8rem;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--g-border);
  }
  .summary.calm {
    color: var(--g-green);
  }
  .summary.attention {
    color: var(--g-orange);
    border-color: color-mix(in srgb, var(--g-orange) 40%, transparent);
  }
  .spacer {
    flex: 1;
  }
  .read {
    color: var(--g-muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font: inherit;
    font-size: 0.8rem;
    color: var(--g-text);
    background: var(--g-panel);
    border: 1px solid var(--g-border);
    border-radius: 2px;
    padding: 0.3rem 0.7rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: rgba(204, 204, 220, 0.3);
  }
  button:focus-visible {
    outline: 2px solid var(--g-blue);
    outline-offset: 1px;
  }
  button:disabled {
    color: var(--g-muted);
    cursor: progress;
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 8px;
  }
  .panel {
    background: var(--g-panel);
    border: 1px solid var(--g-border);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    grid-column: span 6;
  }
  .panel.kind-stat,
  .panel.kind-status {
    grid-column: span 3;
  }
  .panel.kind-stat.wide {
    grid-column: span 6;
  }
  @media (max-width: 60rem) {
    .panel,
    .panel.kind-stat,
    .panel.kind-stat.wide,
    .panel.kind-status {
      grid-column: span 6;
    }
  }
  @media (max-width: 36rem) {
    .dash {
      padding: 0.75rem 0.5rem;
    }
    .panel,
    .panel.kind-stat.wide {
      grid-column: span 12;
    }
    .panel.kind-stat,
    .panel.kind-status {
      grid-column: span 6;
    }
    .big {
      font-size: 1.6rem;
    }
  }
  .panel header {
    padding: 0.45rem 0.75rem 0;
  }
  h2 {
    font-size: 0.85rem;
    font-weight: 500;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    padding: 0.5rem 0.75rem 0.75rem;
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 5.5rem;
  }
  .state {
    margin: auto;
    color: var(--g-muted);
    text-align: center;
  }
  .state.bad {
    color: var(--g-red);
  }

  .stats {
    display: flex;
    gap: 1rem;
    justify-content: space-around;
  }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    min-width: 0;
  }
  .big {
    font-size: 2rem;
    font-weight: 500;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .of {
    font-size: 1.1rem;
    color: var(--g-muted);
  }
  .label {
    color: var(--g-muted);
    font-size: 0.8rem;
  }
  .stat.ok .big {
    color: var(--g-green);
  }
  .stat.warn .big {
    color: var(--g-orange);
  }
  .stat.bad .big {
    color: var(--g-red);
  }

  .problems {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    font-size: 0.8rem;
  }
  .problems li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    overflow-wrap: anywhere;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex: none;
  }
  .dot.bad {
    background: var(--g-red);
  }

  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.45rem;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(4rem, 9rem) 1fr 4.5rem;
    align-items: center;
    gap: 0.6rem;
  }
  .bars .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--g-muted);
    font-size: 0.8rem;
  }
  .track {
    height: 1.1rem;
    background: var(--g-track);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--g-green);
    opacity: 0.85;
  }
  .bars li.warn .fill {
    background: var(--g-orange);
  }
  .bars li.bad .fill {
    background: var(--g-red);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bars li.ok .num,
  tr.ok .num {
    color: var(--g-green);
  }
  .bars li.warn .num,
  tr.warn .num {
    color: var(--g-orange);
  }
  .bars li.bad .num,
  tr.bad .num {
    color: var(--g-red);
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  td {
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--g-border);
  }
  tr:last-child td {
    border-bottom: 0;
  }
  td.name {
    overflow-wrap: anywhere;
    padding-right: 1rem;
  }
  .more {
    color: var(--g-muted);
    font-size: 0.8rem;
    margin: 0.4rem 0 0;
  }
  .foot {
    color: var(--g-muted);
    font-size: 0.8rem;
    margin: 1rem 0 0;
  }
  .notice {
    border: 1px solid var(--g-border);
    background: var(--g-panel);
    padding: 0.75rem 1rem;
  }
  .notice.warn {
    color: var(--g-orange);
  }
  .notice.bad {
    color: var(--g-red);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
