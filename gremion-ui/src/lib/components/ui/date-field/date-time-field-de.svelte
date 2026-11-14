<script lang="ts">
  // A date field that always reads and writes German order ("TT.MM.JJJJ", or
  // "TT.MM.JJJJ HH:MM" with a time). The browser's own date input follows the
  // browser language, so the value is typed as text; the Kalender button opens
  // the native picker as a convenience. The bound value is the ISO local value
  // ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"), or '' while the text is not a real
  // German date: only the display is German, nothing stored or sent changes.
  import { untrack } from 'svelte'
  import { cn } from '$lib/utils'
  import { formatDateDe, formatLocalInputDe, parseDateDe, parseDateTimeDe } from './german-datetime'

  interface Props {
    id: string
    /** The ISO local value; '' while the typed text is not a valid German date. */
    value?: string
    /** A day without a time ("TT.MM.JJJJ"). */
    dateOnly?: boolean
    /** Names the field for the calendar button, e.g. "Beginn". */
    label: string
    /** Names the text input itself when no <label for> points at it. */
    inputLabel?: string
    class?: string
  }

  let {
    id,
    value = $bindable(''),
    dateOnly = false,
    label,
    inputLabel,
    class: className = ''
  }: Props = $props()

  const pattern = $derived(dateOnly ? 'TT.MM.JJJJ' : 'TT.MM.JJJJ HH:MM')
  const show = (v: string): string => (dateOnly ? formatDateDe(v) : formatLocalInputDe(v))
  const read = (t: string): string | null => (dateOnly ? parseDateDe(t) : parseDateTimeDe(t))

  let text = $state(untrack(() => show(value)))
  let emitted = untrack(() => value)
  let picker = $state<HTMLInputElement>()

  // The value changed from outside (a form reset, a new default): show it again.
  $effect(() => {
    if (value !== emitted) {
      emitted = value
      text = show(value)
    }
  })

  const invalid = $derived(text.trim() !== '' && read(text) === null)

  function typed() {
    emitted = read(text) ?? ''
    value = emitted
  }

  function tidy() {
    // 5.1.2030 -> 05.01.2030
    if (value) text = show(value)
  }

  function openPicker() {
    if (!picker) return
    picker.value = value
    try {
      picker.showPicker?.()
    } catch {
      // not allowed here (no user gesture, or not supported): the text field still works
    }
  }

  function picked() {
    if (!picker?.value) return
    emitted = picker.value
    value = emitted
    text = show(value)
  }

  const control = 'h-10 rounded-md border border-border-strong bg-paper px-3 text-sm'
</script>

<div class={cn('min-w-0', className)}>
  <div class="relative flex items-center gap-2">
    <input
      {id}
      class={cn(control, 'w-full min-w-0 flex-1 aria-invalid:border-rust')}
      type="text"
      inputmode="numeric"
      autocomplete="off"
      placeholder={pattern}
      aria-label={inputLabel}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={invalid ? `${id}-hint` : undefined}
      bind:value={text}
      oninput={typed}
      onblur={tidy}
    />
    <button
      type="button"
      class={cn(control, 'shrink-0 cursor-pointer')}
      onclick={openPicker}
      aria-label="{label} im Kalender wählen"
    >
      Kalender
    </button>
    <input
      bind:this={picker}
      class="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
      type={dateOnly ? 'date' : 'datetime-local'}
      tabindex="-1"
      aria-hidden="true"
      onchange={picked}
    />
  </div>
  {#if invalid}
    <p class="mt-1 text-xs text-rust" id="{id}-hint" role="status">
      Bitte im Format {pattern} eingeben.
    </p>
  {/if}
</div>
