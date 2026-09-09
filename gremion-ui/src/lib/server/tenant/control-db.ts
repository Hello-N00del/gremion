// src/lib/server/tenant/control-db.ts
// P2.1a — dedicated control-plane Postgres pool (spec §3.1 / D8). The Tenant
// Registry lives in its OWN `control` database. This pool reads
// env.CONTROL_DATABASE_URL and is INTENTIONALLY NOT a per-tenant pool: not in
// the per-tenant LRU, not resolved via ALS, and it must survive any single
// tenant DB outage (resolving tenant N must not depend on tenant #1's health).
// max:3 keeps the control budget tiny (control traffic is low).
import postgres from 'postgres'
import { env } from '$env/dynamic/private'

let _control: ReturnType<typeof postgres> | null = null

export function getControlDb(): ReturnType<typeof postgres> {
  if (!_control) {
    const url = env.CONTROL_DATABASE_URL
    if (!url) throw new Error('CONTROL_DATABASE_URL not configured')
    _control = postgres(url, { max: 3, idle_timeout: 20, connect_timeout: 10 })
  }
  return _control
}

/** Test-only: drop the cached control client. */
export function _resetControlDbForTests(): void {
  _control = null
}
