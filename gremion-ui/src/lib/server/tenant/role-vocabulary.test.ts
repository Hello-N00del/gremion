// P2.2-auth A1 (D-VOCAB) — per-tenant role-vocabulary seam.
// The vocabulary is a SEAM, not new storage: default = Object.values(Role)
// for EVERY tenant today (byte-identical), with an OPTIONAL `config.roles`
// override (zod-validated, absent everywhere in existing configs — pinned).
import { describe, expect, it } from 'vitest'
import { Role } from '$lib/auth/types'
import { parseConfig, gremionConfigSchema, configUpdateSchema } from '$lib/server/config'
import {
  roleVocabularyForTenant,
  DEFAULT_ROLE_VOCABULARY,
  type VocabularyTenant,
} from './role-vocabulary'

const ctxWith = (config: VocabularyTenant['config']): VocabularyTenant => ({ config })

describe('roleVocabularyForTenant (D-VOCAB seam)', () => {
  it('default = the Role enum values, byte-identical to Object.values(Role)', () => {
    expect(roleVocabularyForTenant(ctxWith({}))).toEqual(Object.values(Role))
  })

  it('the exported default vocabulary IS Object.values(Role) (golden pin)', () => {
    // Governance-only kernel Role enum: the finance + auditor roles were carved
    // out with the finance module, so the default vocabulary is the four
    // governance roles.
    expect(DEFAULT_ROLE_VOCABULARY).toEqual([
      'guest',
      'member',
      'council-admin',
      'it-admin',
    ])
    expect(Object.isFrozen(DEFAULT_ROLE_VOCABULARY)).toBe(true)
  })

  it('a config.roles override is respected verbatim', () => {
    const vocab = roleVocabularyForTenant(
      ctxWith({ roles: ['guest', 'member', 'buergermeister'] }),
    )
    expect(vocab).toEqual(['guest', 'member', 'buergermeister'])
  })

  it('an explicit empty override narrows to the empty vocabulary (?? only catches absent)', () => {
    expect(roleVocabularyForTenant(ctxWith({ roles: [] }))).toEqual([])
  })
})

describe('config.roles — optional zod array (absent everywhere today)', () => {
  it('gremionConfigSchema accepts an optional string array', () => {
    const parsed = gremionConfigSchema.safeParse({ roles: ['guest', 'mayor'] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.roles).toEqual(['guest', 'mayor'])
  })

  it('gremionConfigSchema rejects non-string vocabularies', () => {
    expect(gremionConfigSchema.safeParse({ roles: [1, 2] }).success).toBe(false)
    expect(gremionConfigSchema.safeParse({ roles: 'guest' }).success).toBe(false)
  })

  it('configUpdateSchema (strict) knows the roles key', () => {
    expect(configUpdateSchema.safeParse({ roles: ['guest'] }).success).toBe(true)
  })

  it('parse pin: the default config carries NO roles key', () => {
    const cfg = parseConfig({})
    expect('roles' in cfg).toBe(false)
    expect(cfg.roles).toBeUndefined()
  })

  // Carve note: the verein example vertical (examples/verticals/verein) was
  // removed with the demo verticals, so the committed-example parse pin is gone.
  // The "default config carries no roles key" pin above keeps the absent-by-
  // default invariant covered.
})
