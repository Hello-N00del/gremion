// What a board is called in the switcher. Every new board starts with the same title, so a member
// of two committees saw the same chip twice: a title that another listed board also carries gets
// the committee's name next to it. A title that already tells the boards apart stays as it is.

export interface SwitcherBoard {
  id: string
  org_unit_id: string
  name: string
  /** The owning committee's name; '' when it is not known. */
  org_unit_name: string
}

const same = (a: string, b: string): boolean => a.trim().toLocaleLowerCase('de') === b.trim().toLocaleLowerCase('de')

export function boardChipLabel(board: SwitcherBoard, boards: readonly SwitcherBoard[]): string {
  const title = board.name.trim()
  const unit = board.org_unit_name.trim()
  if (!unit || same(unit, title)) return title
  const shared = boards.some((other) => other.id !== board.id && same(other.name, title))
  return shared ? `${title} · ${unit}` : title
}
