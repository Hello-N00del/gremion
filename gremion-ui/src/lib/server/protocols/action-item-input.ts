// What a minutes task may be stored with. The page enforces the same rules, but
// the routes answer for a request that did not come from the page.
import { error } from '@sveltejs/kit'

/** The trimmed title; 400 when it is missing or blank. */
export function requireTaskText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw error(400, 'Bitte einen Titel für die Aufgabe eingeben.')
  return text
}

/**
 * A due date as YYYY-MM-DD. `undefined` = the field was not sent (leave it as it is),
 * `null` = it was sent empty (no date / clear it); 400 for anything that is not a calendar date.
 */
export function optionalDueDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error(400, 'Ungültiges Fälligkeitsdatum.')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw error(400, 'Ungültiges Fälligkeitsdatum.')
  }
  return value
}

/**
 * An assignee id. `undefined` = not sent (leave it), `null` = sent empty (nobody / clear it);
 * 400 for a value that is not a string.
 */
export function optionalAssignee(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw error(400, 'Ungültige Zuständigkeit.')
  return value
}
