import { describe, it, expect } from 'vitest'
import {
  INSTANCE_STATE_META,
  SERVICES,
  STATUS_PILL,
  SERVICE_ICON,
  instanceServices,
  overallFromSilo,
  disabledServices,
  instanceReady,
  type InstanceState,
} from './instance-status'

describe('instance-status — #264 convergence contract', () => {
  it('defines presentation meta for all four states', () => {
    for (const s of ['provisioning', 'ready', 'degraded', 'failed'] as InstanceState[]) {
      const m = INSTANCE_STATE_META[s]
      expect(m.label).toBeTruthy()
      expect(['success', 'warn', 'danger']).toContain(m.tone)
      expect(m.icon).toBeTruthy()
      expect(m.headline).toBeTruthy()
    }
  })

  it('has 6 services split 2 shared control-plane + 4 silo data-plane', () => {
    expect(SERVICES).toHaveLength(6)
    expect(SERVICES.filter((s) => s.plane === 'shared').map((s) => s.key)).toEqual(['app', 'registry'])
    expect(SERVICES.filter((s) => s.plane === 'silo').map((s) => s.key)).toEqual([
      'db',
      'keycloak',
      'nextcloud',
      'matrix',
    ])
  })

  it('maps every service to an Icon name and every silo to a status pill', () => {
    for (const s of SERVICES) expect(SERVICE_ICON[s.key]).toBeTruthy()
    for (const k of ['ok', 'provisioning', 'queued', 'degraded', 'failed'] as const) {
      expect(STATUS_PILL[k].icon).toBeTruthy()
    }
  })

  describe('instanceServices(state)', () => {
    it('ready → every service ok', () => {
      const svcs = instanceServices('ready')
      expect(svcs.every((s) => s.status === 'ok')).toBe(true)
    })
    it('provisioning → silo db/keycloak provisioning, nextcloud/matrix queued', () => {
      const by = Object.fromEntries(instanceServices('provisioning').map((s) => [s.key, s.status]))
      expect(by.app).toBe('ok')
      expect(by.db).toBe('provisioning')
      expect(by.keycloak).toBe('provisioning')
      expect(by.nextcloud).toBe('queued')
      expect(by.matrix).toBe('queued')
    })
    it('overlays real ledger statuses over the snapshot', () => {
      const by = Object.fromEntries(
        instanceServices('ready', { matrix: 'degraded' }).map((s) => [s.key, s.status]),
      )
      expect(by.matrix).toBe('degraded')
      expect(by.db).toBe('ok')
    })
    it('attaches a state-aware message per service', () => {
      const matrix = instanceServices('failed').find((s) => s.key === 'matrix')
      expect(matrix?.message).toContain('Übersprungen')
    })
  })

  describe('overallFromSilo', () => {
    const allOk = { db: 'ok', keycloak: 'ok', nextcloud: 'ok', matrix: 'ok' } as const
    it('all ok → ready', () => {
      expect(overallFromSilo({ ...allOk })).toBe('ready')
    })
    it('any failed → failed', () => {
      expect(overallFromSilo({ ...allOk, keycloak: 'failed' })).toBe('failed')
    })
    it('only matrix degraded → degraded', () => {
      expect(overallFromSilo({ ...allOk, matrix: 'degraded' })).toBe('degraded')
    })
    it('a silo provisioning → provisioning', () => {
      expect(overallFromSilo({ ...allOk, db: 'provisioning' })).toBe('provisioning')
    })
    it('failed beats degraded', () => {
      expect(overallFromSilo({ db: 'ok', keycloak: 'failed', nextcloud: 'ok', matrix: 'degraded' })).toBe('failed')
    })
  })


  describe('overallFromSilo with disabled modules (F7)', () => {
    it('nextcloud absent + files OFF -> ready', () => {
      expect(overallFromSilo({ db: 'ok', keycloak: 'ok', matrix: 'ok' }, disabledServices({ files: false, messages: true }))).toBe('ready')
    })
    it('pending/failed rows of a disabled module are ignored', () => {
      const d = disabledServices({ files: false, messages: false })
      expect(overallFromSilo({ db: 'ok', keycloak: 'ok', nextcloud: 'provisioning', matrix: 'failed' }, d)).toBe('ready')
    })
    it('enabled module failed -> degraded, not failed', () => {
      expect(overallFromSilo({ db: 'ok', keycloak: 'ok', nextcloud: 'failed', matrix: 'ok' }, disabledServices({ files: true, messages: true }))).toBe('degraded')
    })
    it('kernel service failed still -> failed', () => {
      expect(overallFromSilo({ db: 'ok', keycloak: 'failed', nextcloud: 'ok', matrix: 'ok' }, [])).toBe('failed')
    })
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
