<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const s = $derived(data.status)
  const staleTotal = $derived(s.staleSteps.length + s.staleAreas.length)
</script>

<svelte:head><title>Code-Karte · Gremion Betrieb</title></svelte:head>

<h1>Code-Karte</h1>
<p class="lead">
  Eine Karte des Gremion-Codes mit Ebenen, Bereichen, Funktionen und ihren Verbindungen. Ein Programm hat sie beim Bau dieses Images aus dem Quellcode erzeugt.
</p>
<p class="meta">
  Stand des Codes: <code>{s.commit}</code>
  {#if s.commit === 'unknown'}<span class="muted">(das Image kennt seinen Commit nicht)</span>{/if}
</p>

{#if !s.ok}
  <p class="notice bad" role="status">
    Die Code-Karte ist in diesem Image nicht verfügbar. Grund: {s.reason}
    <span class="muted">Das Panel selbst ist davon nicht betroffen.</span>
  </p>
{:else}
  {#if staleTotal > 0}
    <p class="notice warn" role="status">
      Der Text der Karte passt an {staleTotal} {staleTotal === 1 ? 'Stelle' : 'Stellen'} nicht mehr zum Code: {s.staleSteps.length}
      {s.staleSteps.length === 1 ? 'Schritt eines Beispiels' : 'Schritte von Beispielen'}, {s.staleAreas.length}
      {s.staleAreas.length === 1 ? 'Bereich' : 'Bereiche'}. Die Karte zeigt diese Stellen nicht.
    </p>
  {/if}
  {#if staleTotal > 0 || s.undescribedAreas.length > 0}
    <details class="list">
      <summary>Abweichungen zwischen Text und Code anzeigen</summary>
      {#if s.staleSteps.length > 0}
        <h2>Beispiel-Schritte ohne Treffer im Code</h2>
        <ul>
          {#each s.staleSteps as st, i (`${st.walkthrough}-${st.step}-${i}`)}
            <li>
              {st.walkthrough}, Schritt {st.step}: <code>{st.file && st.function ? `${st.file} · ${st.function}` : (st.nodeId ?? 'unbekannt')}</code>
            </li>
          {/each}
        </ul>
      {/if}
      {#if s.staleAreas.length > 0}
        <h2>Bereiche mit Text, die es im Code nicht mehr gibt</h2>
        <ul>
          {#each s.staleAreas as a (a)}<li><code>{a}</code></li>{/each}
        </ul>
      {/if}
      {#if s.undescribedAreas.length > 0}
        <h2>Bereiche im Code ohne Text</h2>
        <ul>
          {#each s.undescribedAreas as a (a)}<li><code>{a}</code></li>{/each}
        </ul>
      {/if}
    </details>
  {/if}
  <p class="muted counts">{s.counts.functions} Funktionen, {s.counts.connections} Verbindungen.</p>
  <iframe class="map" src="/codemap/map" sandbox="allow-scripts" title="Code-Karte von Gremion"></iframe>
{/if}

<style>
  h1 {
    margin: 1rem 0 0.25rem;
  }
  h2 {
    font-size: 0.95rem;
    margin: 0.75rem 0 0.25rem;
  }
  .lead,
  .meta {
    margin: 0.25rem 0;
    max-width: 60rem;
  }
  .muted {
    color: var(--muted);
  }
  .counts {
    margin: 0.5rem 0;
    font-size: 0.85rem;
  }
  .notice {
    border: 1px solid var(--line);
    border-left-width: 5px;
    border-radius: 4px;
    padding: 0.6rem 0.9rem;
    margin: 0.75rem 0;
  }
  .notice.warn {
    border-left-color: var(--warn);
  }
  .notice.bad {
    border-left-color: var(--bad);
  }
  .list {
    margin: 0.5rem 0;
  }
  .list summary {
    cursor: pointer;
    color: var(--accent);
  }
  .list ul {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
    overflow-wrap: anywhere;
  }
  .map {
    display: block;
    width: 100%;
    height: calc(100vh - 14rem);
    min-height: 32rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
  }
</style>
