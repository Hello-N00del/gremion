<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'

  export let legal: { datenschutz_html: string; impressum_html: string; barrierefreiheit_html: string }

  let datenschutz = legal.datenschutz_html
  let impressum = legal.impressum_html
  let barrierefreiheit = legal.barrierefreiheit_html

  let saving = false
  let saved = false
  let error = ''

  async function save() {
    saving = true
    saved = false
    error = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legal: {
            datenschutz_html: datenschutz,
            impressum_html: impressum,
            barrierefreiheit_html: barrierefreiheit,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? 'Fehler beim Speichern.'
        return
      }
      saved = true
      setTimeout(() => { saved = false }, 3000)
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6 py-4">
  <h2 class="text-lg font-semibold">Rechtliches</h2>
  <p class="text-sm text-ink-muted">
    HTML-Inhalte für die Pflichtseiten. Vorschau über die Links unten.
  </p>

  <form class="space-y-5" on:submit|preventDefault={save}>
    <div class="space-y-1">
      <div class="flex items-center justify-between">
        <Label for="l-datenschutz">Datenschutzerklärung</Label>
        <a href="/legal/datenschutz" target="_blank" rel="noopener" class="text-xs text-accent hover:underline" aria-label="Datenschutzerklärung in neuem Tab öffnen">Vorschau →</a>
      </div>
      <textarea
        id="l-datenschutz"
        bind:value={datenschutz}
        rows={8}
        class="w-full rounded-md border bg-paper px-3 py-2 text-sm font-mono focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Datenschutzerklärung HTML"
        placeholder="<p>Datenschutzerklärung gemäß DSGVO Art. 13...</p>"
      ></textarea>
    </div>

    <div class="space-y-1">
      <div class="flex items-center justify-between">
        <Label for="l-impressum">Impressum</Label>
        <a href="/legal/impressum" target="_blank" rel="noopener" class="text-xs text-accent hover:underline" aria-label="Impressum in neuem Tab öffnen">Vorschau →</a>
      </div>
      <textarea
        id="l-impressum"
        bind:value={impressum}
        rows={6}
        class="w-full rounded-md border bg-paper px-3 py-2 text-sm font-mono focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Impressum HTML"
        placeholder="<p>Angaben gemäß TMG §5...</p>"
      ></textarea>
    </div>

    <div class="space-y-1">
      <div class="flex items-center justify-between">
        <Label for="l-barrierefreiheit">Barrierefreiheitserklärung</Label>
        <a href="/legal/barrierefreiheit" target="_blank" rel="noopener" class="text-xs text-accent hover:underline" aria-label="Barrierefreiheitserklärung in neuem Tab öffnen">Vorschau →</a>
      </div>
      <textarea
        id="l-barrierefreiheit"
        bind:value={barrierefreiheit}
        rows={6}
        class="w-full rounded-md border bg-paper px-3 py-2 text-sm font-mono focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Barrierefreiheitserklärung HTML"
        placeholder="<p>Barrierefreiheitserklärung gemäß BITV 2.0...</p>"
      ></textarea>
    </div>

    {#if error}
      <p class="text-sm text-rust" role="alert">{error}</p>
    {/if}

    <div class="flex items-center gap-3">
      <Button type="submit" disabled={saving}>{saving ? 'Speichere…' : 'Speichern'}</Button>
      {#if saved}
        <span class="text-sm text-green-600" role="status">Gespeichert ✓</span>
      {/if}
    </div>
  </form>
</div>
