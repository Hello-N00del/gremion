// @vitest-environment node
//
// TRD-162 / PRD-REG-004: the per-customer record of processing activities
// (GDPR Art. 30(1)) is pre-filled from the modules the tenant has enabled and
// regenerated whenever the module set changes; admin overrides survive.
import { describe, expect, it } from 'vitest'
import type { ModuleManifest } from '$lib/modules/types'
import type { GremionConfig } from './config'
import { buildProcessingActivities, generateVerarbeitungsverzeichnis } from './verarbeitungsverzeichnis'

const base = { order: 1, pages: [], routePrefixes: [] }
const MANIFESTS: ModuleManifest[] = [
  {
    ...base,
    id: 'core',
    toggleable: false,
    processing: {
      activity: 'Betrieb der Plattform',
      purpose: 'Anmeldung und Sicherheit',
      dataCategories: ['Kontodaten'],
      dataSubjects: ['Nutzende'],
      retention: 'Gemäß Löschkonzept',
    },
  },
  {
    ...base,
    id: 'alpha',
    toggleable: true,
    processing: {
      activity: 'Alpha-Verwaltung',
      purpose: 'Alpha-Zweck',
      dataCategories: ['Stammdaten', 'Kontaktdaten'],
      dataSubjects: ['Mitglieder'],
      retention: '10 Jahre',
    },
  },
  { ...base, id: 'beta', toggleable: true },
]

function cfg(modules: Record<string, boolean>, overrides?: Record<string, object>): GremionConfig {
  return {
    modules,
    retention: { access_logs_days: 14, app_logs_days: 28, security_logs_days: 27, security_nopii_logs_days: 27 },
    compliance: {
      dpo_name: '',
      dpo_email: '',
      controller_name: 'Kunde',
      controller_address: '',
      purpose_description: '',
      ...(overrides ? { processing_overrides: overrides } : {}),
    },
  } as unknown as GremionConfig
}

const ids = (c: GremionConfig) => buildProcessingActivities(c, MANIFESTS).map((a) => a.moduleId)

describe('buildProcessingActivities', () => {
  it('lists always-on modules plus exactly the enabled toggleable ones', () => {
    expect(ids(cfg({ alpha: true, beta: false }))).toEqual(['core', 'alpha'])
    expect(ids(cfg({ alpha: false, beta: false }))).toEqual(['core'])
    expect(ids(cfg({ alpha: true, beta: true }))).toEqual(['core', 'alpha', 'beta'])
  })

  it('treats a module missing from config.modules as enabled (default-on)', () => {
    expect(ids(cfg({}))).toEqual(['core', 'alpha', 'beta'])
  })

  it('pre-fills categories, purpose and retention from the manifest', () => {
    const alpha = buildProcessingActivities(cfg({ alpha: true }), MANIFESTS).find((a) => a.moduleId === 'alpha')!
    expect(alpha).toMatchObject({
      activity: 'Alpha-Verwaltung',
      purpose: 'Alpha-Zweck',
      dataCategories: ['Stammdaten', 'Kontaktdaten'],
      retention: '10 Jahre',
      overridden: false,
    })
  })

  it('flags an enabled module without a declaration instead of dropping it', () => {
    const beta = buildProcessingActivities(cfg({ beta: true }), MANIFESTS).find((a) => a.moduleId === 'beta')!
    expect(beta.declared).toBe(false)
    expect(beta.purpose).toMatch(/nicht erfasst/i)
  })

  it('applies admin overrides field by field', () => {
    const c = cfg({ alpha: true }, { alpha: { purpose: 'Eigener Zweck', data_categories: ['Nur Namen'] } })
    const alpha = buildProcessingActivities(c, MANIFESTS).find((a) => a.moduleId === 'alpha')!
    expect(alpha.purpose).toBe('Eigener Zweck')
    expect(alpha.dataCategories).toEqual(['Nur Namen'])
    expect(alpha.retention).toBe('10 Jahre')
    expect(alpha.overridden).toBe(true)
  })

  it('overrides survive disable then re-enable (regeneration) and never leak while disabled', () => {
    const overrides = { alpha: { purpose: 'Eigener Zweck' } }
    expect(ids(cfg({ alpha: false, beta: false }, overrides))).toEqual(['core'])
    const again = buildProcessingActivities(cfg({ alpha: true }, overrides), MANIFESTS).find((a) => a.moduleId === 'alpha')!
    expect(again.purpose).toBe('Eigener Zweck')
  })
})

describe('generateVerarbeitungsverzeichnis', () => {
  const asOf = new Date('2026-10-27T00:00:00Z')

  it('changes its activity list when a module is enabled or disabled', () => {
    const on = generateVerarbeitungsverzeichnis(cfg({ alpha: true }), asOf, MANIFESTS)
    const off = generateVerarbeitungsverzeichnis(cfg({ alpha: false }), asOf, MANIFESTS)
    expect(on).toContain('Alpha-Verwaltung')
    expect(off).not.toContain('Alpha-Verwaltung')
    expect(off).toContain('Betrieb der Plattform')
  })

  it('names the controller and carries the override text', () => {
    const doc = generateVerarbeitungsverzeichnis(cfg({ alpha: true }, { alpha: { purpose: 'Eigener Zweck' } }), asOf, MANIFESTS)
    expect(doc).toContain('Verzeichnis von Verarbeitungstätigkeiten')
    expect(doc).toContain('Art. 30')
    expect(doc).toContain('Kunde')
    expect(doc).toContain('Eigener Zweck')
    expect(doc).toContain('2026-10-27')
  })
})
