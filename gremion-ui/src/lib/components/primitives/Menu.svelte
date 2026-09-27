<script lang="ts">
  // primitives/Menu: the WAI-ARIA APG menu button, as a thin Bits UI wrapper
  // (TRD-413, TASK-082). Bits UI supplies aria-haspopup=menu/aria-expanded on
  // the button, role=menu/menuitem, focus on the first item when opened from
  // the keyboard, roving focus with the arrow keys, Home/End, typeahead,
  // Enter/Space activation, Escape and focus return to the button. The
  // wrapper styles with component-tier tokens only (primitives.css). Every
  // string is a prop.
  import { DropdownMenu } from 'bits-ui'
  import './primitives.css'
  import type { MenuEntry } from './types'

  interface Props {
    /** Visible text of the menu button; its accessible name. */
    triggerLabel: string
    items: MenuEntry[]
    /** Open state; bindable. */
    open?: boolean
  }

  let { triggerLabel, items, open = $bindable(false) }: Props = $props()
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger class="gp-field-control gp-field-button">
    <span>{triggerLabel}</span>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
    </svg>
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content class="gp-popover" sideOffset={4} align="start">
      {#each items as item (item.id)}
        <DropdownMenu.Item class="gp-popover-item" textValue={item.label} disabled={item.disabled} onSelect={item.onSelect}>
          {item.label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
