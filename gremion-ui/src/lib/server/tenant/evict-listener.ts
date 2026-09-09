// src/lib/server/tenant/evict-listener.ts
// G-XPROC (SP-4) — cross-process tenant-eviction listener.
//
// evictTenantRuntime busts an IN-PROCESS Map; a CLI `suspend`/`delete` runs in a
// SEPARATE process, so without this its eviction is invisible to running app
// replicas for up to RESOLUTION_CACHE_TTL_MS (~30s), during which a suspended/
// deleted tenant keeps resolving with full data-plane access. updateTenantStatus
// issues pg_notify(tenant_evict, '<tenantId>') (same-tx with the status flip);
// this module subscribes every app process to that channel and calls
// evictTenantRuntime locally on receipt — instant, fleet-wide eviction. The TTL
// remains the backstop if a NOTIFY is missed during a listener reconnect.
import { getControlDb } from './control-db'
import { evictTenantRuntime, TENANT_EVICT_CHANNEL } from './registry'

let _started = false

/**
 * Subscribe THIS process to tenant-evict notifications. Idempotent: a second
 * call after a successful subscribe is a no-op. postgres.js `sql.listen` runs on
 * its OWN dedicated connection (outside the pool's `max`) and auto-reconnects,
 * re-emitting the onlisten callback. If the initial subscribe throws, `_started`
 * stays false so a later boot/retry can re-subscribe (the TTL covers the gap).
 */
export async function startTenantEvictListener(): Promise<void> {
  if (_started) return
  await getControlDb().listen(
    TENANT_EVICT_CHANNEL,
    (payload) => {
      const tenantId = (payload ?? '').trim()
      if (!tenantId) return
      console.info(`[tenant-evict] NOTIFY received → evicting tenant ${tenantId} runtime`)
      evictTenantRuntime(tenantId)
    },
    () => console.info(`[tenant-evict] LISTEN ${TENANT_EVICT_CHANNEL} active`),
  )
  _started = true
}

/** Test-only: reset the once-guard so each case starts unsubscribed. */
export function _resetEvictListenerForTests(): void {
  _started = false
}
