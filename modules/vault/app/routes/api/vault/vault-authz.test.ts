import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors src/routes/api/board/board-read.test.ts: mock the org-unit scope
// resolver + the resolved vault leaf backend, then drive the real route handlers.
//
// The vault is a SECRETS store: the reveal endpoint (GET /api/vault/[id]/secret)
// must NEVER return a secret body to a member whose org-unit scope excludes the
// item — the 403 has to fire BEFORE any revealSecret leaf call. A scoped member's
// reveal must forward the acting user's id (the leaf turns that into an
// x-vault-user-id header for reveal-audit). Create/update/delete are scope-gated
// the same way; update ALSO gates the TARGET org-unit when moving an item.
//
// #405 (design v11): the reveal is additionally STEP-UP gated (default ON) —
// only a session with a fresh LoA 2 gets a ciphertext. vault-flags reads
// $env/dynamic/private at call-time, so a mutable mockEnv drives the flag.

const { vaultClient, mockEnv } = vi.hoisted(() => ({
  vaultClient: {
    getItem: vi.fn(),
    revealSecret: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    listItemsForOrgUnits: vi.fn(),
    listAccessLog: vi.fn(),
  },
  mockEnv: {} as Record<string, string | undefined>,
}))

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }))
vi.mock('$lib/server/vault/scope', () => ({
  resolveVaultOrgUnitScope: vi.fn(async () => ['ou-1']),
}))
vi.mock('$lib/server/vault/backend/resolve', () => ({
  resolveVaultBackendOr503: () => vaultClient,
  resolveVaultBackendForPage: () => vaultClient,
}))

import { POST as createItem } from './+server'
import { PUT as updateItem, DELETE as deleteItem } from './[id]/+server'
import { GET as revealSecret } from './[id]/secret/+server'
import { GET as readAccessLog } from './access-log/+server'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'

// Step-up-enforced routes read user.loa + user.authTime (epoch seconds); a
// FRESH LoA 2 session is the baseline actor so the default-ON gate passes.
const freshAuthTime = () => Math.floor(Date.now() / 1000)
const makeLocals = (user: Record<string, unknown>) => ({ auth: async () => ({ user }) }) as any
// vault_item.id is a UUID column (services/vault/migrations/001_init.sql) and
// the route now rejects a malformed id with 400 before touching the backend
// (#449), so these fixtures must be well-formed UUIDs rather than short tags.
const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const MISSING_ID = '22222222-2222-4222-8222-222222222222'

const member = makeLocals({ id: 'u1', roles: ['member'], loa: 2, authTime: freshAuthTime() })

const ITEM = {
  id: ITEM_ID,
  org_unit_id: 'ou-1',
  name: 'DB-Zugang',
  username: 'admin',
  url: null,
  notes: null,
  created_by: 'u1',
  created_at: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  delete mockEnv.VAULT_REVEAL_REQUIRE_STEPUP
  delete mockEnv.STEPUP_FRESHNESS_SECONDS
  ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1'])
  vaultClient.getItem.mockResolvedValue(ITEM)
  vaultClient.revealSecret.mockResolvedValue({ secret: 's3cr3t' })
  vaultClient.createItem.mockImplementation(async (d: any) => ({ id: 'v2', created_at: new Date(), ...d }))
  vaultClient.updateItem.mockImplementation(async (_id: string, d: any) => ({ ...ITEM, ...d }))
  vaultClient.deleteItem.mockResolvedValue(true)
  vaultClient.listAccessLog.mockResolvedValue([])
})

describe('vault authz — reveal secret (org-unit scoped)', () => {
  it('403s the reveal for a member whose scope excludes the item org-unit — and NEVER calls the secret leaf', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    await expect(revealSecret({ params: { id: ITEM_ID }, locals: member } as any)).rejects.toMatchObject({
      status: 403,
    })
    // The out-of-scope member must never reach the reveal call → no secret body can leak.
    expect(vaultClient.revealSecret).not.toHaveBeenCalled()
  })

  it('forwards the acting user id (→ x-vault-user-id) to the leaf and returns the secret for a scoped member', async () => {
    const res = await revealSecret({ params: { id: ITEM_ID }, locals: member } as any)
    const body = await res.json()
    expect(body.data.secret).toBe('s3cr3t')
    // The reveal call must carry user.id so the leaf can audit WHO revealed it.
    expect(vaultClient.revealSecret).toHaveBeenCalledWith(ITEM_ID, 'u1')
  })

  it('404s the reveal for a missing item (before any scope/secret work)', async () => {
    vaultClient.getItem.mockResolvedValueOnce(null)
    await expect(revealSecret({ params: { id: MISSING_ID }, locals: member } as any)).rejects.toMatchObject({
      status: 404,
    })
    expect(vaultClient.revealSecret).not.toHaveBeenCalled()
  })
})

describe('vault reveal — step-up gate on ciphertext delivery (#405, default ON)', () => {
  it('401s STEP_UP_REQUIRED for LoA 1 with the flag UNSET (default ON) — and never touches the leaf', async () => {
    const loa1 = makeLocals({ id: 'u1', roles: ['member'], loa: 1, authTime: freshAuthTime() })
    const res = await revealSecret({ params: { id: ITEM_ID }, locals: loa1 } as any)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
    expect(vaultClient.getItem).not.toHaveBeenCalled()
    expect(vaultClient.revealSecret).not.toHaveBeenCalled()
  })

  it('401s STEP_UP_REQUIRED for a STALE LoA 2 (older than the freshness window)', async () => {
    const stale = makeLocals({
      id: 'u1', roles: ['member'], loa: 2,
      authTime: freshAuthTime() - 3600, // 1h old > 300s window
    })
    const res = await revealSecret({ params: { id: ITEM_ID }, locals: stale } as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('STEP_UP_REQUIRED')
    expect(vaultClient.revealSecret).not.toHaveBeenCalled()
  })

  it('reveals for a fresh LoA 2 while enforced', async () => {
    const res = await revealSecret({ params: { id: ITEM_ID }, locals: member } as any)
    expect((await res.json()).data.secret).toBe('s3cr3t')
  })

  it('skips the gate when VAULT_REVEAL_REQUIRE_STEPUP=false (explicit opt-out)', async () => {
    mockEnv.VAULT_REVEAL_REQUIRE_STEPUP = 'false'
    const loa1 = makeLocals({ id: 'u1', roles: ['member'], loa: 1, authTime: 0 })
    const res = await revealSecret({ params: { id: ITEM_ID }, locals: loa1 } as any)
    expect((await res.json()).data.secret).toBe('s3cr3t')
  })
})

describe('vault authz — create (org-unit scoped)', () => {
  it('403s a create targeting an org-unit outside the member scope', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ orgUnitId: 'ou-1', name: 'X', secret: 's' }),
    })
    await expect(createItem({ request: req, locals: member } as any)).rejects.toMatchObject({ status: 403 })
    expect(vaultClient.createItem).not.toHaveBeenCalled()
  })

  it('creates (201) when the target org-unit is in scope', async () => {
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ orgUnitId: 'ou-1', name: 'X', secret: 's' }),
    })
    const res = await createItem({ request: req, locals: member } as any)
    expect(res.status).toBe(201)
    expect(vaultClient.createItem).toHaveBeenCalled()
  })

  it('400s a create with no name', async () => {
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ orgUnitId: 'ou-1', secret: 's' }),
    })
    await expect(createItem({ request: req, locals: member } as any)).rejects.toMatchObject({ status: 400 })
  })
})

describe('vault authz — update (org-unit scoped, #405)', () => {
  const putReq = (body: unknown) =>
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) })

  it('updates (200) an in-scope item and passes the patch to the leaf', async () => {
    const res = await updateItem({ params: { id: ITEM_ID }, request: putReq({ name: 'Neu' }), locals: member } as any)
    expect(res.status).toBe(200)
    expect((await res.json()).data.name).toBe('Neu')
    expect(vaultClient.updateItem).toHaveBeenCalledWith(ITEM_ID, { name: 'Neu' })
  })

  it('403s an update of an item outside the member scope — leaf never called', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    await expect(
      updateItem({ params: { id: ITEM_ID }, request: putReq({ name: 'Neu' }), locals: member } as any),
    ).rejects.toMatchObject({ status: 403 })
    expect(vaultClient.updateItem).not.toHaveBeenCalled()
  })

  it('403s a MOVE whose target org-unit is outside the member scope', async () => {
    // Scope contains the item's current unit (gate passes) but NOT the target.
    ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1'])
    await expect(
      updateItem({ params: { id: ITEM_ID }, request: putReq({ orgUnitId: 'ou-2' }), locals: member } as any),
    ).rejects.toMatchObject({ status: 403 })
    expect(vaultClient.updateItem).not.toHaveBeenCalled()
  })

  it('moves (200) when the target org-unit IS in scope', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1', 'ou-2'])
    const res = await updateItem({ params: { id: ITEM_ID }, request: putReq({ orgUnitId: 'ou-2' }), locals: member } as any)
    expect(res.status).toBe(200)
    expect(vaultClient.updateItem).toHaveBeenCalledWith(ITEM_ID, { orgUnitId: 'ou-2' })
  })

  it('400s an invalid patch (empty name), validated like create', async () => {
    await expect(
      updateItem({ params: { id: ITEM_ID }, request: putReq({ name: '' }), locals: member } as any),
    ).rejects.toMatchObject({ status: 400 })
    expect(vaultClient.updateItem).not.toHaveBeenCalled()
  })

  it('404s an update of a missing item', async () => {
    vaultClient.getItem.mockResolvedValueOnce(null)
    await expect(
      updateItem({ params: { id: MISSING_ID }, request: putReq({ name: 'X' }), locals: member } as any),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('vault authz — delete (org-unit scoped)', () => {
  it('403s a delete of an item outside the member scope', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    await expect(deleteItem({ params: { id: ITEM_ID }, locals: member } as any)).rejects.toMatchObject({
      status: 403,
    })
    expect(vaultClient.deleteItem).not.toHaveBeenCalled()
  })

  it('deletes (204) an in-scope item', async () => {
    const res = await deleteItem({ params: { id: ITEM_ID }, locals: member } as any)
    expect(res.status).toBe(204)
    expect(vaultClient.deleteItem).toHaveBeenCalledWith(ITEM_ID)
  })
})

describe('vault authz — access log (scope = resolveVaultOrgUnitScope, #405)', () => {
  const get = (query = '') =>
    ({ url: new URL(`http://x/api/vault/access-log${query}`), locals: member }) as any

  it('passes the RESOLVED scope (not caller input) + clamped pagination to the leaf', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1', 'ou-9'])
    const res = await readAccessLog(get('?limit=5&offset=10'))
    expect(res.status).toBe(200)
    expect(vaultClient.listAccessLog).toHaveBeenCalledWith(['ou-1', 'ou-9'], { limit: 5, offset: 10 })
  })

  it('defaults to limit 50 / offset 0 and caps limit at 200', async () => {
    await readAccessLog(get())
    expect(vaultClient.listAccessLog).toHaveBeenCalledWith(['ou-1'], { limit: 50, offset: 0 })
    await readAccessLog(get('?limit=9999'))
    expect(vaultClient.listAccessLog).toHaveBeenLastCalledWith(['ou-1'], { limit: 200, offset: 0 })
  })

  it('403s a non-member (guest)', async () => {
    const guest = makeLocals({ id: 'g1', roles: ['guest'], loa: 1, authTime: freshAuthTime() })
    await expect(readAccessLog({ url: new URL('http://x/api/vault/access-log'), locals: guest } as any))
      .rejects.toMatchObject({ status: 403 })
    expect(vaultClient.listAccessLog).not.toHaveBeenCalled()
  })

  it('returns the leaf rows under { data }', async () => {
    const row = {
      id: 'a1', item_id: ITEM_ID, item_name: 'DB-Zugang',
      org_unit_id: 'ou-1', accessed_by: 'u1', accessed_at: new Date().toISOString(),
    }
    vaultClient.listAccessLog.mockResolvedValueOnce([row])
    const res = await readAccessLog(get())
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].item_name).toBe('DB-Zugang')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #449 — malformed item id
//
// vault_item.id is a UUID column and the leaf interpolates the id straight into
// `WHERE id = ${id}`, so a non-UUID segment raised a Postgres cast error there;
// the leaf mapped it to 500 and the kernel client rethrows anything that is not
// a 404 — so /api/vault/xyz answered "500 Internal Error" for a plainly
// malformed request. The guard must run BEFORE any backend call.
// ─────────────────────────────────────────────────────────────────────────────
describe('#449 malformed vault item id', () => {
  const BAD = ['not-a-uuid', '123', '../etc/passwd', '', '11111111-1111-4111-8111-11111111111']

  it.each(BAD)('reveal of %j → 400, leaf never called', async (bad) => {
    await expect(
      revealSecret({ params: { id: bad }, locals: member } as any),
    ).rejects.toMatchObject({ status: 400 })
    expect(vaultClient.getItem).not.toHaveBeenCalled()
    expect(vaultClient.revealSecret).not.toHaveBeenCalled()
  })

  it('update of a malformed id → 400, leaf never called', async () => {
    await expect(
      updateItem({
        params: { id: 'not-a-uuid' },
        locals: member,
        request: { json: async () => ({ name: 'X' }) },
      } as any),
    ).rejects.toMatchObject({ status: 400 })
    expect(vaultClient.updateItem).not.toHaveBeenCalled()
  })

  it('delete of a malformed id → 400, leaf never called', async () => {
    await expect(
      deleteItem({ params: { id: 'not-a-uuid' }, locals: member } as any),
    ).rejects.toMatchObject({ status: 400 })
    expect(vaultClient.deleteItem).not.toHaveBeenCalled()
  })

  it('a well-formed id still reaches the backend (guard is not over-broad)', async () => {
    await revealSecret({ params: { id: ITEM_ID }, locals: member } as any)
    expect(vaultClient.getItem).toHaveBeenCalled()
  })
})
