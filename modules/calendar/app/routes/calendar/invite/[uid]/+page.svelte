<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Button } from '$lib/components/ui/button'

  let { data }: { data: PageData } = $props()

  const ev = $derived(data.event)

  function fmt(d: Date | string): string {
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Europe/Berlin'
    }).format(typeof d === 'string' ? new Date(d) : d)
  }

  const emailText = $derived(`Einladung: ${ev.summary}
Datum: ${fmt(ev.dtstart)}${ev.location ? '\nOrt: ' + ev.location : ''}${ev.description ? '\nBeschreibung: ' + ev.description : ''}

Bitte lege den beigefügten Termin (.ics-Datei) in deinem Kalender ab.`)

  function copyEmail() {
    navigator.clipboard.writeText(emailText)
  }

  function downloadIcs() {
    const blob = new Blob([ev.icsData], { type: 'text/calendar' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ev.summary}.ics`
    a.click()
    URL.revokeObjectURL(url)
  }
</script>

<PageTitle title={`${ev.summary} – Einladung`} />

<div class="space-y-6 max-w-lg">
  <div>
    <a href="/calendar" class="text-sm text-ink-muted hover:underline">← Zurück zum Kalender</a>
    <h1 class="mt-2 text-2xl font-bold">{ev.summary}</h1>
  </div>

  <div class="rounded-lg border p-4 space-y-2 text-sm">
    <div><span class="font-medium">Beginn:</span> {fmt(ev.dtstart)}</div>
    <div><span class="font-medium">Ende:</span> {fmt(ev.dtend)}</div>
    {#if ev.location}<div><span class="font-medium">Ort:</span> {ev.location}</div>{/if}
    {#if ev.description}<div><span class="font-medium">Beschreibung:</span> {ev.description}</div>{/if}
  </div>

  <div class="space-y-2">
    <p class="text-sm font-medium">E-Mail-Vorlage:</p>
    <textarea
      readonly
      class="w-full rounded-md border bg-surface-2 p-3 text-sm font-mono resize-none"
      rows={6}
      value={emailText}
    ></textarea>
    <div class="flex gap-2">
      <Button variant="outline" onclick={copyEmail}>Kopieren</Button>
      <Button onclick={downloadIcs}>Kalender-Datei herunterladen (.ics)</Button>
    </div>
  </div>
</div>
