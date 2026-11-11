// Client-safe view types for the board UI. Defined outside the server module
// so Svelte components can import them without pulling $lib/server into the
// client bundle. The server loader (+page.server.ts) shapes data to match.

export interface CardView {
  id: string
  stack_id: string
  title: string
  description: string | null
  due_date: string | null
  label: string | null
  sort_order: number
  protocol_action_item_id: string | null
  created_by: string | null
  created_at: string | Date
  assignee_name: string | null
  /** The assignee's user id, only while they are a member of the board's committee (the editor's preselection). */
  assignee_id: string | null
  is_mine: boolean
}

/** A member of the board's committee, as the card editor's assignee picker lists them. */
export interface MemberOption {
  id: string
  name: string
}

export interface StackView {
  id: string
  name: string
  sort_order: number
}

export interface BoardView {
  id: string
  org_unit_id: string
  name: string
  archived: boolean
}
