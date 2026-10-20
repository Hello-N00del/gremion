// @vitest-environment node
//
// F1-FIX-10-K / K2#3: the Datenschutz form could not be saved with an empty DPO
// e-mail although the UI says every field is optional (the schema demanded a
// valid e-mail whenever the key was present, and the form always sends all keys).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ hasRole: vi.fn(), readConfig: vi.fn(), writeConfig: vi.fn() }))

vi.mock('$lib/auth', () => ({ hasRole: h.hasRole, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig, writeConfig: h.writeConfig }))

const EMPTY_COMPLIANCE = { dpo_name: '', dpo_email: '', controller_name: '', controller_address: '', purpose_description: '' }
const FULL_CONFIG = {
  org: { name: 'Org', domain: 'example.org' },
  compliance: EMPTY_COMPLIANCE,
  retention: { access_logs_days: 14, app_logs_days: 28, security_logs_days: 27, security_nopii_logs_days: 27 },
}

async function patch(body: unknown) {
  const { PATCH } = await import('./+server')
  const request = new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals: { auth: async () => ({ user: { roles: ['it-admin'] } }) } })
}

beforeEach(() => {
  h.hasRole.mockReset().mockReturnValue(true)
  h.readConfig.mockReset().mockReturnValue(FULL_CONFIG)
  h.writeConfig.mockReset().mockReturnValue(FULL_CONFIG)
})

describe('PATCH /api/settings/loeschkonzept (K2#3)', () => {
  it('saves the default (all-empty) compliance object, empty DPO e-mail included', async () => {
    const res = await patch(EMPTY_COMPLIANCE)
    expect(res.status).toBe(200)
    expect(h.writeConfig).toHaveBeenCalledWith({ compliance: EMPTY_COMPLIANCE })
  })

  it('still rejects a non-empty value that is not an e-mail address', async () => {
    const res = await patch({ ...EMPTY_COMPLIANCE, dpo_email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('still accepts a real e-mail address', async () => {
    const res = await patch({ ...EMPTY_COMPLIANCE, dpo_email: 'dpo@example.org' })
    expect(res.status).toBe(200)
  })
})
