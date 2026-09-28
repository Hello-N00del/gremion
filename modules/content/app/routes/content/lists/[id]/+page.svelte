<script lang="ts">
  // Content Engine — manage one mailing list's members (PLAIN). Manual add
  // (email + optional name) and remove. CSV import is L2-stretch; out of scope.
  import { invalidateAll } from '$app/navigation'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let email = $state('')
  let name = $state('')
  let error = $state('')

  async function addMember() {
    if (!email.trim()) return
    error = ''
    const res = await fetch(`/api/content/lists/${data.list.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined }),
    })
    if (res.ok) {
      email = ''
      name = ''
      await invalidateAll()
    } else {
      error = 'Mitglied konnte nicht hinzugefügt werden (gültige E-Mail nötig).'
    }
  }

  async function removeMember(memberId: string) {
    error = ''
    const res = await fetch(`/api/content/lists/${data.list.id}/members/${memberId}`, {
      method: 'DELETE',
    })
    if (res.ok) await invalidateAll()
    else error = 'Mitglied konnte nicht entfernt werden.'
  }
</script>

<PageTitle title={data.list.name} />

<div class="topbar">
  <a class="back" href="/content/lists">← Verteilerlisten</a>
</div>

<h1 class="h1">{data.list.name}</h1>

{#if error}
  <p class="err">{error}</p>
{/if}

<div class="add">
  <input type="email" bind:value={email} placeholder="E-Mail" />
  <input type="text" bind:value={name} placeholder="Name (optional)" />
  <button onclick={addMember}>Hinzufügen</button>
</div>

<h2 class="h2">{data.members.length} Mitglieder</h2>

{#if data.members.length === 0}
  <p class="muted">Noch keine Mitglieder.</p>
{:else}
  <div class="rows">
    {#each data.members as m (m.id)}
      <div class="row">
        <div>
          <span class="email">{m.email}</span>
          {#if m.name}<span class="mname">{m.name}</span>{/if}
          <span class="src">({m.source})</span>
        </div>
        <button class="del" onclick={() => removeMember(m.id)}>Entfernen</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .topbar { margin-bottom: 16px; }
  .back { font-size: 13px; color: var(--ink-muted, #666); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .h1 { font-size: 22px; font-weight: 600; margin: 0 0 16px; }
  .h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); margin: 24px 0 12px; }
  .muted { color: var(--ink-muted, #888); font-size: 13px; }
  .err { font-size: 13px; padding: 8px 12px; border-radius: 6px; background: var(--rust-soft, #fde8e8); color: var(--rust-ink, #b00); border: 1px solid var(--rust, #e0a0a0); margin: 12px 0; }
  .add { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
  .add input { flex: 1; min-width: 160px; padding: 8px 11px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 14px; background: var(--surface, #fff); color: inherit; }
  .add button { padding: 8px 16px; border: 1px solid var(--accent, #345); border-radius: 6px; background: var(--accent, #345); color: var(--paper, #fff); font-size: 14px; cursor: pointer; }
  .rows { border: 1px solid var(--border, #ddd); border-radius: 8px; overflow: hidden; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border, #eee); font-size: 14px; }
  .row:last-child { border-bottom: 0; }
  .email { font-weight: 500; }
  .mname { color: var(--ink-muted, #888); margin-left: 8px; }
  .src { color: var(--ink-muted, #aaa); font-size: 12px; margin-left: 8px; }
  .del { background: none; border: 0; font-size: 13px; color: var(--rust-ink, #b00); cursor: pointer; }
  .del:hover { text-decoration: underline; }
</style>
