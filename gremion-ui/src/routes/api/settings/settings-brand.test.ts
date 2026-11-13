// @vitest-environment node
//
// PATCH /api/settings: the IT admin sets the two semester start months of the
// customer (brand.term_months) — the only brand field this endpoint takes.
// The semester label itself is computed from them at read time and never stored.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeConfig: vi.fn(), readConfig: vi.fn() }))

vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig, writeConfig: h.writeConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

import { PATCH } from './+server'

function patch(body: unknown) {
  const request = new Request('http://localhost/api/settings', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals: { auth: async () => ({ user: { id: 'u', roles: ['it-admin'] } }) } })
}

beforeEach(() => {
  h.writeConfig.mockReset()
  h.writeConfig.mockReturnValue({})
  h.readConfig.mockReturnValue({})
})

describe('PATCH /api/settings brand.term_months', () => {
  it('writes two different whole months 1 to 12', async () => {
    const res = await patch({ brand: { term_months: { winter: 10, summer: 4 } } })
    expect(res.status).toBe(200)
    expect(h.writeConfig).toHaveBeenCalledWith({ brand: { term_months: { winter: 10, summer: 4 } } })
  })

  it.each([
    ['equal months', { winter: 4, summer: 4 }],
    ['month 0', { winter: 0, summer: 4 }],
    ['month 13', { winter: 10, summer: 13 }],
    ['a fraction', { winter: 10.5, summer: 4 }],
    ['a string', { winter: '10', summer: 4 }],
    ['one month only', { winter: 10 }],
    ['an extra key', { winter: 10, summer: 4, label: 'WiSe 99/00' }],
  ])('422 for %s, nothing is written', async (_name, term_months) => {
    const res = await patch({ brand: { term_months } })
    expect(res.status).toBe(422)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('no other brand field is writable here (product, org_short and the stored label are refused)', async () => {
    for (const brand of [{ product: 'X' }, { org_short: 'X' }, { term: 'SoSe 99' }]) {
      const res = await patch({ brand })
      expect(res.status, JSON.stringify(brand)).toBe(422)
    }
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('a name-only save carries no brand key, so it cannot touch the months', async () => {
    const res = await patch({ org: { name: 'Studierendenrat', domain: 'x.example.org', logo_path: null } })
    expect(res.status).toBe(200)
    expect(Object.keys(h.writeConfig.mock.calls[0]![0])).toEqual(['org'])
  })
})
