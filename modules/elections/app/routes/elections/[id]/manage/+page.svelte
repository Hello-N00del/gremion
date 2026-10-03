<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { enhance } from '$app/forms'
  import { Alert } from '$lib/components/ui/alert'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data }: { data: PageData } = $props()
  const e = $derived(data.election)

  let freezeDialogOpen = $state(false)
  let freezing = $state(false)
  let freezeError = $state('')

  function formatDateTime(iso: string | null): string {
    if (!iso) return '–'
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }
</script>

<PageTitle title={`${e.name} verwalten`} />

<div class="mx-auto max-w-4xl space-y-6 p-6">
  <div class="flex items-center gap-3">
    <a href="/elections/{e.uuid}" class="text-sm text-ink-muted hover:underline">← {e.name}</a>
  </div>

  <!-- Header -->
  <div class="rounded-lg border bg-surface p-6">
    <div class="flex items-start justify-between gap-2">
      <div>
        <h1 class="text-xl font-semibold">{e.name}</h1>
        <p class="text-sm text-ink-muted">Entwurf — Kurzname: <code>{e.shortName}</code></p>
      </div>
      <Pill tone="neutral" icon="edit">Entwurf</Pill>
    </div>
    <div class="mt-4 grid grid-cols-2 gap-2 text-sm">
      <div><span class="text-ink-muted">Start:</span> {formatDateTime(e.votingStartsAt)}</div>
      <div><span class="text-ink-muted">Ende:</span> {formatDateTime(e.votingEndsAt)}</div>
    </div>
  </div>

  <!-- Voter list -->
  <section aria-labelledby="voters-heading" class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0 flex items-center justify-between">
      <h2 id="voters-heading" class="text-lg font-semibold">Wählerverzeichnis</h2>
      <span class="text-sm text-ink-muted">{data.voters.length} Wähler</span>
    </div>
    <div class="p-6">
      {#if data.voters.length === 0}
        <Alert>
          Noch keine Wähler eingetragen. Das Wählerverzeichnis wird beim Anlegen der Wahl aus den Gremiumsmitgliedern befüllt.
        </Alert>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b text-left">
              <tr>
                <th class="py-2 pr-4 font-medium">Name</th>
                <th class="py-2 font-medium">Login-ID</th>
              </tr>
            </thead>
            <tbody>
              {#each data.voters as v (v.uuid)}
                <tr class="border-b last:border-0">
                  <td class="py-2 pr-4">{v.name}</td>
                  <td class="py-2 font-mono text-xs text-ink-muted">{v.voter_login_id ?? '–'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </section>

  <!-- Freeze action -->
  <section class="rounded-lg border border-rust/40 bg-surface p-6">
    <h2 class="text-lg font-semibold mb-1">Wahl einfrieren & öffnen</h2>
    <p class="text-sm text-ink-muted mb-4">
      Dieser Schritt ist <strong>unwiderruflich</strong>. Nach dem Einfrieren können keine Wähler mehr
      geändert werden und die Abstimmung beginnt sofort.
    </p>

    {#if freezeError}
      <Alert class="mb-4">{freezeError}</Alert>
    {/if}

    {#if !freezeDialogOpen}
      <Button
        variant="destructive"
        onclick={() => { freezeDialogOpen = true }}
      >
        Einfrieren & öffnen
      </Button>
    {:else}
      <div class="rounded-lg border border-rust/40 bg-rust-soft p-4 space-y-3">
        <p class="text-sm font-medium">Bist du sicher? Diese Aktion kann nicht rückgängig gemacht werden.</p>
        <div class="flex gap-2">
          <form
            method="POST"
            action="?/freeze"
            use:enhance={() => {
              freezing = true
              freezeError = ''
              return async ({ result, update }) => {
                freezing = false
                if (result.type === 'failure') {
                  freezeError = (result.data as { error?: string })?.error ?? 'Unbekannter Fehler'
                  freezeDialogOpen = false
                } else {
                  await update()
                }
              }
            }}
          >
            <Button type="submit" variant="destructive" disabled={freezing}>
              {freezing ? 'Wird eingefroren…' : 'Ja, einfrieren'}
            </Button>
          </form>
          <Button variant="outline" onclick={() => { freezeDialogOpen = false }}>Abbrechen</Button>
        </div>
      </div>
    {/if}
  </section>
</div>
