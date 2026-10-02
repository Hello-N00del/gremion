<script lang="ts">
  import { Button } from '$lib/components/ui/button'

  interface ReviewQuestion { questionText: string; selectedAnswers: string[] }
  interface Props {
    questions: ReviewQuestion[]
    onback: (questionIndex: number) => void
    onsubmit: () => void
    submitting: boolean
    disabled?: boolean
  }
  let { questions, onback, onsubmit, submitting, disabled = false }: Props = $props()
</script>

<div class="space-y-6">
  <h2 class="text-lg font-semibold">Stimmzettel überprüfen</h2>
  <ul class="space-y-4" role="list">
    {#each questions as q, i (i)}
      <li class="rounded-lg border border-border bg-surface p-4 space-y-2">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-medium">{q.questionText}</p>
          <button type="button" onclick={() => onback(i)} class="text-xs text-ink-muted hover:underline shrink-0">Ändern</button>
        </div>
        <ul class="space-y-1">
          {#each q.selectedAnswers as answer (answer)}
            <li class="text-sm text-accent">✓ {answer}</li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
  <Button onclick={onsubmit} disabled={submitting || disabled} class="w-full">
    {submitting ? 'Verschlüssele und übermittle…' : 'Stimme abgeben'}
  </Button>
</div>
