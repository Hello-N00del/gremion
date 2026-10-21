<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let scheduledAt = $state('')
  $effect(() => { scheduledAt = data.newsletter.scheduled_at ?? '' })
  let error = $state('')
  let success = $state('')

  async function scheduleNewsletter() {
    error = ''
    success = ''
    if (!scheduledAt) { error = 'Bitte einen Sendezeitpunkt auswählen.'; return }
    try {
      const res = await fetch(`/api/newsletter/${data.newsletter.id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_at: new Date(scheduledAt).toISOString() }),
      })
      const json = await res.json()
      if (json.success) { success = 'Newsletter geplant.'; await invalidateAll() }
      else error = json.error ?? 'Fehler beim Planen.'
    } catch {
      error = 'Netzwerkfehler. Bitte erneut versuchen.'
    }
  }

  async function sendNow() {
    error = ''
    success = ''
    try {
      const res = await fetch(`/api/newsletter/${data.newsletter.id}/send-now`, { method: 'POST' })
      const json = await res.json()
      if (json.success) { success = 'Versand gestartet. Status wird aktualisiert.'; await invalidateAll() }
      else error = json.error ?? 'Fehler beim Senden.'
    } catch {
      error = 'Netzwerkfehler. Bitte erneut versuchen.'
    }
  }
</script>

<div class="p-6 max-w-3xl mx-auto">
  <div class="flex items-center gap-3 mb-1">
    <a href="/newsletter" class="text-sm text-ink-muted hover:underline">← Newsletter</a>
  </div>
  <h1 class="text-2xl font-semibold mb-1">{data.newsletter.title}</h1>
  <p class="text-sm text-ink-muted mb-6">Status: <strong>{data.newsletter.status}</strong></p>

  {#if error}
    <div class="rounded-md border border-rust bg-rust-soft p-3 mb-4 text-sm text-rust-ink">{error}</div>
  {/if}
  {#if success}
    <div class="rounded-md border border-green-600 bg-green-50 p-3 mb-4 text-sm text-green-800">{success}</div>
  {/if}
  {#if data.newsletter.error}
    <div class="rounded-md border border-rust bg-rust-soft p-3 mb-4 text-sm text-rust-ink">
      Fehler beim letzten Versuch: {data.newsletter.error}
    </div>
  {/if}

  <div class="space-y-6">
    <div class="flex gap-3">
      <a href="/newsletter/{data.newsletter.id}/preview" target="_blank" class="rounded-md border px-4 py-2 text-sm font-medium hover:bg-surface-2">
        Vorschau
      </a>
    </div>

    {#if data.wopiToken}
      <iframe
        src="{data.wopiToken.editorUrl}&lang=de&closebutton=1"
        title="Newsletter bearbeiten"
        class="w-full h-[500px] rounded-md border"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
      ></iframe>
    {/if}

    {#if !['sent', 'sending'].includes(data.newsletter.status)}
      <div class="rounded-md border p-4 space-y-3">
        <h2 class="font-medium">Versand planen</h2>
        <input type="datetime-local" bind:value={scheduledAt} class="rounded-md border px-3 py-2 text-sm" />
        <div class="flex gap-3">
          <button onclick={scheduleNewsletter} class="rounded-md bg-accent text-paper px-4 py-2 text-sm font-medium hover:bg-accent/90">
            Planen
          </button>
          <button onclick={sendNow} class="rounded-md border px-4 py-2 text-sm font-medium hover:bg-surface-2">
            Jetzt senden
          </button>
        </div>
      </div>
    {:else if data.newsletter.status === 'sent'}
      <p class="text-sm text-ink-muted">Gesendet am {new Date(data.newsletter.sent_at!).toLocaleString('de-DE')}</p>
    {/if}
  </div>
</div>
