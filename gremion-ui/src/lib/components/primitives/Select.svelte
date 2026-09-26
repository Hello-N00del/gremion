<script lang="ts">
  // primitives/Select: a single-select listbox on Bits UI (TRD-413, TASK-082).
  // Bits UI renders the WAI-ARIA APG collapsible-listbox shape: a button with
  // aria-haspopup=listbox and aria-expanded that opens a listbox of options,
  // with arrow / Home / End navigation, Enter/Space selection, Escape,
  // typeahead and the hidden form input. The wrapper names the button by its
  // visible label AND the current value (aria-labelledby="label value", as the
  // APG example does), so a screen reader still hears the selection a native
  // <select> announces. Styling uses component-tier tokens only
  // (primitives.css). Every string is a prop.
  import { Select } from 'bits-ui'
  import './primitives.css'
  import type { SelectOption } from './types'

  interface Props {
    /** Visible label; the first part of the button's accessible name. */
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
  const valueId = `${uid}-value`
  const selected = $derived(options.find((o) => o.value === value))
</script>

<div class="gp-field">
  <span id={labelId} class="gp-field-label">{label}</span>
  <Select.Root type="single" bind:value {onValueChange} items={options} {name} {disabled} {required}>
    <Select.Trigger class="gp-field-control gp-field-button" aria-labelledby="{labelId} {valueId}">
      <span id={valueId} class={selected ? undefined : 'gp-placeholder'}>{selected ? selected.label : placeholder}</span>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
      </svg>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content class="gp-popover" sideOffset={4}>
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
