// @vitest-environment node
//
// F1-FIX-10-K / K2#9: "Konfiguration zurücksetzen" was a client-side PATCH that
// merged a hard-coded finance/elections module set (modules the kernel no longer
// ships) onto the config. The reset is now a server action that rebuilds the
// reset sections from the real defaults and writes an audit entry.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hasRole: vi.fn(),
  writeConfig: vi.fn(),
  parseConfig: vi.fn(),
  writeAuditEntry: vi.fn(),
}))

vi.mock('$lib/auth', () => ({ hasRole: h.hasRole, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$lib/server/config', () => ({ writeConfig: h.writeConfig, parseConfig: h.parseConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))

const DEFAULTS = {
  org: { name: 'Default Org', domain: 'example.org', logo_path: null, portal_sections: { news: true } },
  smtp: { configured: false, host: 'mailpit', port: 1025, from_address: 'noreply@example.org', from_name: 'Gremion' },
  modules: { somemodule: true },
  backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '/k' },
}

function locals() {
  return { auth: async () => ({ user: { id: 'u-1', roles: ['it-admin'] } }) }
}

async function post(body: unknown) {
  const { POST } = await import('./+server')
  const request = new Request('http://localhost/api/settings/reset', { method: 'POST', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return POST({ request, locals: locals() })
}

beforeEach(() => {
  h.hasRole.mockReset().mockReturnValue(true)
  h.writeConfig.mockReset().mockReturnValue({})
  h.parseConfig.mockReset().mockReturnValue(DEFAULTS)
  h.writeAuditEntry.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/settings/reset', () => {
  it('403 for a non-IT-admin and writes nothing', async () => {
    h.hasRole.mockReturnValue(false)
    const res = await post({ confirm: 'ZURÜCKSETZEN' })
    expect(res.status).toBe(403)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('refuses without the confirmation phrase, server-side', async () => {
    const res = await post({ confirm: 'nein' })
    expect(res.status).toBe(422)
    expect(h.writeConfig).not.toHaveBeenCalled()
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('rebuilds org, smtp, modules and the backup retention from the real defaults, no hard-coded module ids', async () => {
    const res = await post({ confirm: 'ZURÜCKSETZEN' })
    expect(res.status).toBe(200)
    expect(h.parseConfig).toHaveBeenCalledWith({})
    expect(h.writeConfig).toHaveBeenCalledTimes(1)
    const update = h.writeConfig.mock.calls[0]![0]
    expect(update.modules).toEqual(DEFAULTS.modules)
    expect(update.modules).not.toHaveProperty('finance')
    expect(update.modules).not.toHaveProperty('elections')
    expect(update.org).toEqual(DEFAULTS.org)
    expect(update.smtp).toEqual(DEFAULTS.smtp)
    expect(update.backups).toEqual({ retention_days: 30 })
    // legal / compliance / retention / setup state are NOT part of this reset
    expect(Object.keys(update).sort()).toEqual(['backups', 'modules', 'org', 'smtp'])
  })

  it('audits the reset with the acting user', async () => {
    await post({ confirm: 'ZURÜCKSETZEN' })
    expect(h.writeAuditEntry).toHaveBeenCalledTimes(1)
    expect(h.writeAuditEntry.mock.calls[0]![0]).toMatchObject({ userId: 'u-1', field: 'config.reset' })
  })

  it('does not report success when the config write throws', async () => {
    h.writeConfig.mockImplementation(() => {
      throw new Error('disk full')
    })
    const res = await post({ confirm: 'ZURÜCKSETZEN' })
    expect(res.status).toBe(500)
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })
})
