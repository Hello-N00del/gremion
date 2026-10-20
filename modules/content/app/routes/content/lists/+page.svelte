<script lang="ts">
  // Content Engine — mailing lists (PLAIN, the designer polishes later).
  // List + create content mailing lists; click through to manage members.
  import { invalidateAll } from '$app/navigation'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let newListName = $state('')
  let error = $state('')

  async function createList() {
    if (!newListName.trim()) return
    error = ''
    const res = await fetch('/api/content/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newListName.trim() }),
    })
    if (res.ok) {
      newListName = ''
      await invalidateAll()
    } else {
      error = 'Liste konnte nicht erstellt werden.'
    }
  }

  async function deleteList(id: string) {
    if (!confirm('Verteilerliste wirklich löschen?')) return
    error = ''
    const res = await fetch(`/api/content/lists/${id}`, { method: 'DELETE' })
    if (res.ok) await invalidateAll()
    else error = 'Liste konnte nicht gelöscht werden.'
  }
</script>

<PageTitle title="Verteilerlisten" />

<div class="topbar">
  <a class="back" href="/content">← Inhalte</a>
</div>

<h1 class="h1">Verteilerlisten</h1>
<p class="muted">E-Mail-Empfängerlisten für die Inhalte-Veröffentlichung.</p>

{#if error}
  <p class="err">{error}</p>
{/if}

<div class="create">
  <input type="text" bind:value={newListName} placeholder="Name der neuen Liste" />
  <button onclick={createList}>Erstellen</button>
</div>

{#if data.lists.length === 0}
  <p class="muted">Noch keine Verteilerlisten.</p>
{:else}
  <div class="rows">
    {#each data.lists as list (list.id)}
      <div class="row">
        <a class="name" href="/content/lists/{list.id}">{list.name}</a>
        <button class="del" onclick={() => deleteList(list.id)}>Löschen</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .topbar { margin-bottom: 16px; }
  .back { font-size: 13px; color: var(--ink-muted, #666); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  .muted { color: var(--ink-muted, #888); font-size: 13px; }
  .err { font-size: 13px; padding: 8px 12px; border-radius: 6px; background: var(--rust-soft, #fde8e8); color: var(--rust-ink, #b00); border: 1px solid var(--rust, #e0a0a0); margin: 12px 0; }
  .create { display: flex; gap: 8px; margin: 18px 0; max-width: 520px; }
  .create input { flex: 1; padding: 8px 11px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 14px; background: var(--surface, #fff); color: inherit; }
  .create button, .del { cursor: pointer; }
  .create button { padding: 8px 16px; border: 1px solid var(--accent, #345); border-radius: 6px; background: var(--accent, #345); color: var(--paper, #fff); font-size: 14px; }
  .rows { border: 1px solid var(--border, #ddd); border-radius: 8px; overflow: hidden; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border, #eee); }
  .row:last-child { border-bottom: 0; }
  .name { font-size: 14px; font-weight: 500; text-decoration: none; color: inherit; }
  .name:hover { text-decoration: underline; }
  .del { background: none; border: 0; font-size: 13px; color: var(--rust-ink, #b00); }
  .del:hover { text-decoration: underline; }
</style>
