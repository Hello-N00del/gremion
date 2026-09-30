// Finance-vocabulary seam — config-only per-tenant finance-role display labels
// riding the existing D-VOCAB seam. Default = the frozen KV/HV pair for EVERY
// tenant today (byte-identical), with an OPTIONAL whole-value
// `config.financeRoles` override (zod-validated, absent everywhere in existing
// configs — pinned). No migration: everything is the JSON tenant config.
import { describe, expect, it } from 'vitest'
import { parseConfig, gremionConfigSchema, configUpdateSchema } from '$lib/server/config'
import {
  financeRoleLabelsForTenant,
  DEFAULT_FINANCE_ROLE_LABELS,
  type VocabularyTenant,
} from './role-vocabulary'

const ctxWith = (config: VocabularyTenant['config']): VocabularyTenant => ({ config })

describe('financeRoleLabelsForTenant (config-only finance labels)', () => {
  it('no financeRoles in config → exactly the KV/HV defaults, identity-shared and frozen', () => {
    const labels = financeRoleLabelsForTenant(ctxWith({}))
    expect(labels).toEqual({ kv: 'KV', hv: 'HV' })
    // The default is the SHARED frozen object, not a per-call copy.
    expect(labels).toBe(DEFAULT_FINANCE_ROLE_LABELS)
    expect(Object.isFrozen(DEFAULT_FINANCE_ROLE_LABELS)).toBe(true)
  })

  it('a config.financeRoles override is respected verbatim', () => {
    const labels = financeRoleLabelsForTenant(
      ctxWith({ financeRoles: { kv: 'Kassenwart', hv: 'Hauptverantwortung' } }),
    )
    expect(labels).toEqual({ kv: 'Kassenwart', hv: 'Hauptverantwortung' })
  })

  it('only an ABSENT key means default (?? — an explicit override wins even when falsy-ish)', () => {
    // Mirrors the roleVocabularyForTenant `??` convention: `??` deliberately
    // catches only an ABSENT override — a present object replaces the whole
    // value, even if its labels are empty strings.
    const labels = financeRoleLabelsForTenant(ctxWith({ financeRoles: { kv: '', hv: '' } }))
    expect(labels).toEqual({ kv: '', hv: '' })
    expect(labels).not.toBe(DEFAULT_FINANCE_ROLE_LABELS)
  })

  it('a null/undefined ctx resolves to the frozen default without throwing', () => {
    expect(financeRoleLabelsForTenant(undefined)).toBe(DEFAULT_FINANCE_ROLE_LABELS)
    expect(financeRoleLabelsForTenant(null)).toBe(DEFAULT_FINANCE_ROLE_LABELS)
  })
})

describe('config.financeRoles — optional zod object (absent everywhere today)', () => {
  it('gremionConfigSchema accepts an optional {kv, hv} label pair', () => {
    const parsed = gremionConfigSchema.safeParse({
      financeRoles: { kv: 'Kassenwart', hv: 'Hauptverantwortung' },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.financeRoles).toEqual({ kv: 'Kassenwart', hv: 'Hauptverantwortung' })
  })

  it('gremionConfigSchema rejects malformed label pairs (whole-value: BOTH keys required)', () => {
    expect(gremionConfigSchema.safeParse({ financeRoles: { kv: 'Kassenwart' } }).success).toBe(false)
    expect(gremionConfigSchema.safeParse({ financeRoles: { kv: 1, hv: 2 } }).success).toBe(false)
    expect(gremionConfigSchema.safeParse({ financeRoles: 'KV' }).success).toBe(false)
  })

  it('configUpdateSchema (strict) knows the financeRoles key', () => {
    expect(
      configUpdateSchema.safeParse({ financeRoles: { kv: 'KV', hv: 'HV' } }).success,
    ).toBe(true)
  })

  it('parse pin: the default config carries NO financeRoles key', () => {
    const cfg = parseConfig({})
    expect('financeRoles' in cfg).toBe(false)
    expect(cfg.financeRoles).toBeUndefined()
  })
})
