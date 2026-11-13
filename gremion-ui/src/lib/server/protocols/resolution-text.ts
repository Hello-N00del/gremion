import { error } from '@sveltejs/kit'

export const RESOLUTION_TEXT_REQUIRED_MESSAGE = 'Der Beschlusstext darf nicht leer sein.'

/**
 * A decision is stored only with its text: an empty decision in the minutes is
 * not a decision. Returns the trimmed text, or answers 400 with a German
 * message. Used by both resolution write routes (create and edit), so the rule
 * holds for the API and not just for the editor form.
 */
export function requireResolutionText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw error(400, RESOLUTION_TEXT_REQUIRED_MESSAGE)
  }
  return value.trim()
}
