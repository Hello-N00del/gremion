// The host program (infra/host/bin/gremion-migration-dump) writes the ledger
// scope of a gate database itself. This test feeds scopeOf the same fixture
// names that test/host/migration-dump.bats feeds the host program, so the two
// cannot drift apart: a parity name must come out equal, and every other name
// is the recorded deviation (scopeOf refuses it or, for the kernel module,
// answers customer, while the host program keeps scope platform).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scopeOf } from './hook.js'

interface ScopeCase {
  database: string
  parity: boolean
  scope: 'customer' | 'platform'
  customer_id: string | null
  module_id: string | null
}

const FIXTURE = fileURLToPath(new URL('../../../../test/host/fixtures/cd/dump-options/scope-names.json', import.meta.url))
const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: ScopeCase[] }).cases

describe('host program scope parity with scopeOf', () => {
  it('the fixture holds parity names and deviation names', () => {
    expect(cases.some((c) => c.parity)).toBe(true)
    expect(cases.some((c) => !c.parity)).toBe(true)
  })

  for (const c of cases.filter((x) => x.parity)) {
    it(`agrees on ${c.database}`, () => {
      expect(scopeOf(c.database)).toEqual({ scope: c.scope, customerId: c.customer_id, moduleId: c.module_id })
    })
  }

  for (const c of cases.filter((x) => !x.parity)) {
    it(`is a recorded deviation: ${c.database}`, () => {
      // The host program keeps platform with null ids for this name.
      expect(c.scope).toBe('platform')
      if (c.database.endsWith('__kernel')) {
        expect(scopeOf(c.database).scope).toBe('customer')
        expect(scopeOf(c.database).moduleId).toBe('kernel')
      } else {
        expect(() => scopeOf(c.database)).toThrow(/DUMP_SCOPE/)
      }
    })
  }
})
