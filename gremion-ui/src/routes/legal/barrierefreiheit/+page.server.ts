import type { PageServerLoad } from './$types'
import { readConfig } from '$lib/server/config'

// Public statutory page. Content is it-admin-configured (Settings → Rechtliches
// → config.legal.barrierefreiheit_html). DB/config-read failure degrades to an
// empty string → the page renders its "noch nicht hinterlegt" state.
export const load: PageServerLoad = async () => {
  let html = ''
  try {
    html = readConfig().legal.barrierefreiheit_html ?? ''
  } catch {
    html = ''
  }
  return { html }
}
