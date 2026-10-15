import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// #412 — the newsletter draft ODT is uploaded to the ADMIN Nextcloud space, but
// the old edit link routed through the generic per-user /files/edit editor,
// which PROPFINDs under the logged-in user's UUID → 404 → 500. This pins the
// admin-resolved WOPI path: the Collabora token is minted with admin Basic auth
// (no per-user webdavBearer) against the stored odt_path, mirroring the
// protocols draft embed (protocol-documents.ts getDraftWopiToken).
// ─────────────────────────────────────────────────────────────────────────────

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
const { mockResolveBackend, mockGetNewsletter } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  mockGetNewsletter: vi.fn(),
}))
const { mockCreateNextcloudClient, mockGetFileId, mockGetCollaboraEditorUrl } = vi.hoisted(() => ({
  mockCreateNextcloudClient: vi.fn(),
  mockGetFileId: vi.fn(),
  mockGetCollaboraEditorUrl: vi.fn(),
}))
const { mockDefaultTenantEnv } = vi.hoisted(() => ({ mockDefaultTenantEnv: vi.fn() }))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Finance: 'finance' },
}))
vi.mock('$lib/server/newsletter/backend/resolve', () => ({
  resolveNewsletterBackendOr503: mockResolveBackend,
}))
vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: mockCreateNextcloudClient,
}))
vi.mock('$lib/server/tenant/default-env', () => ({
  defaultTenantEnv: mockDefaultTenantEnv,
}))

import { GET } from './+server'

const ODT_PATH = '/remote.php/dav/files/admin/_newsletters/x.odt'

function makeEvent() {
  return {
    locals: { user: { id: '3f2c1d4e-aaaa-bbbb-cccc-1234567890ab', roles: ['finance'] } },
    params: { id: '7' },
  } as unknown as Parameters<typeof GET>[0]
}

describe('GET /api/newsletter/[id]/wopi-token — #412 admin-resolved editor token', () => {
  beforeEach(() => {
    mockHasRole.mockReset().mockReturnValue(true)
    mockResolveBackend.mockReset()
    mockGetNewsletter.mockReset()
    mockCreateNextcloudClient.mockReset()
    mockGetFileId.mockReset()
    mockGetCollaboraEditorUrl.mockReset()
    mockDefaultTenantEnv.mockReset().mockImplementation((name: string) =>
      name === 'NEXTCLOUD_ADMIN_USER' ? 'ncadmin' : undefined
    )

    mockGetNewsletter.mockResolvedValue({ id: 7, odt_path: ODT_PATH, status: 'draft' })
    mockResolveBackend.mockReturnValue({ getNewsletter: mockGetNewsletter })
    mockGetFileId.mockResolvedValue(42)
    mockGetCollaboraEditorUrl.mockResolvedValue({
      editorUrl: 'http://collabora/edit?access_token=abc',
      tokenTtl: 3600,
    })
    mockCreateNextcloudClient.mockReturnValue({
      getFileId: mockGetFileId,
      getCollaboraEditorUrl: mockGetCollaboraEditorUrl,
    })
  })

  it('resolves the file admin-side (odt_path + sys user, NOT the requesting user)', async () => {
    const res = await GET(makeEvent())
    expect(res.status).toBe(200)
    // Admin Basic auth: NO per-user webdavBearer may be passed.
    expect(mockCreateNextcloudClient).toHaveBeenCalledTimes(1)
    expect(mockCreateNextcloudClient.mock.calls[0][0]?.webdavBearer).toBeUndefined()
    // The stored dav path is used as-is, resolved as the sys user — never the
    // logged-in user's UUID (the old /files/edit path did exactly that → 404).
    expect(mockGetFileId).toHaveBeenCalledWith(ODT_PATH, 'ncadmin')
    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, 'ncadmin')
  })

  it('returns the Collabora editor payload', async () => {
    const res = await GET(makeEvent())
    const body = await res.json()
    expect(body.editorUrl).toBe('http://collabora/edit?access_token=abc')
    expect(body.tokenTtl).toBe(3600)
  })

  it('403s for a role that may not edit newsletters', async () => {
    mockHasRole.mockReturnValue(false)
    const res = await GET(makeEvent())
    expect(res.status).toBe(403)
    expect(mockCreateNextcloudClient).not.toHaveBeenCalled()
  })

  it('404s when the newsletter does not exist', async () => {
    mockGetNewsletter.mockResolvedValue(null)
    const res = await GET(makeEvent())
    expect(res.status).toBe(404)
  })

  it('404s when the newsletter has no odt_path', async () => {
    mockGetNewsletter.mockResolvedValue({ id: 7, odt_path: null, status: 'draft' })
    const res = await GET(makeEvent())
    expect(res.status).toBe(404)
  })

  // A sent newsletter's ODT is an archive — no edit token may be minted for it
  // (same editable set as the schedule route: draft | failed).
  it.each(['sent', 'sending', 'scheduled'])('403s for status %s', async (status) => {
    mockGetNewsletter.mockResolvedValue({ id: 7, odt_path: ODT_PATH, status })
    const res = await GET(makeEvent())
    expect(res.status).toBe(403)
    expect(mockCreateNextcloudClient).not.toHaveBeenCalled()
  })

  it('still mints for a failed newsletter (re-schedulable, needs content fixes)', async () => {
    mockGetNewsletter.mockResolvedValue({ id: 7, odt_path: ODT_PATH, status: 'failed' })
    const res = await GET(makeEvent())
    expect(res.status).toBe(200)
  })

  // A Nextcloud/Collabora outage must degrade to a structured 502 — never an
  // unhandled 500, and never leak NC internals (host, path, stack) to the
  // client. The failure is still observable server-side via console.error.
  it('502s with no Nextcloud internals in the body when NC/Collabora fails, and logs server-side', async () => {
    const ncError = new Error(
      'connect ECONNREFUSED 10.0.0.5:443 /remote.php/dav/files/admin/_newsletters/x.odt',
    )
    mockGetFileId.mockRejectedValue(ncError)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await GET(makeEvent())

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Editor-Dienst nicht verfügbar' })
    const bodyText = JSON.stringify(body)
    expect(bodyText).not.toContain('ECONNREFUSED')
    expect(bodyText).not.toContain('10.0.0.5')
    expect(bodyText).not.toContain(ODT_PATH)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0].join(' ')).toContain('wopi-token')

    consoleErrorSpy.mockRestore()
  })

  // Regression guard: the newsletter pages must not route through the generic
  // per-user files editor again.
  it('newsletter pages no longer link the per-user /files/edit editor', () => {
    for (const rel of [
      '../../../../newsletter/[id]/+page.svelte',
      '../../../../newsletter/new/+page.svelte',
    ]) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
      expect(source).not.toContain('/files/edit/_newsletters')
    }
  })
})
