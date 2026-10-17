// The "Betrieb" page: key numbers from the ops stack's Prometheus, read here
// (server-side) only. The gate in hooks.server.ts already ran.
import { env } from '$env/dynamic/private'
import { loadBetrieb } from '$lib/server/betrieb'
import { loadConfig } from '$lib/server/config'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async () => {
  const r = loadConfig(env)
  if (!r.ok) return { disabled: 'Die Konfiguration ist unvollständig.', unreachable: null, panels: [], readAt: new Date().toISOString() }
  return { ...(await loadBetrieb(r.config)), readAt: new Date().toISOString() }
}
