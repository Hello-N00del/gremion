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
const fixture: { cases: ScopeCase[] } = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const cases = fixture.cases

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

  const kernelCases = cases.filter((x) => !x.parity && x.database.endsWith('__kernel'))
  const refusedCases = cases.filter((x) => !x.parity && !x.database.endsWith('__kernel'))

  for (const c of kernelCases) {
    it(`is a recorded deviation (scopeOf says customer, the host keeps platform): ${c.database}`, () => {
      expect(c.scope).toBe('platform')
      expect(scopeOf(c.database)).toMatchObject({ scope: 'customer', moduleId: 'kernel' })
    })
  }

  for (const c of refusedCases) {
    it(`is a recorded deviation (scopeOf refuses it, the host keeps platform): ${c.database}`, () => {
      expect(c.scope).toBe('platform')
      expect(() => scopeOf(c.database)).toThrow(/DUMP_SCOPE/)
    })
  }
})
