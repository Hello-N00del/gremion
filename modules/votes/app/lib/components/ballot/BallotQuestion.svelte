<script lang="ts">
  interface Answer {
    index: number
    text: string
  }
  interface Props {
    questionText: string
    questionIndex: number
    questionTotal: number
    answers: Answer[]
    selectedIndices: number[]
    min: number
    max: number
    onselect: (indices: number[]) => void
  }
  let {
    questionText, questionIndex, questionTotal, answers,
    selectedIndices, min, max, onselect,
  }: Props = $props()

  const isRadio = $derived(min === 1 && max === 1)

  function toggle(index: number): void {
    if (isRadio) { onselect([index]); return }
    if (selectedIndices.includes(index)) {
      onselect(selectedIndices.filter((i) => i !== index))
    } else if (selectedIndices.length < max) {
      onselect([...selectedIndices, index])
    }
  }
</script>

<div class="space-y-6">
  <div>
    <p class="text-xs text-ink-muted mb-1">Frage {questionIndex + 1} von {questionTotal}</p>
    <div class="h-1 rounded-full bg-surface-2 overflow-hidden">
      <div class="h-full bg-accent transition-[width] duration-300" style="width: {((questionIndex + 1) / questionTotal) * 100}%"></div>
    </div>
  </div>
  <h2 class="text-lg font-semibold">{questionText}</h2>
  {#if !isRadio}
    <p class="text-xs text-ink-muted">Wähle {min === max ? `genau ${min}` : `${min}–${max}`} Option{max !== 1 ? 'en' : ''}.</p>
  {/if}
  <ul class="space-y-2" role="list">
    {#each answers as a (a.index)}
      {@const checked = selectedIndices.includes(a.index)}
      <li>
        <button
          type="button"
          role={isRadio ? 'radio' : 'checkbox'}
          aria-checked={checked}
          onclick={() => toggle(a.index)}
          class="w-full flex items-center gap-3 rounded-lg border p-4 text-left transition-colors {checked ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:bg-surface-2/50'}"
        >
          <div class="h-4 w-4 shrink-0 rounded-{isRadio ? 'full' : 'sm'} border-2 {checked ? 'border-accent bg-accent' : 'border-ink-muted'}"></div>
          <span class="text-sm">{a.text}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>
