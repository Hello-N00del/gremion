/** One option of a Select or Combobox. `label` is shown, typed and announced. */
export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** One entry of a Menu. `label` is the menuitem's accessible name. */
export interface MenuEntry {
  id: string
  label: string
  disabled?: boolean
  onSelect: () => void
}
