<script lang="ts">
  // A date and time field that always reads and writes German order
  // ("TT.MM.JJJJ HH:MM"). The browser's own date-time input follows the browser
  // language (it showed dd/mm/yyyy), so the value is typed as text here; the
  // calendar button opens the native picker as a convenience. The bound value is
  // the German text; the caller turns it into ISO with parseDateTimeDe.
  import { formatLocalInputDe, parseDateTimeDe } from '$lib/components/news/format-de'

  let { value = $bindable(''), label = 'Geplante Zeit' }: { value?: string; label?: string } = $props()

  let picker = $state<HTMLInputElement>()

  function openPicker() {
    if (!picker) return
    picker.value = parseDateTimeDe(value) ?? ''
    try {
      picker.showPicker?.()
    } catch {
      // not allowed here (no user gesture, or not supported): the text field still works
    }
  }

  function picked() {
    if (picker?.value) value = formatLocalInputDe(picker.value)
  }
</script>

<span class="dt">
  <input
    type="text"
    inputmode="numeric"
    autocomplete="off"
    placeholder="TT.MM.JJJJ HH:MM"
    aria-label={label}
    bind:value
  />
  <button type="button" class="cal" onclick={openPicker}>Kalender</button>
  <input
    bind:this={picker}
    class="native"
    type="datetime-local"
    tabindex="-1"
    aria-hidden="true"
    onchange={picked}
  />
</span>

<style>
  .dt { position: relative; display: inline-flex; align-items: center; gap: 6px; }
  .dt input[type='text'] { width: 11.5em; padding: 6px 8px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; background: var(--surface, #fff); color: inherit; }
  .cal { padding: 6px 10px; border: 1px solid var(--border, #ccc); border-radius: 6px; background: var(--surface, #fff); color: inherit; font-size: 13px; cursor: pointer; }
  .native { position: absolute; right: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
