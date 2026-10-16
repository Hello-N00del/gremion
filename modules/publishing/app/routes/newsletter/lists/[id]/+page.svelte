<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let csvFile = $state<File | null>(null)
  let manualEmail = $state('')
  let manualName = $state('')
  let importResult = $state('')
  let error = $state('')

  async function importCsv() {
    if (!csvFile) return
    const text = await csvFile.text()
    const res = await fetch(`/api/newsletter/lists/${data.list.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: text,
    })
    const json = await res.json()
    if (json.success) {
      importResult = `${json.data.imported} importiert, ${json.data.skipped} übersprungen.`
      csvFile = null
      await invalidateAll()
    } else {
      error = json.error ?? 'Fehler beim Import.'
    }
  }

  async function addManual() {
    if (!manualEmail.trim()) return
    const res = await fetch(`/api/newsletter/lists/${data.list.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: manualEmail.trim(), name: manualName.trim() || undefined }),
    })
    const json = await res.json()
    if (json.success) { manualEmail = ''; manualName = ''; await invalidateAll() }
    else error = json.error ?? 'Fehler beim Hinzufügen.'
  }

  async function removeMember(memberId: number) {
    const res = await fetch(`/api/newsletter/lists/${data.list.id}/members/${memberId}`, { method: 'DELETE' })
    if (res.ok) await invalidateAll()
  }
</script>

<div class="p-6 max-w-3xl mx-auto">
  <div class="flex items-center gap-3 mb-1">
    <a href="/newsletter/lists" class="text-sm text-ink-muted hover:underline">← Verteilerlisten</a>
  </div>
  <h1 class="text-2xl font-semibold mb-6">{data.list.name}</h1>

  {#if error}
    <div class="rounded-md border border-rust bg-rust-soft p-3 mb-4 text-sm text-rust-ink">{error}</div>
  {/if}
  {#if importResult}
    <div class="rounded-md border border-green-600 bg-green-50 p-3 mb-4 text-sm text-green-800">{importResult}</div>
  {/if}

  <div class="space-y-6">
    <!-- CSV Import -->
    <div class="rounded-md border p-4">
      <h2 class="font-medium mb-3">CSV importieren</h2>
      <p class="text-xs text-ink-muted mb-3">Format: erste Zeile als Header mit Spalten <code>email</code> und optional <code>name</code>.</p>
      <input type="file" accept=".csv,text/csv"
        onchange={(e) => { csvFile = (e.target as HTMLInputElement).files?.[0] ?? null }}
        class="text-sm mb-2" />
      <button onclick={importCsv} disabled={!csvFile} class="rounded-md bg-accent text-paper px-4 py-2 text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
        Importieren
      </button>
    </div>

    <!-- Manual add -->
    <div class="rounded-md border p-4">
      <h2 class="font-medium mb-3">Manuell hinzufügen</h2>
      <div class="flex gap-2">
        <input type="email" bind:value={manualEmail} placeholder="E-Mail" class="flex-1 rounded-md border px-3 py-2 text-sm" />
        <input type="text" bind:value={manualName} placeholder="Name (optional)" class="flex-1 rounded-md border px-3 py-2 text-sm" />
        <button onclick={addManual} class="rounded-md bg-accent text-paper px-4 py-2 text-sm font-medium hover:bg-accent/90">
          Hinzufügen
        </button>
      </div>
    </div>

    <!-- Member list -->
    <div>
      <h2 class="font-medium mb-3">{data.members.length} Mitglieder</h2>
      {#if data.members.length === 0}
        <p class="text-sm text-ink-muted">Noch keine Mitglieder.</p>
      {:else}
        <div class="rounded-md border divide-y">
          {#each data.members as member}
            <div class="flex items-center justify-between p-3 text-sm">
              <div>
                <span class="font-medium">{member.email}</span>
                {#if member.name}<span class="text-ink-muted ml-2">{member.name}</span>{/if}
                <span class="ml-2 text-xs text-ink-muted">({member.source})</span>
              </div>
              <button onclick={() => removeMember(member.id)} class="text-rust hover:underline text-xs">Entfernen</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
