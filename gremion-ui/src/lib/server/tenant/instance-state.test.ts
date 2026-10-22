import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  modules: {} as Record<string, boolean>,
  resources: [] as { subsystem: string; status: string }[],
  throwConfig: false,
}))
vi.mock('$lib/server/config', () => ({
  readConfig: () => {
    if (h.throwConfig) throw new Error('config unreadable')
    return { modules: h.modules }
  },
}))
vi.mock('./registry', () => ({ getTenantResources: async () => h.resources }))
vi.mock('./readiness', () => ({ getTenantReadiness: () => 'ready' }))

import { instanceStatusDetail } from './instance-state'
import { SILO_SUBSYSTEM_TO_SERVICE } from '$lib/instance-status'

const tenant = { id: 't1' }
const subsystems = Object.keys(SILO_SUBSYSTEM_TO_SERVICE)
const allOk = () => subsystems.map((subsystem) => ({ subsystem, status: 'ok' }))

describe('instanceStatusDetail loader wiring (F7: readConfig -> disabledServices -> overallFromSilo)', () => {
  beforeEach(() => {
    h.modules = { files: true, messages: true }
    h.resources = []
    h.throwConfig = false
  })

  it('a FAILED nextcloud row is ignored when the files module is OFF (disabled set reaches overallFromSilo)', async () => {
    h.modules = { files: false, messages: true }
    h.resources = allOk().map((r) => (r.subsystem === 'nextcloud' ? { ...r, status: 'failed' } : r))
    expect((await instanceStatusDetail(tenant)).state).toBe('ready')
  })

  it('the same failed nextcloud row degrades the instance when files is ON', async () => {
    h.resources = allOk().map((r) => (r.subsystem === 'nextcloud' ? { ...r, status: 'failed' } : r))
    expect((await instanceStatusDetail(tenant)).state).toBe('degraded')
  })

  it('a MISSING matrix row does not make the ledger incomplete when messages is OFF', async () => {
    h.modules = { files: true, messages: false }
    h.resources = allOk().filter((r) => r.subsystem !== 'matrix')
    expect((await instanceStatusDetail(tenant)).state).toBe('ready')
  })

  it('a config read failure fails safe (nothing disabled, no throw)', async () => {
    h.throwConfig = true
    h.resources = allOk()
    expect((await instanceStatusDetail(tenant)).state).toBe('ready')
  })
})
