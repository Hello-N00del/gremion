<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Alert } from '$lib/components/ui/alert'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { Button } from '$lib/components/ui/button'
  import { voteCount } from '$lib/components/polls/count'
  import { goto, invalidateAll } from '$app/navigation'

  let { data }: { data: PageData } = $props()

  let selectedOptionId = $state<number | null>(null)
  let submitting = $state(false)
  let voted = $state(data.poll.currentUserStatus.countVotes > 0)
  let errorMsg = $state('')
  // Shown next to the options when "Abstimmen" is pressed with nothing chosen.
  let choiceMsg = $state('')

  let poll = $derived(data.poll)
  let canManage = $derived(data.canManage === true)
  // Which of the two management actions waits for its confirmation, and the one that is running.
  let confirming = $state<'close' | 'delete' | null>(null)
  let managing = $state(false)
  let manageMsg = $state('')
  let isLocked = $derived(poll.status.expired || poll.currentUserStatus.isLocked || voted)

  async function manage(action: 'close' | 'delete') {
    managing = true
    manageMsg = ''
    try {
      const res =
        action === 'close'
          ? await fetch(`/api/polls/${poll.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ closed: true }),
            })
          : await fetch(`/api/polls/${poll.id}`, { method: 'DELETE' })
      if (res.ok) {
        confirming = null
        if (action === 'delete') await goto('/votes', { invalidateAll: true })
        else await invalidateAll()
        return
      }
      const what = action === 'close' ? 'beendet' : 'gelöscht'
      manageMsg =
        action === 'delete' && res.status === 409
          ? 'Die Umfrage gehört zu einem Protokoll und kann nicht gelöscht werden.'
          : res.status === 403
            ? `Dafür fehlt die Berechtigung. Die Umfrage wurde nicht ${what}.`
            : res.status === 404
              ? `Die Umfrage gibt es nicht mehr. Bitte lade die Seite neu.`
              : `Die Umfrage wurde nicht ${what}. Bitte erneut versuchen.`
    } catch {
      manageMsg = `Verbindungsfehler. Die Umfrage wurde nicht ${action === 'close' ? 'beendet' : 'gelöscht'}.`
    } finally {
      managing = false
    }
  }

  async function submitVote() {
    if (isLocked) return
    if (selectedOptionId === null) {
      choiceMsg = 'Bitte wähle eine Option aus.'
      return
    }
    submitting = true
    errorMsg = ''

    try {
      const res = await fetch(`/api/polls/${poll.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: selectedOptionId }),
      })
      if (!res.ok) {
        const body = await res.json()
        errorMsg = body.error ?? 'Fehler beim Abstimmen.'
      } else {
        voted = true
        // Reload to get updated tallies
        window.location.reload()
      }
    } catch {
      errorMsg = 'Verbindungsfehler. Bitte erneut versuchen.'
    } finally {
      submitting = false
    }
  }
</script>

<PageTitle title={poll.configuration.title} />

<div class="mx-auto max-w-2xl space-y-6 p-6">
  <div class="flex items-center gap-3">
    <a href="/votes" class="text-sm text-ink-muted hover:underline">← Abstimmungen</a>
  </div>

  <div class="rounded-lg border border-border bg-surface">
    <!-- Padding is inline on purpose: this page is copied into the app from the module, and the
         stylesheet scan skips that copy, so px-6/pb-0 were never generated and the title sat on
         the card border. -->
    <div data-testid="poll-card-head" style="padding: 1.5rem 1.5rem 0">
      <div class="flex items-start justify-between gap-2">
        <span class="text-lg font-semibold">{poll.configuration.title}</span>
        <div class="flex gap-1 shrink-0">
          {#if poll.status.expired}
            <Pill tone="neutral" icon="clock">Abgelaufen</Pill>
          {:else if voted}
            <Pill tone="success">Abgestimmt</Pill>
          {:else}
            <Pill tone="warn">Offen</Pill>
          {/if}
          {#if poll.configuration.anonymous}
            <Pill>Anonym</Pill>
          {/if}
        </div>
      </div>
      {#if poll.configuration.description}
        <p class="text-sm text-ink-muted mt-1">{poll.configuration.description}</p>
      {/if}
    </div>

    <div class="space-y-4" style="padding: 1.5rem">
      {#if errorMsg}
        <Alert variant="destructive">{errorMsg}</Alert>
      {/if}

      <fieldset
        disabled={isLocked}
        aria-describedby={choiceMsg ? 'poll-choice-msg' : undefined}
      >
        <legend class="sr-only">Abstimmungsoptionen</legend>
        <ul class="space-y-2" role="list">
          {#each poll.options ?? [] as option (option.id)}
            <li>
              <label
                class="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-surface-2/50 has-checked:border-accent has-checked:bg-accent/5 transition-colors"
                class:opacity-60={isLocked}
              >
                <input
                  type="radio"
                  name="vote"
                  value={option.id}
                  bind:group={selectedOptionId}
                  disabled={isLocked}
                  aria-labelledby={`poll-option-${option.id}`}
                  onchange={() => (choiceMsg = '')}
                  class="h-4 w-4 accent-accent"
                />
                <span id={`poll-option-${option.id}`} class="flex-1 text-sm">{option.text}</span>
                {#if voted}
                  <span class="text-sm text-ink-muted">{voteCount(option.votes.count)}</span>
                {/if}
              </label>
            </li>
          {/each}
        </ul>
        {#if choiceMsg}
          <p id="poll-choice-msg" role="alert" class="mt-2 text-sm text-rust">{choiceMsg}</p>
        {/if}
      </fieldset>

      {#if !isLocked}
        <Button
          onclick={submitVote}
          disabled={submitting}
          class="w-full"
        >
          {submitting ? 'Wird abgestimmt…' : 'Abstimmen'}
        </Button>
      {:else if poll.status.expired}
        <p class="text-sm text-center text-ink-muted">Diese Umfrage ist abgelaufen.</p>
      {:else if voted}
        <p class="text-sm text-center text-ink-muted">Du hast bereits abgestimmt.</p>
      {/if}

      {#if canManage}
        <div data-testid="poll-manage" style="border-top: 1px solid var(--border); padding-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem">
          {#if manageMsg}
            <Alert variant="destructive">{manageMsg}</Alert>
          {/if}
          {#if confirming === 'close'}
            <p class="text-sm text-ink-muted">Die Umfrage wird beendet. Danach werden keine Stimmen mehr abgegeben, die Ergebnisse bleiben sichtbar.</p>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap">
              <Button size="sm" disabled={managing} onclick={() => manage('close')}>Jetzt beenden</Button>
              <Button size="sm" variant="outline" onclick={() => (confirming = null)}>Abbrechen</Button>
            </div>
          {:else if confirming === 'delete'}
            <p class="text-sm text-ink-muted">Die Umfrage wird mit allen Stimmen endgültig gelöscht. Das lässt sich nicht rückgängig machen.</p>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap">
              <Button size="sm" variant="destructive" disabled={managing} onclick={() => manage('delete')}>Endgültig löschen</Button>
              <Button size="sm" variant="outline" onclick={() => (confirming = null)}>Abbrechen</Button>
            </div>
          {:else}
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap">
              {#if !poll.status.expired}
                <Button size="sm" variant="outline" onclick={() => (confirming = 'close')}>Umfrage beenden</Button>
              {/if}
              <Button size="sm" variant="outline" onclick={() => (confirming = 'delete')}>Umfrage löschen</Button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
