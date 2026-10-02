<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Dialog, DialogHeader, DialogTitle } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { page } from '$app/state'
  import { resolveBrand } from '$lib/brand'

  let { data }: { data: PageData } = $props()
  let brand = $derived(resolveBrand(page.data.brand))

  // ── Quick Poll creation ──
  let pollDialogOpen = $state(false)
  let pollTitle = $state('')
  let pollDescription = $state('')
  let pollOptions: string[] = $state(['', ''])
  let pollAnonymous = $state(false)
  let pollExpireDays = $state(0)
  let pollSubmitting = $state(false)
  let pollError = $state('')
  let pollSuccess = $state('')

  function addOption() { pollOptions = [...pollOptions, ''] }
  function removeOption(i: number) {
    if (pollOptions.length <= 2) return
    pollOptions = pollOptions.filter((_, idx) => idx !== i)
  }
  function updateOption(i: number, value: string) {
    pollOptions = pollOptions.map((o, idx) => idx === i ? value : o)
  }

  async function createPoll() {
    pollSubmitting = true
    pollError = ''
    pollSuccess = ''

    const expireTs = pollExpireDays > 0
      ? Math.floor(Date.now() / 1000) + pollExpireDays * 86400
      : undefined

    try {
      const res = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pollTitle,
          type: 'textPoll',
          options: pollOptions.filter(Boolean),
          anonymous: pollAnonymous,
          description: pollDescription || undefined,
          expire: expireTs,
        }),
      })

      if (!res.ok) {
        const body = await res.json()
        pollError = body.error ?? 'Fehler beim Erstellen.'
      } else {
        pollSuccess = 'Umfrage wurde erstellt.'
        pollDialogOpen = false
        pollTitle = ''
        pollDescription = ''
        pollOptions = ['', '']
        pollAnonymous = false
        pollExpireDays = 0
      }
    } catch {
      pollError = 'Verbindungsfehler.'
    } finally {
      pollSubmitting = false
    }
  }

  // ── Voter email export ──
  function downloadVoterEmails() {
    const link = document.createElement('a')
    link.href = '/api/users?export=email'
    link.download = 'voters.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // ── Tracked election UUIDs ──
  let trackedUuids = $state([...data.trackedUuids])
  let newUuid = $state('')
  let uuidError = $state('')
  let uuidSaving = $state(false)

  async function addTrackedUuid() {
    const trimmed = newUuid.trim()
    if (!trimmed || trackedUuids.includes(trimmed)) {
      uuidError = trimmed ? 'UUID bereits vorhanden.' : 'Bitte UUID eingeben.'
      return
    }
    uuidError = ''
    uuidSaving = true
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elections: { tracked_uuids: [...trackedUuids, trimmed] } }),
      })
      if (res.ok) {
        trackedUuids = [...trackedUuids, trimmed]
        newUuid = ''
      } else {
        uuidError = 'Fehler beim Speichern.'
      }
    } catch {
      uuidError = 'Verbindungsfehler.'
    } finally {
      uuidSaving = false
    }
  }

  async function removeTrackedUuid(uuid: string) {
    uuidSaving = true
    try {
      const updated = trackedUuids.filter((u) => u !== uuid)
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elections: { tracked_uuids: updated } }),
      })
      if (res.ok) {
        trackedUuids = updated
      }
    } finally {
      uuidSaving = false
    }
  }
</script>

<PageTitle title="Wahlen verwalten" />

<div class="mx-auto max-w-3xl space-y-8 p-6">
  <div class="flex items-center gap-3">
    <a href="/elections" class="text-sm text-ink-muted hover:underline">← Abstimmungen</a>
  </div>

  <h1 class="text-2xl font-bold">Wahlen & Abstimmungen verwalten</h1>

  {#if pollSuccess}
    <Alert>{pollSuccess}</Alert>
  {/if}

  <!-- Quick Poll section -->
  <div class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0">
      <span class="text-lg font-semibold">Schnellumfrage erstellen</span>
      <p class="text-sm text-ink-muted mt-1">Erstellt eine Nextcloud-Umfrage, an der alle Mitglieder teilnehmen können.</p>
    </div>
    <div class="p-6">
      <Button onclick={() => { pollDialogOpen = true }}>Neue Umfrage erstellen</Button>
    </div>
  </div>

  <Dialog open={pollDialogOpen} onClose={() => { pollDialogOpen = false }}>
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div onkeydown={(e: KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation() }}>
      <DialogHeader>
        <DialogTitle>Neue Umfrage</DialogTitle>
      </DialogHeader>
      <form class="space-y-4 mt-4" onsubmit={(e) => { e.preventDefault(); createPoll() }}>
        <div class="space-y-1">
          <Label for="poll-title">Titel *</Label>
          <Input id="poll-title" bind:value={pollTitle} required maxlength={200} />
        </div>
        <div class="space-y-1">
          <Label for="poll-desc">Beschreibung</Label>
          <Input id="poll-desc" bind:value={pollDescription} maxlength={1000} />
        </div>
        <div class="space-y-2">
          <Label>Optionen *</Label>
          {#each pollOptions as option, i}
            <div class="flex gap-2">
              <Input
                value={option}
                oninput={(e: Event) => updateOption(i, (e.target as HTMLInputElement).value)}
                placeholder="Option {i + 1}"
                required
              />
              <Button type="button" variant="ghost" size="sm"
                onclick={() => removeOption(i)}
                disabled={pollOptions.length <= 2}
                aria-label="Option entfernen"
              >✕</Button>
            </div>
          {/each}
          <Button type="button" variant="outline" size="sm" onclick={addOption}>+ Option hinzufügen</Button>
        </div>
        <div class="flex items-center gap-2">
          <input type="checkbox" id="poll-anon" bind:checked={pollAnonymous} class="h-4 w-4" />
          <Label for="poll-anon">Anonyme Abstimmung</Label>
        </div>
        <div class="space-y-1">
          <Label for="poll-expire">Läuft ab in (Tagen, 0 = kein Ablauf)</Label>
          <Input id="poll-expire" type="number" min={0} max={365} bind:value={pollExpireDays} />
        </div>
        {#if pollError}
          <p class="text-sm text-rust">{pollError}</p>
        {/if}
        <Button type="submit" disabled={pollSubmitting} class="w-full">
          {pollSubmitting ? 'Erstelle…' : 'Umfrage erstellen'}
        </Button>
      </form>
    </div>
  </Dialog>

  <!-- Secret election section -->
  <div class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0">
      <span class="text-lg font-semibold">Geheime Wahl (Helios)</span>
      <p class="text-sm text-ink-muted mt-1">
        Geheime Wahlen werden in Helios Voting erstellt und verwaltet. {brand.product} verlinkt Mitglieder zur Helios-Wahlseite.
      </p>
    </div>
    <div class="p-6 space-y-4">
      <div class="flex flex-wrap gap-3">
        <Button href={data.heliosAdminUrl} target="_blank" rel="noopener noreferrer" variant="outline">
          Wahl in Helios erstellen →
        </Button>
        <Button variant="outline" onclick={downloadVoterEmails}>
          Wähler-E-Mails exportieren (.csv)
        </Button>
      </div>
      <p class="text-xs text-ink-muted">
        Die CSV-Datei enthält alle aktiven Mitglieds-E-Mail-Adressen und kann direkt in Helios als Wählerliste importiert werden.
      </p>
    </div>
  </div>

  <!-- Tracked election UUIDs -->
  <div class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0">
      <span class="text-lg font-semibold">Verfolgte Wahlen (UUID-Liste)</span>
      <p class="text-sm text-ink-muted mt-1">
        Füge Helios-Wahl-UUIDs hinzu, damit sie auf der Abstimmungsseite angezeigt werden.
      </p>
    </div>
    <div class="p-6 space-y-4">
      {#if trackedUuids.length > 0}
        <ul class="space-y-2" role="list">
          {#each trackedUuids as uuid (uuid)}
            <li class="flex items-center justify-between gap-2 rounded border px-3 py-2">
              <code class="text-xs font-mono">{uuid}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={uuidSaving}
                onclick={() => removeTrackedUuid(uuid)}
                aria-label="UUID entfernen"
              >Entfernen</Button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-ink-muted">Keine Wahlen verfolgt.</p>
      {/if}

      <div class="flex gap-2">
        <Input
          bind:value={newUuid}
          placeholder="Helios UUID (z.B. abc-123-...)"
          aria-label="Helios Wahl-UUID"
          onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addTrackedUuid() } }}
        />
        <Button type="button" onclick={addTrackedUuid} disabled={uuidSaving}>Hinzufügen</Button>
      </div>
      {#if uuidError}
        <p class="text-sm text-rust">{uuidError}</p>
      {/if}
    </div>
  </div>
</div>
