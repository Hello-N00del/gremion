<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const fmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Berlin' })
  const ORIGIN: Record<string, string> = { panel: 'Betreiber-Oberfläche', host: 'Server-Notzugang' }
</script>

<PageTitle title="Zugriffsprotokoll des Betreibers" />

<div class="mx-auto max-w-5xl px-4 py-8 sm:px-8">
  <a href="/settings/datenschutz" class="text-sm text-ink-muted hover:underline">← Zurück zu den Einstellungen</a>
  <h1 class="mt-3 text-xl font-semibold">Zugriffsprotokoll des Betreibers</h1>
  <p class="mt-2 text-sm text-ink-muted">
    Jeder Zugriff des Betreibers oder von Personen, die für den Betreiber handeln, auf die Daten Ihres Gremiums wird
    festgehalten: wer, wann, was und warum. Die Einträge sind nicht veränderbar und werden mindestens so lange
    aufbewahrt wie die Sicherheitsprotokolle (derzeit 27 Tage); danach werden die ältesten Einträge gelöscht.
  </p>

  {#if data.problem}
    <p class="mt-6 rounded-md border border-line p-4 text-sm" role="alert">{data.problem}</p>
  {:else if data.records.length === 0}
    <p class="mt-6 text-sm text-ink-muted" data-testid="zugriffsprotokoll-leer">
      {data.paged
        ? 'Vor diesem Zeitpunkt ist im Aufbewahrungszeitraum kein weiterer Zugriff protokolliert.'
        : 'Im Aufbewahrungszeitraum wurde kein Zugriff des Betreibers auf Ihre Daten protokolliert.'}
    </p>
  {:else}
    {#if data.older || data.paged}
      <p class="mt-6 text-sm text-ink-muted" data-testid="zugriffsprotokoll-seite">
        Angezeigt werden {data.paged ? 'bis zu' : 'die neuesten'} {data.limit} Einträge{data.paged ? ' vor dem gewählten Zeitpunkt' : ''}.
      </p>
    {/if}
    <div class="mt-6 overflow-x-auto">
      <table class="w-full text-left text-sm" data-testid="zugriffsprotokoll">
        <thead>
          <tr class="border-b border-line">
            <th class="py-2 pr-4 font-medium">Wann</th>
            <th class="py-2 pr-4 font-medium">Wer</th>
            <th class="py-2 pr-4 font-medium">Über</th>
            <th class="py-2 pr-4 font-medium">Was</th>
            <th class="py-2 font-medium">Warum</th>
          </tr>
        </thead>
        <tbody>
          {#each data.records as r (r.id)}
            <tr class="border-b border-line align-top">
              <td class="py-2 pr-4 whitespace-nowrap">{fmt.format(new Date(r.at))}</td>
              <td class="py-2 pr-4 font-mono text-xs">{r.actor}</td>
              <td class="py-2 pr-4">{ORIGIN[r.origin] ?? r.origin}</td>
              <td class="py-2 pr-4">{r.what}</td>
              <td class="py-2">{r.why}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <nav class="mt-4 flex gap-4 text-sm" aria-label="Seiten des Zugriffsprotokolls">
      {#if data.paged}
        <a href="/settings/zugriffsprotokoll" class="hover:underline">Neueste Einträge</a>
      {/if}
      {#if data.older}
        <a href={`/settings/zugriffsprotokoll?before=${encodeURIComponent(data.older)}`} class="hover:underline" data-testid="zugriffsprotokoll-aeltere">Ältere Einträge</a>
      {/if}
    </nav>
  {/if}
</div>
