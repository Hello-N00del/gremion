<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let newListName = $state('')
  let error = $state('')

  async function createList() {
    if (!newListName.trim()) return
    const res = await fetch('/api/newsletter/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newListName.trim() }),
    })
    const json = await res.json()
    if (json.success) { newListName = ''; await invalidateAll() }
    else error = json.error ?? 'Fehler beim Erstellen.'
  }

  async function deleteList(id: number) {
    if (!confirm('Verteilerliste wirklich löschen?')) return
    error = ''
    const res = await fetch(`/api/newsletter/lists/${id}`, { method: 'DELETE' })
    if (res.ok) await invalidateAll()
    else error = 'Liste konnte nicht gelöscht werden.'
  }
</script>

<div class="p-6 max-w-3xl mx-auto">
  <div class="flex items-center gap-3 mb-1">
    <a href="/newsletter" class="text-sm text-ink-muted hover:underline">← Newsletter</a>
  </div>
  <h1 class="text-2xl font-semibold mb-6">Verteilerlisten</h1>

  {#if error}
    <div class="rounded-md border border-rust bg-rust-soft p-3 mb-4 text-sm text-rust-ink">{error}</div>
  {/if}

  <div class="flex gap-2 mb-6">
    <input type="text" bind:value={newListName} placeholder="Name der neuen Liste" class="flex-1 rounded-md border px-3 py-2 text-sm" />
    <button onclick={createList} class="rounded-md bg-accent text-paper px-4 py-2 text-sm font-medium hover:bg-accent/90">
      Erstellen
    </button>
  </div>

  {#if data.lists.length === 0}
    <p class="text-ink-muted text-sm">Noch keine Verteilerlisten vorhanden.</p>
  {:else}
    <div class="rounded-md border divide-y">
      {#each data.lists as list}
        <div class="flex items-center justify-between p-3">
          <a href="/newsletter/lists/{list.id}" class="font-medium text-sm hover:underline">{list.name}</a>
          <button onclick={() => deleteList(list.id)} class="text-sm text-rust hover:underline">Löschen</button>
        </div>
      {/each}
    </div>
  {/if}
</div>
