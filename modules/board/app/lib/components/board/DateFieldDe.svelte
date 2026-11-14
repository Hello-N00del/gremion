<script lang="ts">
  // A date field that always reads and writes German order ("TT.MM.JJJJ"). The browser's own date
  // input follows the browser language, so the date is typed as text; the Kalender button opens
  // the native picker as a convenience. The bound value is the ISO day ("YYYY-MM-DD"), or '' while
  // the field is empty or its text is not a real date; `invalid` tells the two apart, so a typo is
  // never taken for "no date". Only the display is German, nothing stored or sent changes.
  import { untrack } from 'svelte'
  import { formatDateDe, parseDateDe } from './german-date'

  interface Props {
    /** The id of the text input: the caller's <label for> points at it. */
    id: string
    /** The ISO day; '' while the field is empty or the typed text is not a date. */
    value?: string
    /** True while the field holds text that is not a real German date. */
    invalid?: boolean
    /** Names the field for the calendar button, e.g. "Fälligkeit". */
    label: string
  }

  let { id, value = $bindable(''), invalid = $bindable(false), label }: Props = $props()

  let text = $state(untrack(() => formatDateDe(value)))
  let emitted = untrack(() => value)
  let picker = $state<HTMLInputElement>()

  // The value changed from outside: show it again.
  $effect(() => {
    if (value !== emitted) {
      emitted = value
      text = formatDateDe(value)
      invalid = false
    }
  })

  function typed() {
    const parsed = parseDateDe(text)
    emitted = parsed ?? ''
    value = emitted
    invalid = text.trim() !== '' && parsed === null
  }

  function tidy() {
    // 5.1.2030 -> 05.01.2030
    if (value) text = formatDateDe(value)
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
    text = formatDateDe(value)
    invalid = false
  }
</script>

<div class="dfd">
  <div class="row">
    <input
      {id}
      class="text"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      placeholder="TT.MM.JJJJ"
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={invalid ? `${id}-hint` : undefined}
      bind:value={text}
      oninput={typed}
      onblur={tidy}
    />
    <button type="button" class="cal" onclick={openPicker} aria-label="{label} im Kalender wählen">Kalender</button>
    <input bind:this={picker} class="native" type="date" tabindex="-1" aria-hidden="true" onchange={picked} />
  </div>
  {#if invalid}
    <p class="hint" id="{id}-hint">Bitte im Format TT.MM.JJJJ eingeben.</p>
  {/if}
</div>

<style>
  .dfd {
    min-width: 0;
  }
  .row {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
  .text,
  .cal {
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
  }
  .text[aria-invalid='true'] {
    border-color: var(--rust);
  }
  .cal {
    flex: 0 0 auto;
    cursor: pointer;
  }
  .cal:hover {
    background: var(--surface-2);
  }
  /* Kept in the layout (not display:none) so showPicker() has an anchor; never seen or focused. */
  .native {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .hint {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--rust);
  }
</style>
