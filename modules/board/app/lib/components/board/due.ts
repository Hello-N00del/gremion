// Pure due-date badge logic for Deck cards. Extracted from Card.svelte so it
// is unit-testable and so the board page can reuse it for the header's
// "N überfällig" count.
//
// Tolerates a bare `YYYY-MM-DD`, a full ISO timestamp, or any Date-derived
// string (the loader used to spread the raw DB value through, which produced
// "Invalid Date"); a malformed value yields `null`, never "Invalid Date".
// Mirrors the v6 prototype `dueMeta()` (screens-v4.jsx): Überfällig · DD.MM /
// Heute / DD.MM (≤7d, soon) / DD.MM / Erledigt.

export interface DueMeta {
  label: string
  /** suffix for the `.task-due` class — '' is the neutral (>7d) state */
  cls: 'over' | 'soon' | 'done' | ''
}

export function dueState(
  due: string | null | undefined,
  opts: { done?: boolean; today?: Date } = {},
): DueMeta | null {
  if (opts.done) return { label: 'Erledigt', cls: 'done' }
  if (!due) return null

  // slice to the date part so a full ISO timestamp also parses cleanly
  const d = new Date(String(due).slice(0, 10) + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null // never render "Invalid Date"

  const today = opts.today ? new Date(opts.today) : new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  const label = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })

  if (days < 0) return { label: 'Überfällig · ' + label, cls: 'over' }
  if (days === 0) return { label: 'Heute', cls: 'soon' }
  if (days <= 7) return { label, cls: 'soon' }
  return { label, cls: '' }
}

/** True iff an open card's due date is in the past — for header roll-ups. */
export function isOverdue(due: string | null | undefined, today?: Date): boolean {
  return dueState(due, { today })?.cls === 'over'
}
