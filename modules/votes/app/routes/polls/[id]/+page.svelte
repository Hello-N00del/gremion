<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Alert } from '$lib/components/ui/alert'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data }: { data: PageData } = $props()

  let selectedOptionId = $state<number | null>(null)
  let submitting = $state(false)
  let voted = $state(data.poll.currentUserStatus.countVotes > 0)
  let errorMsg = $state('')

  let poll = $derived(data.poll)
  let isLocked = $derived(poll.status.expired || poll.currentUserStatus.isLocked || voted)

  async function submitVote() {
    if (selectedOptionId === null || isLocked) return
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

  <div class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0">
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

    <div class="p-6 space-y-4">
      {#if errorMsg}
        <Alert variant="destructive">{errorMsg}</Alert>
      {/if}

      <fieldset disabled={isLocked}>
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
                  class="h-4 w-4 accent-accent"
                />
                <span class="flex-1 text-sm">{option.text}</span>
                {#if voted}
                  <span class="text-sm text-ink-muted">{option.votes.count} Stimmen</span>
                {/if}
              </label>
            </li>
          {/each}
        </ul>
      </fieldset>

      {#if !isLocked}
        <Button
          onclick={submitVote}
          disabled={selectedOptionId === null || submitting}
          class="w-full"
        >
          {submitting ? 'Wird abgestimmt…' : 'Abstimmen'}
        </Button>
      {:else if poll.status.expired}
        <p class="text-sm text-center text-ink-muted">Diese Umfrage ist abgelaufen.</p>
      {:else if voted}
        <p class="text-sm text-center text-ink-muted">Du hast bereits abgestimmt.</p>
      {/if}
    </div>
  </div>
</div>
