// @vitest-environment node
// Module Karenz (phase 2): the vault module declares that it seals no retained records, into the kernel's
// REAL retention registry (the registration is the behaviour under test).
import { describe, expect, it } from 'vitest'

await import('./register.server')

describe('vault register.server', () => {
  it('declares that the vault seals no retained records (otherwise its retained step fails closed)', async () => {
    const { hasRetentionDeclaration, extractorsFor } = await import('$lib/server/module-karenz/retained/extractors')
    expect(hasRetentionDeclaration('vault')).toBe(true)
    expect(extractorsFor('vault')).toEqual([])
  })
})
