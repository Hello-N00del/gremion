// The (shell) layout reads what the gate put on locals. It is NOT the gate:
// hooks.server.ts decided before this runs (a layout gate would miss form
// actions and +server endpoints).
import { error } from '@sveltejs/kit'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = ({ locals }) => {
  if (!locals.operator) error(403, 'not signed in through the ops realm')
  return { operator: { email: locals.operator.email, acr: locals.operator.acr } }
}
