<script lang="ts">
  import { goto } from '$app/navigation'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let title = $state('')
  let subject = $state('')
  let selectedListIds = $state<number[]>([])
  let error = $state('')
  let loading = $state(false)

  async function submit() {
    if (!title.trim() || !subject.trim()) {
      error = 'Titel und Betreff sind erforderlich.'
      return
    }
    loading = true
    error = ''
    try {
      const res = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          subject: subject.trim(),
          recipients: selectedListIds.map((id) => ({ mailing_list_id: id })),
        }),
      })
      const json = await res.json()
      if (!json.success) {
        error = json.error ?? 'Fehler beim Erstellen.'
        return
      }
      goto(`/newsletter/${json.data.id}`)
    } catch {
      error = 'Netzwerkfehler. Bitte versuche es erneut.'
    } finally {
      loading = false
    }
  }
</script>

<div class="p-6 max-w-xl mx-auto">
  <h1 class="text-2xl font-semibold mb-6">Neuer Newsletter</h1>

  {#if error}
    <div class="rounded-md border border-rust bg-rust-soft p-3 mb-4 text-sm text-rust-ink">{error}</div>
  {/if}

  <div class="space-y-4">
    <div>
      <label for="title" class="block text-sm font-medium mb-1">Titel (intern)</label>
      <input id="title" type="text" bind:value={title} class="w-full rounded-md border px-3 py-2 text-sm" placeholder="z.B. Ausgabe Mai 2026" />
    </div>

    <div>
      <label for="subject" class="block text-sm font-medium mb-1">E-Mail-Betreff</label>
      <input id="subject" type="text" bind:value={subject} class="w-full rounded-md border px-3 py-2 text-sm" placeholder="z.B. Neuigkeiten vom StuRa" />
    </div>

    <div>
      <p class="text-sm font-medium mb-2">Verteilerlisten</p>
      {#each data.lists as list}
        <label class="flex items-center gap-2 text-sm mb-1">
          <input
            type="checkbox"
            value={list.id}
            checked={selectedListIds.includes(list.id)}
            onchange={(e) => {
              if ((e.target as HTMLInputElement).checked) {
                selectedListIds = [...selectedListIds, list.id]
              } else {
                selectedListIds = selectedListIds.filter((id) => id !== list.id)
              }
            }}
          />
          {list.name}
        </label>
      {/each}
      {#if data.lists.length === 0}
        <p class="text-sm text-ink-muted">Keine Verteilerlisten vorhanden. <a href="/newsletter/lists" class="text-accent hover:underline">Jetzt erstellen →</a></p>
      {/if}
    </div>

    <button
      onclick={submit}
      disabled={loading}
      class="w-full rounded-md bg-accent text-paper px-4 py-2 text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
    >
      {loading ? 'Wird erstellt…' : 'Newsletter erstellen & bearbeiten'}
    </button>
  </div>
</div>
