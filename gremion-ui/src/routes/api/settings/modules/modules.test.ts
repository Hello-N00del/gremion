// @vitest-environment node
//
// Karenz phase 1, Task 11: GET/POST /api/settings/modules. Council-admin (and it-admin through the
// hierarchy) only; the POST needs a fresh loa2 (the service re-checks it and the 401 body is the
// STEP_UP_REQUIRED convention of the other step-up routes).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

interface KeptRow {
  userId: string
  armedAuthTime: number
  input: unknown
  idempotencyKey: string
  expired: boolean
}

const h = vi.hoisted(() => {
  // A double of the table module_switch_pending with the store's contract (pending.integration.test.ts pins
  // the real one): one row per person, a claim REMOVES the row, `live` is false past the expiry.
  const rows = new Map<string, KeptRow>()
  let n = 0
  return {
    submitModuleSwitch: vi.fn(),
    loadModuleOverview: vi.fn(),
    previewSwitchOff: vi.fn(),
    loadOperatorModules: vi.fn(),
    rows,
    /** An empty table, and the first handle again (handle-1, key-1). */
    reset: () => {
      rows.clear()
      n = 0
    },
    arm: vi.fn(async (_db: unknown, entry: { userId: string; authTime: number; input: unknown }) => {
      for (const [handle, row] of rows) if (row.userId === entry.userId) rows.delete(handle)
      n += 1
      const handle = `handle-${n}`
      rows.set(handle, { userId: entry.userId, armedAuthTime: entry.authTime, input: entry.input, idempotencyKey: `key-${n}`, expired: false })
      return handle
    }),
    claim: vi.fn(async (_db: unknown, handle: string) => {
      const row = rows.get(handle)
      if (!row) return null
      rows.delete(handle)
      return { userId: row.userId, armedAuthTime: row.armedAuthTime, input: row.input, idempotencyKey: row.idempotencyKey, live: !row.expired }
    }),
  }
})

vi.mock('$lib/server/module-switch/service', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-switch/service')>()),
  submitModuleSwitch: h.submitModuleSwitch,
  loadModuleOverview: h.loadModuleOverview,
}))
vi.mock('$lib/server/module-switch/pending', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-switch/pending')>()),
  armPendingSwitch: h.arm,
  claimPendingSwitch: h.claim,
}))
vi.mock('$lib/server/module-switch/preview', () => ({ previewSwitchOff: h.previewSwitchOff }))
vi.mock('$lib/server/module-switch/operator-modules', () => ({ loadOperatorModules: h.loadOperatorModules }))
vi.mock('$lib/server/module-switch/council-db', async (orig) => ({ ...(await orig<typeof import('$lib/server/module-switch/council-db')>()) }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'

const TENANT = { id: 'c1', slug: 'rat-a' }
const nowSec = () => Math.floor(Date.now() / 1000)

function locals(roles: string[] | null = [Role.CouncilAdmin], extra: Record<string, unknown> = {}) {
  return {
    tenant: TENANT,
    auth: async () =>
      roles ? { user: { id: 'u1', roles, loa: 2, authTime: nowSec() }, idToken: 'ID', accessToken: 'AT', ...extra } : null,
  }
}

const COOKIE = 'gremion_module_switch_pending'
const COOKIE_PATH = '/api/settings/modules'

/** The browser's cookies for this endpoint, as far as the handler uses them. */
function jar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: (name: string) => values.get(name),
    set: vi.fn((name: string, value: string, _opts: Record<string, unknown>) => {
      values.set(name, value)
    }),
    delete: vi.fn((name: string, _opts: Record<string, unknown>) => {
      values.delete(name)
    }),
  }
}
type Jar = ReturnType<typeof jar>

async function post(body: unknown, l = locals(), cookies: Jar = jar()) {
  const { POST } = await import('./+server')
  const request = new Request('http://localhost/api/settings/modules', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  // @ts-expect-error partial event
  return POST({ request, locals: l, cookies })
}

/** A council admin's session: who, which level of assurance, and when the second factor was given. */
function sessionOf(over: { id?: string; loa?: number; authTime?: number; roles?: string[] } = {}, extra: Record<string, unknown> = {}) {
  const user = { id: over.id ?? 'u1', roles: over.roles ?? [Role.CouncilAdmin], loa: over.loa ?? 2, authTime: over.authTime ?? nowSec() }
  return { tenant: TENANT, auth: async () => ({ user, idToken: 'ID', accessToken: 'AT', ...extra }) }
}

/** The time the admin signed in with the password only, before any second factor. */
const SIGNED_IN = 1_800_000_000
const BEFORE = { loa: 1, authTime: SIGNED_IN }
/** The same admin after the round trip: a second factor newer than the sign-in. */
const AFTER = { loa: 2, authTime: SIGNED_IN + 40 }
const STEP_UP = { ok: false, status: 401, code: 'STEP_UP_REQUIRED', message: 'x' }

/** Confirm a switch without a fresh second factor: the service asks for it and the endpoint answers 401. */
async function confirmBeforeSecondFactor(body: unknown, cookies: Jar, user: Parameters<typeof sessionOf>[0] = BEFORE) {
  h.submitModuleSwitch.mockResolvedValueOnce(STEP_UP)
  const res = await post(body, sessionOf(user), cookies)
  expect(res.status).toBe(401)
  h.submitModuleSwitch.mockClear()
  return res
}

async function get(query = '', l = locals()) {
  const { GET } = await import('./+server')
  // @ts-expect-error partial event
  return GET({ url: new URL(`http://localhost/api/settings/modules${query}`), locals: l })
}

beforeEach(() => {
  h.submitModuleSwitch.mockReset().mockResolvedValue({ ok: true, requestId: 'req-1' })
  h.loadModuleOverview.mockReset().mockResolvedValue({ modules: [], disableAvailable: false, problem: null })
  h.previewSwitchOff.mockReset().mockResolvedValue({ moduleId: 'votes', graceDays: null })
  h.loadOperatorModules.mockReset().mockResolvedValue([])
  h.reset()
  h.arm.mockClear()
  h.claim.mockClear()
})

// The second factor is a round trip to the sign-in service. The switch the admin confirmed before it is
// carried out after it: the same input, once, by the same person, and only with a NEWER second factor.
describe('POST /api/settings/modules: a switch confirmed before the second factor is carried out after it', () => {
  const DISABLE = { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }
  const ENABLE = { moduleId: 'calendar', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } }

  it.each([
    ['switch-off with the typed name', DISABLE],
    ['switch-on with the DPIA decision', ENABLE],
    ['restore (a plain switch-on)', { moduleId: 'votes', action: 'enable' }],
  ])('%s: the 401 keeps the input, and { resume: true } after the second factor submits exactly that input once', async (_name, input) => {
    const cookies = jar()
    const first = await confirmBeforeSecondFactor(input, cookies)
    const answer = await first.text()
    expect(JSON.parse(answer)).toEqual({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
    // the handle travels in a cookie only this endpoint receives and no script can read
    expect(cookies.set).toHaveBeenCalledTimes(1)
    const [name, handle, opts] = cookies.set.mock.calls[0]!
    expect(name).toBe(COOKIE)
    expect(opts).toMatchObject({ path: COOKIE_PATH, httpOnly: true, sameSite: 'strict', maxAge: 300 })
    expect(answer).not.toContain(handle)

    const res = await post({ resume: true }, sessionOf(AFTER), cookies)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, resumed: true, requestId: 'req-1', moduleId: input.moduleId, action: input.action })
    expect(h.submitModuleSwitch).toHaveBeenCalledTimes(1)
    const [ctx, submitted, deps] = h.submitModuleSwitch.mock.calls[0]!
    expect(submitted).toEqual(input)
    expect(ctx).toMatchObject({ tenant: TENANT, idToken: 'ID', accessToken: 'AT', user: { id: 'u1', loa: 2 } })
    // the platform request goes out under the key fixed at confirmation
    expect(deps.newKey()).toBe('key-1')
    // spent: the cookie is cleared and the row is gone
    expect(cookies.values.has(COOKIE)).toBe(false)
    expect(cookies.delete).toHaveBeenCalledWith(COOKIE, expect.objectContaining({ path: COOKIE_PATH }))
    expect(h.rows.size).toBe(0)
  })

  it('a session that lost its token pair keeps the input too (it signs in again, like a missing second factor)', async () => {
    const cookies = jar()
    const res = await post({ moduleId: 'votes', action: 'enable' }, sessionOf(BEFORE, { idToken: undefined }), cookies)
    expect(res.status).toBe(401)
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
    expect(cookies.values.get(COOKIE)).toBe('handle-1')
    expect((await post({ resume: true }, sessionOf(AFTER), cookies)).status).toBe(201)
    expect(h.submitModuleSwitch.mock.calls[0]![1]).toEqual({ moduleId: 'votes', action: 'enable' })
  })

  it('replay: the same handle presented a second time is refused and nothing is submitted', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    const handle = cookies.values.get(COOKIE)!
    expect((await post({ resume: true }, sessionOf(AFTER), cookies)).status).toBe(201)
    h.submitModuleSwitch.mockClear()

    const again = await post({ resume: true }, sessionOf(AFTER), jar({ [COOKIE]: handle }))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ success: false, code: 'RESUME_GONE' })
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('cross-user: another admin presenting the handle is refused, learns nothing about the switch, and the handle is spent for everybody', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    const handle = cookies.values.get(COOKIE)!

    const other = await post({ resume: true }, sessionOf({ id: 'u2', ...AFTER }), jar({ [COOKIE]: handle }))
    expect(other.status).toBe(409)
    const body = await other.json()
    expect(body).toMatchObject({ success: false, code: 'RESUME_GONE' })
    expect(body).not.toHaveProperty('moduleId')
    expect(body).not.toHaveProperty('action')
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()

    const owner = await post({ resume: true }, sessionOf(AFTER), jar({ [COOKIE]: handle }))
    expect(owner.status).toBe(409)
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('expiry: a kept switch past its time is refused and nothing is submitted', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    h.rows.get(cookies.values.get(COOKIE)!)!.expired = true
    const res = await post({ resume: true }, sessionOf(AFTER), cookies)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'RESUME_EXPIRED', moduleId: 'votes', action: 'disable' })
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
    expect(cookies.values.has(COOKIE)).toBe(false)
  })

  it.each([
    ['the second factor was not given (the same session comes back)', BEFORE],
    ['the level of assurance is still 1', { loa: 1, authTime: SIGNED_IN + 40 }],
    ['the second factor is the one from before the confirmation', { loa: 2, authTime: SIGNED_IN }],
  ])('no new second factor, no switch: %s', async (_name, back) => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies, { loa: 2, authTime: SIGNED_IN })
    const res = await post({ resume: true }, sessionOf(back), cookies)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'RESUME_UNCONFIRMED', moduleId: 'votes' })
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
    // spent all the same: coming back a third time finds nothing
    expect(h.rows.size).toBe(0)
    expect(cookies.values.has(COOKIE)).toBe(false)
  })

  it('a resume the service still answers with STEP_UP_REQUIRED is a 409, never a second round trip: nothing is kept again', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    h.arm.mockClear()
    cookies.set.mockClear()
    h.submitModuleSwitch.mockResolvedValueOnce(STEP_UP)
    const res = await post({ resume: true }, sessionOf(AFTER), cookies)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'RESUME_UNCONFIRMED', moduleId: 'votes' })
    expect(h.arm).not.toHaveBeenCalled()
    expect(cookies.set).not.toHaveBeenCalled()
    expect(h.rows.size).toBe(0)
  })

  it('a resume without the token pair submits nothing', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    const res = await post({ resume: true }, sessionOf(AFTER, { accessToken: undefined }), cookies)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'RESUME_UNCONFIRMED' })
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('a resume with no kept switch is a 409 and the store is not asked', async () => {
    const res = await post({ resume: true }, sessionOf(AFTER))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'RESUME_GONE' })
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('a non-admin cannot resume: 403 before the kept switch is touched', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    const res = await post({ resume: true }, sessionOf({ ...AFTER, roles: [Role.Member] }), cookies)
    expect(res.status).toBe(403)
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('a refusal of the resumed switch reaches the page with the module it belongs to', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    h.submitModuleSwitch.mockResolvedValueOnce({ ok: false, status: 409, code: 'IN_FLIGHT', message: 'läuft bereits' })
    const res = await post({ resume: true }, sessionOf(AFTER), cookies)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, code: 'IN_FLIGHT', error: 'läuft bereits', moduleId: 'votes', action: 'disable' })
  })

  it('a second confirmation replaces the first: only the newest one is carried out', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor(DISABLE, cookies)
    const first = cookies.values.get(COOKIE)!
    await confirmBeforeSecondFactor(ENABLE, cookies)
    expect(cookies.values.get(COOKIE)).not.toBe(first)
    expect((await post({ resume: true }, sessionOf(AFTER), jar({ [COOKIE]: first }))).status).toBe(409)
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
    expect((await post({ resume: true }, sessionOf(AFTER), cookies)).status).toBe(201)
    expect(h.submitModuleSwitch.mock.calls[0]![1]).toEqual(ENABLE)
  })

  it.each([
    ['an unknown module', { moduleId: 'nope', action: 'enable' }],
    ['an unknown action', { moduleId: 'votes', action: 'drop' }],
    ['a confirmation that is not a text', { moduleId: 'votes', action: 'disable', confirm: 7 }],
    ['an oversized document reference', { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: true, documentRef: 'x'.repeat(501) } }],
  ])('%s is not kept: the 401 stands, no cookie is set and an older one is cleared', async (_name, body) => {
    const cookies = jar({ [COOKIE]: 'older' })
    await confirmBeforeSecondFactor(body, cookies)
    expect(h.arm).not.toHaveBeenCalled()
    expect(cookies.set).not.toHaveBeenCalled()
    expect(cookies.values.has(COOKIE)).toBe(false)
  })

  it('only the known fields are kept', async () => {
    const cookies = jar()
    await confirmBeforeSecondFactor({ ...DISABLE, extra: 'x', resume: false }, cookies)
    expect(h.arm.mock.calls[0]![1]).toEqual({ userId: 'u1', authTime: SIGNED_IN, input: DISABLE })
  })

  it('when the input cannot be kept the 401 still stands (the admin repeats the action after the second factor)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.arm.mockRejectedValueOnce(new Error('connection refused at some-host'))
    const cookies = jar()
    const res = await confirmBeforeSecondFactor(DISABLE, cookies)
    expect(JSON.stringify(await res.json())).not.toContain('some-host')
    expect(cookies.set).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('a store failure during the resume is a 500 without the error text, and nothing is submitted', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.claim.mockRejectedValueOnce(new Error('secret connection string'))
    const res = await post({ resume: true }, sessionOf(AFTER), jar({ [COOKIE]: 'handle-9' }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('POST /api/settings/modules', () => {
  it('queues and answers 201 { success, requestId }, passing the session tokens and tenant to the service', async () => {
    const res = await post({ moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, requestId: 'req-1' })
    const [c, input] = h.submitModuleSwitch.mock.calls[0]!
    expect(c.tenant).toBe(TENANT)
    expect(c.idToken).toBe('ID')
    expect(c.accessToken).toBe('AT')
    expect(c.user.id).toBe('u1')
    expect(input).toEqual({ moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } })
  })

  it('an unauthenticated caller and a non-admin get 403 and the service is not called', async () => {
    expect((await post({ moduleId: 'votes', action: 'enable' }, locals(null))).status).toBe(403)
    expect((await post({ moduleId: 'votes', action: 'enable' }, locals([Role.Member]))).status).toBe(403)
    expect((await post({ moduleId: 'votes', action: 'enable' }, locals([Role.Vorstand]))).status).toBe(403)
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('a session without the token pair cannot submit: 401 STEP_UP_REQUIRED (the executor re-verifies the tokens, so nothing is queued without them)', async () => {
    const res = await post({ moduleId: 'votes', action: 'enable' }, locals([Role.CouncilAdmin], { idToken: undefined }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('maps the service STEP_UP_REQUIRED to 401 { error, requiredLoa: 2 }', async () => {
    h.submitModuleSwitch.mockResolvedValue({ ok: false, status: 401, code: 'STEP_UP_REQUIRED', message: 'x' })
    const res = await post({ moduleId: 'votes', action: 'enable' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
  })

  it.each([
    [409, 'IN_FLIGHT'],
    [409, 'NOOP'],
    [422, 'DISABLE_NOT_YET'],
    [422, 'DPIA_REQUIRED'],
    [422, 'MODULE_NOT_SWITCHABLE'],
    [503, 'NOT_CONFIGURED'],
  ])('maps a service refusal %i %s to { success:false, code, error }', async (status, code) => {
    h.submitModuleSwitch.mockResolvedValue({ ok: false, status, code, message: `text ${code}` })
    const res = await post({ moduleId: 'votes', action: 'enable' })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ success: false, code, error: `text ${code}` })
  })

  it('a body that is not JSON is 400 and the service is not called', async () => {
    const res = await post('not json{')
    expect(res.status).toBe(400)
    expect(h.submitModuleSwitch).not.toHaveBeenCalled()
  })

  it('an unexpected service failure is a 500 without the error text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.submitModuleSwitch.mockRejectedValue(new Error('secret connection string'))
    const res = await post({ moduleId: 'votes', action: 'enable' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    log.mockRestore()
  })
})

describe('GET /api/settings/modules', () => {
  it('returns the overview for an admin', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { modules: [], disableAvailable: false, problem: null, operatorModules: [] } })
    expect(h.loadModuleOverview).toHaveBeenCalledWith(TENANT)
  })

  it('carries the modules the council cannot switch but the customer has, next to the switchable ones', async () => {
    const held = [
      { moduleId: 'files', label: 'Dokumente' },
      { moduleId: 'content', label: 'Inhalte' },
    ]
    h.loadModuleOverview.mockResolvedValue({ modules: [{ moduleId: 'votes' }], disableAvailable: true, problem: null })
    h.loadOperatorModules.mockResolvedValue(held)
    const body = await (await get()).json()
    expect(body.data.modules).toEqual([{ moduleId: 'votes' }])
    expect(body.data.operatorModules).toEqual(held)
    expect(h.loadOperatorModules).toHaveBeenCalledWith(TENANT)
  })

  it('an operator module list that cannot be read fails the whole read, never a list that silently omits them', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.loadOperatorModules.mockRejectedValue(new Error('platform down'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('platform down')
    log.mockRestore()
  })

  it('a non-admin reads neither list', async () => {
    expect((await get('', locals([Role.Member]))).status).toBe(403)
    expect(h.loadOperatorModules).not.toHaveBeenCalled()
  })

  it('403 for a non-admin and for no session', async () => {
    expect((await get('', locals([Role.Member]))).status).toBe(403)
    expect((await get('', locals(null))).status).toBe(403)
    expect(h.loadModuleOverview).not.toHaveBeenCalled()
  })

  it('CouncilNotConfigured is 503 NOT_CONFIGURED with a readable text, never an empty list', async () => {
    h.loadModuleOverview.mockRejectedValue(new CouncilNotConfigured())
    const res = await get()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'NOT_CONFIGURED' })
    expect(body.error).toMatch(/nicht konfiguriert/)
  })

  it('?preview=<id> returns the deletion preview of a switchable module', async () => {
    const res = await get('?preview=votes')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { moduleId: 'votes', graceDays: null } })
    expect(h.previewSwitchOff).toHaveBeenCalledWith(TENANT, 'votes')
    expect(h.loadModuleOverview).not.toHaveBeenCalled()
  })

  it('?preview=<id> of a module that is not council-switchable is 422 MODULE_NOT_SWITCHABLE', async () => {
    for (const id of ['files', 'board', 'nope']) {
      const res = await get(`?preview=${id}`)
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ success: false, code: 'MODULE_NOT_SWITCHABLE' })
    }
    expect(h.previewSwitchOff).not.toHaveBeenCalled()
  })
})
