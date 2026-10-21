// TASK-044 (brief Q6, section 9): what lets the TASK-043 running proof create a
// customer WITH modules through the real level-1 gate instead of an allow gate.
//  - parseDpiaMap: the create request's per-module DPIA decisions (--dpia-json)
//  - scratchFixturesAllowed: scratch-fixture evidence is accepted only on a
//    stack-qualified scratch platform database named by the same stack
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDpiaMap, scratchFixturesAllowed } from '../../../../../scripts/tenant-provision-scratch'

const URL_OK = 'postgresql://gremion_platform:pw@postgres-t043-0123abcd:5432/gremion_platform'

describe('scratchFixturesAllowed', () => {
  it('is false when the opt-in is unset or empty', () => {
    expect(scratchFixturesAllowed(undefined, URL_OK)).toBe(false)
    expect(scratchFixturesAllowed('', URL_OK)).toBe(false)
  })
  it('is true for a scratch stack naming the same stack as the platform host', () => {
    expect(scratchFixturesAllowed('t043-0123abcd', URL_OK)).toBe(true)
  })
  it('is false when the named stack is not the platform database host stack', () => {
    expect(scratchFixturesAllowed('t043-ffffffff', URL_OK)).toBe(false)
  })
  it('is false for a production-looking stack name or host, whatever the opt-in', () => {
    expect(scratchFixturesAllowed('prod', 'postgresql://u:p@postgres-prod:5432/gremion_platform')).toBe(false)
    expect(scratchFixturesAllowed('t043-0123abcd', 'postgresql://u:p@postgres:5432/gremion_platform')).toBe(false)
    expect(scratchFixturesAllowed('t043-0123abcd', 'postgresql://u:p@db.example.com:5432/gremion_platform')).toBe(false)
  })
  it('is false for crafted urls where the gate and postgres.js would pick different hosts', () => {
    // new URL() takes the host after the LAST @; postgres.js after the FIRST @ and splits on commas.
    expect(scratchFixturesAllowed('t044-0123abcd', 'postgresql://u:x@evil,y@postgres-t044-0123abcd:5432/db')).toBe(false)
    expect(scratchFixturesAllowed('t044-0123abcd', 'postgresql://u:x@evil:5432,postgres-t044-0123abcd:5432/db')).toBe(false)
    expect(scratchFixturesAllowed('t044-0123abcd', 'postgresql://u:x@postgres-t044-0123abcd:5432,evil:5432/db')).toBe(false)
  })
  it('is false for a unix-socket or host-less url', () => {
    expect(scratchFixturesAllowed('t044-0123abcd', 'postgresql://u:x@/db?host=/var/run/postgresql')).toBe(false)
    expect(scratchFixturesAllowed('t044-0123abcd', 'postgresql:///db')).toBe(false)
  })
  it('is false when the stack is the production stack, even if it looks scratch-shaped', () => {
    expect(scratchFixturesAllowed('t043-0123abcd', URL_OK, 't043-0123abcd')).toBe(false)
    expect(scratchFixturesAllowed('t043-0123abcd', URL_OK, 'gremion')).toBe(true)
    expect(scratchFixturesAllowed('t043-0123abcd', URL_OK, 'none')).toBe(true)
  })
  it('is false for an unparseable url and never throws', () => {
    expect(scratchFixturesAllowed('t043-0123abcd', 'not a url')).toBe(false)
    expect(scratchFixturesAllowed('t043-0123abcd', undefined)).toBe(false)
  })
})

describe('parseDpiaMap', () => {
  const good = { calendar: { requiresDpia: 'no', reasonCodes: ['no_personal_data_beyond_account'], documentRef: 'TOM-annex-7' } }
  it('returns the module -> decision map', () => {
    expect(parseDpiaMap(JSON.stringify(good))).toEqual(good)
  })
  it('refuses non-JSON, arrays, null and non-object entries by name', () => {
    expect(() => parseDpiaMap('{')).toThrow(/not JSON/)
    expect(() => parseDpiaMap('[]')).toThrow(/object/)
    expect(() => parseDpiaMap('null')).toThrow(/object/)
    expect(() => parseDpiaMap(JSON.stringify({ calendar: 'no' }))).toThrow(/calendar/)
  })
  it('defaults missing reasonCodes to an empty list (the library validates the rest)', () => {
    expect(parseDpiaMap(JSON.stringify({ votes: { requiresDpia: 'yes', documentRef: 'x' } }))).toEqual({ votes: { requiresDpia: 'yes', reasonCodes: [], documentRef: 'x' } })
  })
})

describe('scratch-fixture.sql', () => {
  it('writes the exact evidence prefix the gate recognises (FIXTURE_EVIDENCE_PREFIX) and only cross_customer passes', async () => {
    const { FIXTURE_EVIDENCE_PREFIX } = await import('@gremion/tenant-store/lifecycle')
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'test', 'host', 'fixtures', 'customer-provision', 'scratch-fixture.sql'), 'utf-8')
    expect(sql).toContain(`'${FIXTURE_EVIDENCE_PREFIX} `)
    expect(sql).toContain("'cross_customer', true")
    expect(sql).not.toMatch(/cross_body/)
  })
})
