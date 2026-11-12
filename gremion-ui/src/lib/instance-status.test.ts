import { describe, it, expect } from 'vitest'
import { INSTANCE_STATE_META, instanceReady, type InstanceState } from './instance-status'

// E3: the per-service snapshot, the canned per-state messages and the ledger
// helpers were removed with the Systemstatus claims they fed; the overall-state
// presentation the shell badge and banner use remains.
describe('instance-status: overall state presentation', () => {
  it('defines presentation meta for all four states', () => {
    for (const s of ['provisioning', 'ready', 'degraded', 'failed'] as InstanceState[]) {
      const m = INSTANCE_STATE_META[s]
      expect(m.label).toBeTruthy()
      expect(['success', 'warn', 'danger']).toContain(m.tone)
      expect(m.icon).toBeTruthy()
      expect(m.headline).toBeTruthy()
    }
  })

  describe('instanceReady', () => {
    it('true only for ready (null defaults to ready/hidden)', () => {
      expect(instanceReady('ready')).toBe(true)
      expect(instanceReady(null)).toBe(true)
      expect(instanceReady('degraded')).toBe(false)
      expect(instanceReady('provisioning')).toBe(false)
      expect(instanceReady('failed')).toBe(false)
    })
  })
})
