<script lang="ts">
  // primitives/Combobox: the WAI-ARIA APG combobox with a listbox popup and
  // list autocomplete, as a thin Bits UI wrapper (TRD-413, TASK-082). Bits UI
  // supplies role=combobox on the input, aria-expanded, aria-activedescendant, the
  // listbox, arrow navigation with DOM focus kept in the input, Enter
  // selection, Escape and the hidden form input. Bits UI leaves aria-controls
  // off the input (required on an expanded combobox, axe aria-required-attr)
  // and the listbox unnamed (aria-input-field-name); the wrapper adds both.
  // It also filters options by
  // the typed text (Bits UI leaves filtering to the consumer), names the input
  // with a real <label>, and styles with component-tier tokens only
  // (primitives.css). Every string is a prop.
  import { Combobox } from 'bits-ui'
  import './primitives.css'
  import type { SelectOption } from './types'

  interface Props {
    /** Visible label; the input's accessible name. */
    label: string
    placeholder: string
    /** Accessible name of the icon-only button that opens the suggestions. */
    toggleLabel: string
    /** Shown (as a live status) when nothing matches the typed text. */
    emptyText: string
    options: SelectOption[]
    /** Selected value ('' = none); bindable. */
    value?: string
    onValueChange?: (value: string) => void
    name?: string
    disabled?: boolean
    required?: boolean
  }

  let {
    label,
    placeholder,
    toggleLabel,
    emptyText,
    options,
    value = $bindable(''),
    onValueChange,
    name,
    disabled = false,
    required = false,
  }: Props = $props()

  const uid = $props.id()
  const inputId = `${uid}-input`
  const labelId = `${uid}-label`
  const listboxId = `${uid}-listbox`
  let search = $state('')
  let open = $state(false)

  const filtered = $derived.by(() => {
    const q = search.trim().toLocaleLowerCase()
    return q === '' ? options : options.filter((o) => o.label.toLocaleLowerCase().includes(q))
  })
  const selectedLabel = $derived(options.find((o) => o.value === value)?.label)

  function handleInput(e: Event & { currentTarget: HTMLInputElement }) {
    search = e.currentTarget.value
  }

  function handleOpenChange(next: boolean) {
    if (!next) search = ''
  }
</script>

<div class="gp-field">
  <label id={labelId} for={inputId} class="gp-field-label">{label}</label>
  <Combobox.Root
    type="single"
    bind:value
    bind:open
    {onValueChange}
    onOpenChange={handleOpenChange}
    items={options}
    {name}
    {disabled}
    {required}
  >
    <div class="gp-field-control">
      <Combobox.Input
        id={inputId}
        {placeholder}
        defaultValue={selectedLabel}
        aria-controls={listboxId}
        oninput={handleInput}
      />
      <Combobox.Trigger class="gp-icon-button" aria-label={toggleLabel}>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
          <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
        </svg>
      </Combobox.Trigger>
    </div>
    <Combobox.Portal>
      <Combobox.Content id={listboxId} class="gp-popover" sideOffset={4} aria-labelledby={labelId}>
        <Combobox.Viewport>
          {#each filtered as option (option.value)}
            <Combobox.Item class="gp-popover-item" value={option.value} label={option.label} disabled={option.disabled}>
              {#snippet children({ selected })}
                <span>{option.label}</span>
                {#if selected}
                  <svg class="gp-check" aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
                  </svg>
                {/if}
              {/snippet}
            </Combobox.Item>
          {/each}
        </Combobox.Viewport>
      </Combobox.Content>
    </Combobox.Portal>
  </Combobox.Root>
  <!-- A persistent live region outside the listbox (a listbox may only own
       options, axe aria-required-children): it holds emptyText only while
       the suggestions are open and nothing matches. -->
  <span class="gp-popover-empty" role="status">{open && filtered.length === 0 ? emptyText : ''}</span>
</div>
