<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  // Aggregate Beschlüsse (resolution book) surface. v4 nav links here from the
  // Gremien section. Beschlüsse are passed resolutions from published protocols
  // (the canonical 007_protocols source); the table renders when rows exist,
  // otherwise the first-class empty state.
  import type { PageData } from './$types'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { deriveHue } from '$lib/governance/committee-color'
  import { moduleHref } from '$lib/modules/registry'

  let { data }: { data: PageData } = $props()

  // Only point at /votes when a registered module owns it — the empty state is
  // exactly what a fresh instance shows, so a dead link here is the first thing
  // a new deployment sees.
  const votesHref = moduleHref('votes')

  const beschluesse = $derived(data.beschluesse)

  function fmtDate(iso: string): string {
    // iso is YYYY-MM-DD (already date-only from the DB).
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }

  // Beschluss-Nr: prefer the published global_nr (B-YYYY-NNN); fall back to a
  // synthesized number from the meeting year + per-protocol sequence.
  function beschlussNr(b: PageData['beschluesse'][number]): string {
    if (b.globalNr) return b.globalNr
    const year = b.meetingDate.slice(0, 4)
    return `B-${year}-${String(b.sequenceNr).padStart(3, '0')}`
  }

  function unanimous(b: PageData['beschluesse'][number]): boolean {
    return b.votesNo === 0 && b.votesAbstain === 0 && b.votesYes > 0
  }
</script>

<PageTitle title="Beschlüsse" />

<div class="page">
  <header class="page-head">
    <div class="eyebrow">Beschlussbuch</div>
    <h1 class="display">Beschlüsse</h1>
    <p class="page-sub">
      Verbindliche Beschlüsse aller Gremien — volltextsuchbar, mit Verweis aufs zugehörige Protokoll.
    </p>
  </header>

  {#if beschluesse.length === 0}
    <div class="empty-state">
      <div class="glyph"><Icon name="check" size={22} /></div>
      <div class="ttl">Noch keine Beschlüsse</div>
      <div class="sub">
        Angenommene Anträge und gefasste Beschlüsse werden hier als durchsuchbares
        Beschlussbuch geführt.{#if votesHref}
          Laufende Abstimmungen sehen Sie unter <a href={votesHref}>Abstimmungen</a>.{/if}
      </div>
    </div>
  {:else}
    <div class="card tbl">
      <div class="tbl-row tbl-head">
        <div>Beschluss-Nr.</div>
        <div>Gegenstand</div>
        <div>Gremium · Datum</div>
        <div>Mehrheit</div>
      </div>
      {#each beschluesse as b (b.id)}
        {@const hue = deriveHue(b.committeeId)}
        <div class="tbl-row">
          <div class="mono td-nr">{beschlussNr(b)}</div>
          <div class="td-trunc">
            <div class="td-primary td-trunc">{b.text}</div>
            <div class="td-muted td-trunc">{b.protocolTitle}</div>
          </div>
          <div>
            <span class="com-mono" style="--c-hue: {hue};">
              <span class="bar"></span>{b.committeeName}
            </span>
            <div class="mono td-muted td-date">{fmtDate(b.meetingDate)}</div>
          </div>
          <div>
            {#if unanimous(b)}
              <span class="pill pill-success">einstimmig</span>
            {:else}
              <span class="mono td-muted">{b.votesYes}:{b.votesNo}:{b.votesAbstain}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <p class="tbl-foot mono">{beschluesse.length} Beschlüsse · Format ja:nein:enthaltung</p>
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
    grid-template-columns: 130px 1fr 200px 100px;
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
  .td-nr {
    font-size: 11.5px;
    font-weight: 500;
  }
  .td-date {
    margin-top: 2px;
  }

  /* Committee monogram chip (com-mono) — not in app.css; ported from the
     bundle. A coloured bar + the committee name, hue from committee-color.ts. */
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

  .tbl-foot {
    margin-top: 10px;
    font-size: 11px;
    color: var(--ink-faint);
  }
</style>
