// What the panel knows about the creation order of a customer: whether
// `gremion-services wire` has run for it. The host writes the mark into the
// customer's registry row (domain_profile.servicesWiredAt); a customer wired
// before that mark existed is recognised by the smtp entry the same step wrote
// under the relay transport. The control database is faked by SQL text: nothing
// here opens a connection.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelConfig } from '$lib/server/config'

let queries: string[] = []
let rows: { wired: boolean }[] = []
let failure: unknown = null
const fakeSql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
  queries.push(strings.join('?') + ' :: ' + JSON.stringify(vals))
  if (failure) throw failure
  return rows
}
vi.mock('$lib/server/customers', () => ({ controlDb: () => fakeSql }))

const { servicesWired, WIRING_ORDER_WARNING } = await import('./wiring')
const CONFIG = {} as PanelConfig

afterEach(() => {
  queries = []
  rows = []
  failure = null
  vi.restoreAllMocks()
})

describe('servicesWired', () => {
  it('a registry row that says wired is wired', async () => {
    rows = [{ wired: true }]
    expect(await servicesWired(CONFIG, 'proof-z')).toBe(true)
  })
  it('a registry row without the mark is NOT wired', async () => {
    rows = [{ wired: false }]
    expect(await servicesWired(CONFIG, 'proof-z')).toBe(false)
  })
  it('no registry row: unknown, not "not wired" (nothing is claimed about a customer the panel cannot see)', async () => {
    rows = []
    expect(await servicesWired(CONFIG, 'proof-z')).toBeNull()
  })
  it('an unreadable registry is unknown, and the log has the cause (name and SQLSTATE only)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' })
    expect(await servicesWired(CONFIG, 'proof-z')).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    const line = String(spy.mock.calls[0]![0])
    expect(line).toContain('proof-z')
    expect(line).toContain('ECONNREFUSED')
    expect(line).not.toContain('10.0.0.1')
  })
  it('the customer is a bound value, and only the two marks are read: never the relay settings that share the column', async () => {
    rows = [{ wired: true }]
    await servicesWired(CONFIG, 'proof-z')
    expect(queries).toHaveLength(1)
    const [text, vals] = queries[0]!.split(' :: ') as [string, string]
    expect(vals).toBe('["proof-z"]')
    expect(text).toContain('servicesWiredAt')
    expect(text).toContain('smtp')
    expect(text).not.toMatch(/SELECT\s+domain_profile\b/i)
    expect(text).not.toContain('proof-z')
  })
})

describe('the warning for a vertical seeded before the wiring', () => {
  it('names the order (create, wire, seed) and that the seed is still queued', () => {
    expect(WIRING_ORDER_WARNING).toMatch(/anlegen/)
    expect(WIRING_ORDER_WARNING).toMatch(/verbinden/)
    expect(WIRING_ORDER_WARNING).toMatch(/einspielen/)
    expect(WIRING_ORDER_WARNING.indexOf('anlegen')).toBeLessThan(WIRING_ORDER_WARNING.indexOf('verbinden'))
    expect(WIRING_ORDER_WARNING.indexOf('verbinden')).toBeLessThan(WIRING_ORDER_WARNING.indexOf('einspielen'))
    expect(WIRING_ORDER_WARNING).toMatch(/wire/)
  })
})
