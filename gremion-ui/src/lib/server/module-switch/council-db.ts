// src/lib/server/module-switch/council-db.ts
// Council module self-service: the pool through which gremion-ui submits and
// reads module switch requests (plt.submit_council_module_request,
// plt.council_module_requests, plt.council_module_state in gremion_platform).
// Like access-records-db.ts it is NOT a per-tenant pool: the request queue
// lives in the platform database.
//
// It connects as the dedicated role gremion_ui_modules (@gremion/provisioning
// ensureCouncilRequester): LOGIN, EXECUTE on those three functions and on
// nothing else, no table privilege. PLATFORM_MODULES_DATABASE_URL is that
// role's URL; deploy wiring leaves it empty when UI_MODULES_DB_PASSWORD is
// unset, which is the safety switch for self-service switching.
import postgres from 'postgres'
import { env } from '$env/dynamic/private'

/** The requester role is not set up on this deployment (the settings section says so; it never shows an empty list instead). */
export class CouncilNotConfigured extends Error {
  constructor() {
    super('PLATFORM_MODULES_DATABASE_URL not configured')
    this.name = 'CouncilNotConfigured'
  }
}

let _council: ReturnType<typeof postgres> | null = null

export function getCouncilDb(): ReturnType<typeof postgres> {
  if (!_council) {
    const url = env.PLATFORM_MODULES_DATABASE_URL
    if (!url) throw new CouncilNotConfigured()
    _council = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10 })
  }
  return _council
}

/** Test-only: drop the cached client. */
export function _resetCouncilDbForTests(): void {
  _council = null
}
