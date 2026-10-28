// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the messaging module's erasure hook. Chat data lives in
// Synapse, not in the kernel database. The hook uses the module's Synapse admin
// client to deactivate the subject's Matrix account WITH the erase flag (display
// name, avatar and third-party ids are removed; the account can never log in
// again). The Matrix localpart is the Keycloak username, so the hook resolves it
// from the Keycloak account first; when that account is already gone the Matrix
// id can no longer be derived and the module reports `skipped`, never `erased`.
import { describe, expect, it, vi, type Mock } from 'vitest'
import { createMessagingErasureHook } from './erasure'

type EraseUser = (localpart: string) => Promise<boolean>
type ResolveLocalpart = (subjectId: string) => Promise<string | null>

function hook(over: { localpart?: string | null; eraseUser?: Mock<EraseUser> }) {
  const eraseUser = over.eraseUser ?? vi.fn<EraseUser>().mockResolvedValue(true)
  const resolveLocalpart = vi.fn<ResolveLocalpart>().mockResolvedValue(over.localpart === undefined ? 'jdoe' : over.localpart)
  return { h: createMessagingErasureHook({ resolveLocalpart, synapse: () => ({ eraseUser }) }), eraseUser, resolveLocalpart }
}

describe('messagingErasureHook', () => {
  it('needs no database connection', () => {
    const { h } = hook({})
    expect(h.moduleId).toBe('messaging')
    expect(h.requiresConnection).toBe(false)
  })

  it('resolves the Matrix localpart from the subject id and erases that account', async () => {
    const { h, eraseUser, resolveLocalpart } = hook({})
    const res = await h.erase({ tenantId: 't', subjectId: 'kc-1', db: null })
    expect(resolveLocalpart).toHaveBeenCalledWith('kc-1')
    expect(eraseUser).toHaveBeenCalledWith('jdoe')
    expect(res).toEqual({ status: 'erased', counts: { matrix_accounts: 1 } })
  })

  it('no Matrix account (Synapse does not know it): erased with count 0, idempotent', async () => {
    const { h } = hook({ eraseUser: vi.fn<EraseUser>().mockResolvedValue(false) })
    expect(await h.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).toEqual({
      status: 'erased',
      counts: { matrix_accounts: 0 },
    })
  })

  it('Keycloak account already gone: skipped with a precise reason, Synapse is not called', async () => {
    const { h, eraseUser } = hook({ localpart: null })
    const res = await h.erase({ tenantId: 't', subjectId: 'kc-1', db: null })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/Keycloak account .* Matrix localpart/i)
    expect(eraseUser).not.toHaveBeenCalled()
  })

  it('a Synapse failure propagates (the orchestrator reports failed)', async () => {
    const { h } = hook({ eraseUser: vi.fn<EraseUser>().mockRejectedValue(new Error('Synapse 502')) })
    await expect(h.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).rejects.toThrow('Synapse 502')
  })
})
