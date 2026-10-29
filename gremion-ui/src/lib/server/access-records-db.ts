// src/lib/server/access-records-db.ts
// TRD-092 / PRD-OPS-006: the pool through which a council's administrator reads the
// record of vendor and operator access (oac.access_record in gremion_platform).
// Like the control registry pool (tenant/control-db.ts) it is NOT a per-tenant
// pool: the record lives in the platform database, beside the request queue.
//
// It connects as the dedicated role gremion_ui_oac (@gremion/provisioning
// ensureAccessReader): LOGIN, EXECUTE on oac.list_access_records and on nothing
// else, no table privilege, no marker role. The minimal grant is the whole of
// gremion-ui's access to platform data; it can neither write a record nor read
// the request queue. PLATFORM_ACCESS_DATABASE_URL is that role's URL.
import postgres from 'postgres'
import { env } from '$env/dynamic/private'

/** The read role is not set up on this deployment (the view says so; it never shows an empty list instead). */
export class AccessLogNotConfigured extends Error {
  constructor() {
    super('PLATFORM_ACCESS_DATABASE_URL not configured')
    this.name = 'AccessLogNotConfigured'
  }
}

let _access: ReturnType<typeof postgres> | null = null

export function getAccessDb(): ReturnType<typeof postgres> {
  if (!_access) {
    const url = env.PLATFORM_ACCESS_DATABASE_URL
    if (!url) throw new AccessLogNotConfigured()
    _access = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10 })
  }
  return _access
}

/** Test-only: drop the cached client. */
export function _resetAccessDbForTests(): void {
  _access = null
}
