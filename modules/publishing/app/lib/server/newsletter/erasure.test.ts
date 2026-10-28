// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the publishing (newsletter) module's erasure hook. The
// newsletter data lives in the newsletter leaf's own database; the kernel reaches
// it only through the backend port. The subscription is keyed by e-mail address,
// so the hook resolves the subject's address from the Keycloak account and
// removes every mailing-list membership carrying it. If that account no longer
// exists the address cannot be derived and the module reports `skipped`.
import { describe, expect, it, vi } from 'vitest'
import type { MailingList, MailingListMember } from './backend/port'
import { createPublishingErasureHook } from './erasure'

const list = (id: number): MailingList => ({ id, name: `L${id}`, created_at: '2026-01-01' })
const member = (id: number, list_id: number, email: string): MailingListMember => ({
  id,
  list_id,
  email,
  name: null,
  source: 'manual',
  created_at: '2026-01-01',
})

function setup(members: Record<number, MailingListMember[]>, email: string | null = 'Anna.Muster@example.org') {
  const deleteMember = vi.fn().mockResolvedValue(undefined)
  const backend = {
    listMailingLists: vi.fn().mockResolvedValue(Object.keys(members).map((k) => list(Number(k)))),
    listMembers: vi.fn(async (listId: number) => members[listId] ?? []),
    deleteMember,
  }
  const hook = createPublishingErasureHook({ resolveEmail: vi.fn().mockResolvedValue(email), backend: () => backend })
  return { hook, backend, deleteMember }
}

describe('publishingErasureHook', () => {
  it('needs no database connection and is registered under the module id', () => {
    expect(setup({}).hook.moduleId).toBe('publishing')
    expect(setup({}).hook.requiresConnection).toBe(false)
  })

  it('removes the subject from every list, matching the address case-insensitively, and nobody else', async () => {
    const { hook, deleteMember } = setup({
      1: [member(10, 1, 'anna.muster@EXAMPLE.org'), member(11, 1, 'other@example.org')],
      2: [member(20, 2, ' Anna.Muster@example.org ')],
      3: [member(30, 3, 'third@example.org')],
    })
    const res = await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })
    expect(res).toEqual({ status: 'erased', counts: { mailing_list_members: 2 } })
    expect(deleteMember.mock.calls).toEqual([
      [1, 10],
      [2, 20],
    ])
  })

  it('not on any list: erased with count 0 (idempotent re-run)', async () => {
    const { hook, deleteMember } = setup({ 1: [member(11, 1, 'other@example.org')] })
    expect(await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).toEqual({
      status: 'erased',
      counts: { mailing_list_members: 0 },
    })
    expect(deleteMember).not.toHaveBeenCalled()
  })

  it('Keycloak account gone: skipped with a precise reason, the newsletter service is not called', async () => {
    const { hook, backend } = setup({ 1: [member(10, 1, 'a@b.c')] }, null)
    const res = await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/Keycloak account .* e-mail address/i)
    expect(backend.listMailingLists).not.toHaveBeenCalled()
  })

  it('account without an e-mail address: nothing can be on a list, erased with count 0', async () => {
    const { hook, backend } = setup({ 1: [member(10, 1, '')] }, '')
    expect(await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).toEqual({
      status: 'erased',
      counts: { mailing_list_members: 0 },
    })
    expect(backend.listMailingLists).not.toHaveBeenCalled()
  })

  it('a newsletter service failure propagates (the orchestrator reports failed)', async () => {
    const backend = {
      listMailingLists: vi.fn().mockRejectedValue(new Error('Leaf returned 503')),
      listMembers: vi.fn(),
      deleteMember: vi.fn(),
    }
    const hook = createPublishingErasureHook({ resolveEmail: async () => 'a@b.c', backend: () => backend })
    await expect(hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).rejects.toThrow('503')
  })
})
