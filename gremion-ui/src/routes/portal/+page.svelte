<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const domain = $derived(data.domain || 'stura.example.edu')

  // F1-FIX-10-K / K2#2: this page used to offer section toggles, a Haushalt
  // detail level, an Antrag mode and a comments switch, plus a status bar and
  // "DSGVO" lines. None of it was read by gremion-public (config.org.portal_sections
  // has no consumer) and the status/compliance lines were hard-coded claims. A
  // control that does nothing and a fact nobody checked are worse than no control,
  // so they are gone until gremion-public reads real flags and the status comes
  // from a real signal. The stored config key and its API stay untouched.
</script>

<PageTitle title="Portal-Verwaltung" />

<div class="page-head">
  <div>
    <div class="eyebrow">Portal · Verwaltung</div>
    <h1 class="page-title">Öffentliches Portal</h1>
    <div class="page-sub">
      Was Studierende ohne Login auf <span class="mono">{domain}</span> sehen.
    </div>
  </div>
  <div class="head-actions">
    <a href="https://{domain}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">
      <Icon name="external-link" size={14} /> Vorschau
    </a>
  </div>
</div>

<div class="card card-pad domain-card">
  <div class="eyebrow">Domain</div>
  <div class="mono domain-val">https://{domain}</div>
</div>

<div class="card card-pad not-wired" role="note" data-testid="portal-not-wired">
  <h3>Bereiche und Veröffentlichung noch nicht steuerbar</h3>
  <p>
    Welche Bereiche das öffentliche Portal zeigt, lässt sich hier noch nicht einstellen: das Portal
    wertet solche Einstellungen derzeit nicht aus. Deshalb gibt es hier keine Schalter.
  </p>
</div>

<style>
  .page-head {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: 20px; gap: 20px; flex-wrap: wrap;
  }
  .page-title { font-family: var(--font-display); font-size: 28px; font-weight: 500; letter-spacing: -0.015em; }
  .page-sub { color: var(--ink-muted); font-size: 13.5px; margin-top: 6px; }
  .head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .domain-card { margin-bottom: 20px; }
  .domain-val { font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .not-wired h3 { font-family: var(--font-display); font-size: 15px; font-weight: 600; }
  .not-wired p { margin-top: 6px; font-size: 13px; color: var(--ink-muted); max-width: 60ch; }
</style>
