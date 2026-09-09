// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockReadConfig, mockWriteConfig } = vi.hoisted(() => ({
  mockReadConfig: vi.fn(),
  mockWriteConfig: vi.fn(),
}))

vi.mock('$lib/server/config', () => ({
  readConfig: mockReadConfig,
  writeConfig: mockWriteConfig,
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

// Prevent fs operations during tests (backup endpoint reads/writes files)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('[]'),
    writeFileSync: vi.fn(),
  }
})

const { mockHasRole } = vi.hoisted(() => ({
  mockHasRole: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { ITAdmin: 'it-admin', Member: 'member' },
}))

const baseConfig = {
  setup_complete: true,
  wizard_steps: { health_check: 'complete', org_info: 'complete', admin_accounts: 'complete', smtp: 'complete' },
  org: { name: 'TestOrg', domain: 'test.de', logo_path: null },
  smtp: { configured: true, host: 'smtp.test.de', port: 587, from_address: 'no@test.de', from_name: 'Test' },
  modules: { files: true, messages: true, calendar: true, users: true, finance: true, elections: true },
  elections: { tracked_uuids: [] },
  legal: { datenschutz_html: '', impressum_html: '', barrierefreiheit_html: '' },
  backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '' },
}

function makeLocals(isAdmin: boolean) {
  return { auth: async () => ({ user: { roles: isAdmin ? ['it-admin'] : ['member'] } }) }
}

describe('GET /api/settings', () => {
  beforeEach(() => {
    mockReadConfig.mockReturnValue(baseConfig)
    mockWriteConfig.mockReturnValue(baseConfig)
  })

  it('returns 403 for non-IT admin', async () => {
    mockHasRole.mockReturnValue(false)
    const { GET } = await import('../api/settings/+server')
    // @ts-expect-error partial mock
    const res = await GET({ locals: makeLocals(false) })
    expect(res.status).toBe(403)
  })

  it('returns config without wizard_steps for IT admin', async () => {
    mockHasRole.mockReturnValue(true)
    const { GET } = await import('../api/settings/+server')
    // @ts-expect-error partial mock
    const res = await GET({ locals: makeLocals(true) })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).not.toHaveProperty('wizard_steps')
    expect(body.data.org.name).toBe('TestOrg')
  })
})

describe('PATCH /api/settings', () => {
  beforeEach(() => {
    mockReadConfig.mockReturnValue(baseConfig)
    mockWriteConfig.mockReturnValue(baseConfig)
  })

  it('returns 403 for non-IT admin', async () => {
    mockHasRole.mockReturnValue(false)
    const { PATCH } = await import('../api/settings/+server')
    const request = new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({}) })
    // @ts-expect-error partial mock
    const res = await PATCH({ request, locals: makeLocals(false) })
    expect(res.status).toBe(403)
  })

  it('returns 422 for invalid body', async () => {
    mockHasRole.mockReturnValue(true)
    const { PATCH } = await import('../api/settings/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ modules: { finance: 'not-a-boolean' } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request, locals: makeLocals(true) })
    // The handler returns 422 Unprocessable Entity for schema-valid JSON that
    // fails Zod validation (with GDPR legal-context messages for retention).
    expect(res.status).toBe(422)
  })

  it('accepts valid module toggle', async () => {
    mockHasRole.mockReturnValue(true)
    mockWriteConfig.mockReturnValue({ ...baseConfig, modules: { ...baseConfig.modules, elections: false } })
    const { PATCH } = await import('../api/settings/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ modules: { elections: false } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request, locals: makeLocals(true) })
    expect(res.status).toBe(200)
    expect(mockWriteConfig).toHaveBeenCalled()
  })
})

describe('POST /api/settings/backup', () => {
  beforeEach(() => {
    mockReadConfig.mockReturnValue(baseConfig)
    mockWriteConfig.mockReturnValue(baseConfig)
  })

  it('returns 403 for non-IT admin', async () => {
    mockHasRole.mockReturnValue(false)
    const { POST } = await import('../api/settings/backup/+server')
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(false) })
    expect(res.status).toBe(403)
  })

  it('returns started: true for IT admin', async () => {
    mockHasRole.mockReturnValue(true)
    const { POST } = await import('../api/settings/backup/+server')
    // @ts-expect-error partial mock
    const res = await POST({ locals: makeLocals(true) })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.started).toBe(true)
    expect(body.data.job_id).toBeTruthy()
  })
})
