import { it, expect, vi } from 'vitest'

vi.mock('$lib/server/governance/org-units-db', () => ({
  updateOrgUnit: vi.fn(async (_id: string, p: { childTerm?: string }) => ({ id: '00000000-0000-4000-8000-0000000000a1', child_term: p.childTerm ?? null })),
}))

import { PATCH } from './+server'
import { updateOrgUnit } from '$lib/server/governance/org-units-db'

const adminLocals = { user: { id: 'u1', roles: ['council-admin'] } } as any

it('updates child_term for an admin', async () => {
  const req = new Request('http://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ childTerm: 'Arbeitsgruppen' }) })
  const res = await PATCH({ params: { id: '00000000-0000-4000-8000-0000000000a1' }, request: req, locals: adminLocals } as any)
  expect(res.status).toBe(200)
  expect(updateOrgUnit).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000a1', { childTerm: 'Arbeitsgruppen' })
})

it("normalizes '' to NULL — clearing the field reverts to the catalog default", async () => {
  const req = new Request('http://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ childTerm: '' }) })
  const res = await PATCH({ params: { id: '00000000-0000-4000-8000-0000000000a1' }, request: req, locals: adminLocals } as any)
  expect(res.status).toBe(200)
  expect(updateOrgUnit).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000a1', { childTerm: null })
})

it('rejects a non-admin with 403', async () => {
  const req = new Request('http://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ childTerm: 'X' }) })
  const locals = { user: { id: 'u2', roles: ['member'] } } as any
  await expect(PATCH({ params: { id: '00000000-0000-4000-8000-0000000000a1' }, request: req, locals } as any)).rejects.toMatchObject({ status: 403 })
})
