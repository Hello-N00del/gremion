<script lang="ts">
  // A date (and time) field that always reads and writes German order
  // ("TT.MM.JJJJ HH:MM", or "TT.MM.JJJJ" for an all-day event). The browser's
  // own date input follows the browser language (it showed 11/11/2026), so the
  // value is typed as text; the Kalender button opens the native picker as a
  // convenience. The bound value is the ISO local value ("YYYY-MM-DDTHH:mm" or
  // "YYYY-MM-DD"), or '' while the text is not a real German date: only the
  // display is German, nothing stored or sent changes.
  import { untrack } from 'svelte'
  import { formatDateDe, formatLocalInputDe, parseDateDe, parseDateTimeDe } from './german-datetime'

  interface Props {
    id: string
    /** The ISO local value; '' while the typed text is not a valid German date. */
    value?: string
    dateOnly?: boolean
    /** Names the field for the calendar button, e.g. "Beginn". */
    label: string
    class?: string
  }

  let { id, value = $bindable(''), dateOnly = false, label, class: className = '' }: Props = $props()

  const show = (v: string): string => (dateOnly ? formatDateDe(v) : formatLocalInputDe(v))
  const read = (t: string): string | null => (dateOnly ? parseDateDe(t) : parseDateTimeDe(t))

  let text = $state(untrack(() => show(value)))
  let emitted = untrack(() => value)
  let picker = $state<HTMLInputElement>()

  // The value changed from outside (the all-day switch): show it again.
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
    // 5.1.2030 7:05 -> 05.01.2030 07:05
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
</script>

<div class="dtf {className}">
  <div class="row">
    <input
      {id}
      class="text"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      placeholder={dateOnly ? 'TT.MM.JJJJ' : 'TT.MM.JJJJ HH:MM'}
      aria-invalid={invalid ? 'true' : undefined}
      bind:value={text}
      oninput={typed}
      onblur={tidy}
    />
    <button type="button" class="cal" onclick={openPicker} aria-label="{label} im Kalender wählen">
      Kalender
    </button>
    <input
      bind:this={picker}
      class="native"
      type={dateOnly ? 'date' : 'datetime-local'}
      tabindex="-1"
      aria-hidden="true"
      onchange={picked}
    />
  </div>
  {#if invalid}
    <p class="hint" role="status">
      Bitte im Format {dateOnly ? 'TT.MM.JJJJ' : 'TT.MM.JJJJ HH:MM'} eingeben.
    </p>
  {/if}
</div>

<style>
  .dtf { min-width: 0; }
  .row { position: relative; display: flex; align-items: center; gap: 8px; }
  .text,
  .cal {
    height: 2.5rem;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--paper);
    color: inherit;
    font-size: 0.875rem;
  }
  .text { flex: 1 1 auto; min-width: 0; width: 100%; padding: 0 0.75rem; }
  .text[aria-invalid='true'] { border-color: var(--rust); }
  .cal { flex: 0 0 auto; padding: 0 0.75rem; cursor: pointer; }
  .native { position: absolute; right: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .hint { margin: 4px 0 0; font-size: 0.75rem; color: var(--rust); }
</style>
