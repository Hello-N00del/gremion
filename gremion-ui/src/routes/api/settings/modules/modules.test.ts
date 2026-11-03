// @vitest-environment node
//
// Karenz phase 1, Task 11: GET/POST /api/settings/modules. Council-admin (and it-admin through the
// hierarchy) only; the POST needs a fresh loa2 (the service re-checks it and the 401 body is the
// STEP_UP_REQUIRED convention of the other step-up routes).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const h = vi.hoisted(() => ({
  submitModuleSwitch: vi.fn(),
  loadModuleOverview: vi.fn(),
  previewSwitchOff: vi.fn(),
}))

vi.mock('$lib/server/module-switch/service', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-switch/service')>()),
  submitModuleSwitch: h.submitModuleSwitch,
  loadModuleOverview: h.loadModuleOverview,
}))
vi.mock('$lib/server/module-switch/preview', () => ({ previewSwitchOff: h.previewSwitchOff }))
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

async function post(body: unknown, l = locals()) {
  const { POST } = await import('./+server')
  const request = new Request('http://localhost/api/settings/modules', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  // @ts-expect-error partial event
  return POST({ request, locals: l })
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
    expect(await res.json()).toEqual({ success: true, data: { modules: [], disableAvailable: false, problem: null } })
    expect(h.loadModuleOverview).toHaveBeenCalledWith(TENANT)
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
