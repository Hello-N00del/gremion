import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

// #167: deep-link alias map. Canonical section keys are idempotent; legacy
// sub-route path names (general/services/email/legal/compliance/retention/
// backups/danger/accessibility) map onto their new canonical section so old
// bookmarks/links keep resolving. Anything else 404s.
const ALIASES: Record<string, string> = {
  // canonical keys (idempotent)
  profil: 'profil',
  darstellung: 'darstellung',
  organisation: 'organisation',
  dienste: 'dienste',
  email: 'email',
  rechtliches: 'rechtliches',
  datenschutz: 'datenschutz',
  sicherungen: 'sicherungen',
  loeschfristen: 'loeschfristen',
  gefahrenzone: 'gefahrenzone',
  // legacy sub-route paths → canonical section key
  general: 'organisation',
  accessibility: 'darstellung',
  services: 'dienste',
  legal: 'rechtliches',
  compliance: 'datenschutz',
  backups: 'sicherungen',
  retention: 'loeschfristen',
  danger: 'gefahrenzone',
}

export const load: PageServerLoad = async ({ params, parent }) => {
  // Inherit config/isITAdmin/loeschkonzept/user from the settings layout load.
  await parent()
  const key = ALIASES[params.section]
  if (!key) throw error(404, 'Unbekannter Einstellungsbereich')
  return { activeSection: key }
}
