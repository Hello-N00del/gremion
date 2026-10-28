// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the files module's erasure hook. The module has no
// database: the subject's data is the Nextcloud account (id = Keycloak id, see
// provisionOidcUser) and its personal files. The hook deletes the account through
// the module's existing admin client. Group-folder content (the council's shared
// files) is not owned by the account and stays.
import { describe, expect, it, vi } from 'vitest'
import { createFilesErasureHook } from './erasure'

const ctx = { tenantId: 't', subjectId: 'kc-1', subject: { id: 'kc-1', username: 'jdoe', email: null }, db: null }

describe('filesErasureHook', () => {
  it('needs no database connection', () => {
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser: vi.fn() }) })
    expect(hook.moduleId).toBe('files')
    expect(hook.requiresConnection).toBe(false)
  })

  it('deletes the subject Nextcloud account and reports it', async () => {
    const deleteUser = vi.fn().mockResolvedValue(true)
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }) })
    const res = await hook.erase(ctx)
    expect(deleteUser).toHaveBeenCalledWith('kc-1')
    expect(res).toEqual({ status: 'erased', counts: { nextcloud_accounts: 1 } })
  })

  it('account already gone: still erased, count 0 (idempotent re-run)', async () => {
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser: vi.fn().mockResolvedValue(false) }) })
    expect(await hook.erase(ctx)).toEqual({
      status: 'erased',
      counts: { nextcloud_accounts: 0 },
    })
  })

  it('Nextcloud failure is not swallowed (the orchestrator reports failed)', async () => {
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser: vi.fn().mockRejectedValue(new Error('Nextcloud 500')) }) })
    await expect(hook.erase(ctx)).rejects.toThrow('Nextcloud 500')
  })

  it('no admin password configured: skipped with the reason, Nextcloud is not called', async () => {
    const deleteUser = vi.fn()
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }), adminConfigured: () => false })
    const res = await hook.erase(ctx)
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
    expect(deleteUser).not.toHaveBeenCalled()
  })
})

describe('the hook acts on a VERIFIED subject only (R33f HIGH)', () => {
  it('no verified identity in the context: skipped, the shared Nextcloud is never called', async () => {
    const deleteUser = vi.fn()
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }) })
    const res = await hook.erase({ tenantId: 't', subjectId: 'kc-OTHER-TENANT', db: null })
    expect(res.status).toBe('skipped')
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('a context whose verified identity is a different id than subjectId: skipped, not called', async () => {
    const deleteUser = vi.fn()
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }) })
    const res = await hook.erase({ ...ctx, subjectId: 'kc-2' })
    expect(res.status).toBe('skipped')
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('planted tenant evidence for a foreign id (no realm account, username null): skipped, the shared Nextcloud is never called', async () => {
    // An IT admin can plant an org_unit_members row for any id; evidence in the tenant database
    // proves the tenant holds data of the id, NOT that the id owns the tenant's Nextcloud account.
    const deleteUser = vi.fn()
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }) })
    const res = await hook.erase({ tenantId: 't', subjectId: 'kc-FOREIGN', subject: { id: 'kc-FOREIGN', username: null, email: null }, db: null })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/realm/)
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('deletes the id of the verified identity', async () => {
    const deleteUser = vi.fn().mockResolvedValue(true)
    const hook = createFilesErasureHook({ nc: () => ({ deleteUser }) })
    await hook.erase(ctx)
    expect(deleteUser).toHaveBeenCalledWith('kc-1')
  })
})
