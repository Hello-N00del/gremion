<script lang="ts">
  // primitives/Select: the WAI-ARIA APG select-only combobox on Bits UI
  // (TRD-413, TASK-082). Bits UI keeps DOM focus on the trigger and points
  // aria-activedescendant at the highlighted option, i.e. the select-only
  // combobox focus model, but renders the trigger as a plain button, and an
  // activedescendant on a button is invalid ARIA (axe aria-allowed-attr). The
  // wrapper therefore gives the trigger role=combobox with aria-controls to
  // the listbox, names the combobox and the listbox by the visible label, and
  // leaves arrows / Home / End, Enter/Space, Escape, typeahead and the hidden
  // form input to Bits UI. The combobox's text content is its value, as a
  // native <select> announces it. Styling uses component-tier tokens only
  // (primitives.css). Every string is a prop.
  import { Select } from 'bits-ui'
  import './primitives.css'
  import type { SelectOption } from './types'

  interface Props {
    /** Visible label; the accessible name of the combobox and its listbox. */
    label: string
    /** Shown in the trigger while nothing is selected. */
    placeholder: string
    options: SelectOption[]
    /** Selected value ('' = none); bindable. */
    value?: string
    onValueChange?: (value: string) => void
    /** Form field name (Bits UI renders the hidden input). */
    name?: string
    disabled?: boolean
    required?: boolean
  }

  let {
    label,
    placeholder,
    options,
    value = $bindable(''),
    onValueChange,
    name,
    disabled = false,
    required = false,
  }: Props = $props()

  const uid = $props.id()
  const labelId = `${uid}-label`
  const listboxId = `${uid}-listbox`
  const selected = $derived(options.find((o) => o.value === value))
</script>

<div class="gp-field">
  <span id={labelId} class="gp-field-label">{label}</span>
  <Select.Root type="single" bind:value {onValueChange} items={options} {name} {disabled} {required}>
    <Select.Trigger class="gp-field-control gp-field-button" role="combobox" aria-controls={listboxId} aria-labelledby={labelId}>
      <span class={selected ? undefined : 'gp-placeholder'}>{selected ? selected.label : placeholder}</span>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
      </svg>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content id={listboxId} class="gp-popover" sideOffset={4} aria-labelledby={labelId}>
        <Select.Viewport>
          {#each options as option (option.value)}
            <Select.Item class="gp-popover-item" value={option.value} label={option.label} disabled={option.disabled}>
              {#snippet children({ selected: isSelected })}
                <span>{option.label}</span>
                {#if isSelected}
                  <svg class="gp-check" aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
                  </svg>
                {/if}
              {/snippet}
            </Select.Item>
          {/each}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
</div>
