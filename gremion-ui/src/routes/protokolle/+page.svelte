<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  // Aggregate Protokolle (meeting minutes) surface. v4 nav links here from the
  // Gremien section. Aggregates every committee's protocols (007_protocols);
  // the table renders when rows exist, otherwise the first-class empty state.
  import type { PageData } from './$types'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { deriveHue } from '$lib/governance/committee-color'

  let { data }: { data: PageData } = $props()

  const protocols = $derived(data.protocols)

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }
</script>

<PageTitle title="Protokolle" />

<div class="page">
  <header class="page-head">
    <div class="eyebrow">Protokolle · Sitzungsdokumentation</div>
    <h1 class="display">Protokolle</h1>
    <p class="page-sub">Sitzungsprotokolle aller Gremien — finalisiert oder im Entwurf.</p>
  </header>

  {#if protocols.length === 0}
    <div class="empty-state">
      <div class="glyph"><Icon name="file-text" size={22} /></div>
      <div class="ttl">Noch keine Protokolle</div>
      <div class="sub">
        Sobald Gremien ihre Sitzungen protokollieren, erscheinen die Niederschriften hier
        gebündelt. Einzelprotokolle finden Sie vorerst im jeweiligen Gremium unter
        <a href="/committees">Gremien &amp; Referate</a>.
      </div>
    </div>
  {:else}
    <div class="card tbl">
      <div class="tbl-row tbl-head">
        <div>Datum</div>
        <div>Sitzung</div>
        <div>Gremium</div>
        <div>TOPs</div>
        <div>Anwesend</div>
        <div>Status</div>
      </div>
      {#each protocols as p (p.id)}
        {@const hue = deriveHue(p.committeeId)}
        <div class="tbl-row">
          <div class="mono td-muted">{fmtDate(p.meetingDate)}</div>
          <div class="td-primary td-trunc">{p.title}</div>
          <div>
            <span class="com-mono" style="--c-hue: {hue};">
              <span class="bar"></span>{p.committeeName}
            </span>
          </div>
          <div class="mono">{p.tops}</div>
          <div class="mono td-muted">{p.attended}/{p.total}</div>
          <div>
            {#if p.status === 'published'}
              <span class="pill pill-success">Final</span>
            {:else}
              <span class="pill pill-warn">Entwurf</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    width: 100%;
    max-width: 1180px;
  }
  .page-head {
    margin-bottom: 18px;
  }
  .page-head h1 {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 4px;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
  }
  .empty-state a {
    color: var(--accent-ink);
    text-decoration: none;
  }
  .empty-state a:hover {
    text-decoration: underline;
  }

  .tbl {
    overflow: hidden;
  }
  .tbl-row {
    display: grid;
    grid-template-columns: 90px 1fr 200px 80px 100px 90px;
    gap: 12px;
    align-items: center;
    padding: 11px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--ink);
  }
  .tbl-row:last-child {
    border-bottom: none;
  }
  .tbl-head {
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .td-primary {
    font-weight: 500;
  }
  .td-muted {
    color: var(--ink-muted);
    font-size: 12px;
  }
  .td-trunc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .com-mono {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .com-mono .bar {
    width: 3px;
    height: 12px;
    border-radius: 2px;
    background: oklch(55% 0.13 var(--c-hue, 252));
    flex-shrink: 0;
  }
  :global(.dark) .com-mono .bar {
    background: oklch(72% 0.14 var(--c-hue, 252));
  }
</style>
