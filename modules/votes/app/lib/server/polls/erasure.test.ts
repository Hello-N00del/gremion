// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the votes module's erasure hook. The votes module owns
// no table: quick polls live in Nextcloud Polls, attributed to the voter's
// Nextcloud account (the account id is the Keycloak id), and Helios ballots are
// the elections module's concern. The hook therefore deletes the subject's
// Nextcloud account through the admin credential the polls client already uses;
// Polls drops its per-account rows on Nextcloud's user-deleted event. Poll
// definitions and tallies owned by other people are not touched.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVotesErasureHook, deleteNextcloudAccount } from './erasure'

afterEach(() => vi.unstubAllGlobals())

describe('votesErasureHook', () => {
  it('needs no database connection and is registered under the module id', () => {
    const hook = createVotesErasureHook({ deleteAccount: vi.fn() })
    expect(hook.moduleId).toBe('votes')
    expect(hook.requiresConnection).toBe(false)
  })

  it('deletes the subject account and reports it', async () => {
    const deleteAccount = vi.fn().mockResolvedValue(true)
    const hook = createVotesErasureHook({ deleteAccount })
    expect(await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).toEqual({
      status: 'erased',
      counts: { nextcloud_accounts: 1 },
    })
    expect(deleteAccount).toHaveBeenCalledWith('kc-1')
  })

  it('account already gone: erased with count 0 (idempotent)', async () => {
    const hook = createVotesErasureHook({ deleteAccount: vi.fn().mockResolvedValue(false) })
    expect(await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).toEqual({
      status: 'erased',
      counts: { nextcloud_accounts: 0 },
    })
  })

  it('without an admin credential: skipped with the reason, nothing is called', async () => {
    const deleteAccount = vi.fn()
    const hook = createVotesErasureHook({ deleteAccount, adminConfigured: () => false })
    const res = await hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('a Nextcloud failure propagates (the orchestrator reports failed)', async () => {
    const hook = createVotesErasureHook({ deleteAccount: vi.fn().mockRejectedValue(new Error('Nextcloud 500')) })
    await expect(hook.erase({ tenantId: 't', subjectId: 'kc-1', db: null })).rejects.toThrow('Nextcloud 500')
  })
})

describe('deleteNextcloudAccount', () => {
  const cfg = { baseUrl: 'http://nc/', adminUser: 'admin', adminPassword: 'pw' }

  it('DELETEs the OCS v2 user endpoint with admin Basic auth', async () => {
    const calls: { url: string; method: string; auth: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method), auth: (init.headers as Record<string, string>).Authorization })
      return new Response('{}', { status: 200 })
    })
    expect(await deleteNextcloudAccount('kc/1', cfg)).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('http://nc/ocs/v2.php/cloud/users/kc%2F1?format=json')
    expect(calls[0].auth).toBe('Basic ' + Buffer.from('admin:pw').toString('base64'))
  })

  it('404 is "already gone"; any other status throws', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    expect(await deleteNextcloudAccount('u', cfg)).toBe(false)
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }))
    await expect(deleteNextcloudAccount('u', cfg)).rejects.toThrow(/500/)
  })

  it('refuses the admin account and an empty id without calling Nextcloud', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(deleteNextcloudAccount('admin', cfg)).rejects.toThrow(/admin/)
    await expect(deleteNextcloudAccount(' ', cfg)).rejects.toThrow(/empty/)
    expect(f).not.toHaveBeenCalled()
  })
})
