import { describe, it, expect, vi, beforeEach } from 'vitest'

// #412: the inline Collabora editor token is fetched server-side by the page
// load for both 'draft' and 'failed' newsletters (dc1718f5 — a failed send is
// still editable so the user can fix and retry it). This pins that editable
// gate + the "omit on non-ok token response" degradation: if the wopi-token
// route 502s (Nextcloud/Collabora outage), the page must still render with
// wopiToken: null rather than surfacing a 500 or an unhandled rejection.

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
const { mockResolveBackend, backend } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  backend: {
    getNewsletter: vi.fn(),
    getNewsletterRecipients: vi.fn(),
    listMailingLists: vi.fn(),
  },
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Finance: 'finance' },
}))
vi.mock('$lib/server/newsletter/backend/resolve', () => ({
  resolveNewsletterBackendForPage: mockResolveBackend,
}))

import { load } from './+page.server'

// A SvelteKit page load is typed to possibly return `void` (redirect/error
// branches), so the awaited result is `void | {...}`. Narrow it the way the
// rest of the suite does (e.g. layout.server.test.ts) so property access
// type-checks under svelte-check.
type LoadData = { wopiToken: { editorUrl: string; tokenTtl: number } | null }

const NEWSLETTER = {
  id: 7,
  title: 'Sommer-Update',
  odt_path: '/remote.php/dav/files/admin/_newsletters/7.odt',
  subject: 'Sommer-Update',
  scheduled_at: null,
  sent_at: null,
  error: null,
  created_by: 'u1',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

const TOKEN_PAYLOAD = { editorUrl: 'http://collabora/edit?access_token=abc', tokenTtl: 3600 }

function makeFetch(response: { ok: boolean; json?: () => Promise<unknown> }) {
  return vi.fn().mockResolvedValue(response)
}

function makeEvent(opts: { status: string; fetchImpl: ReturnType<typeof makeFetch> }) {
  backend.getNewsletter.mockResolvedValue({ ...NEWSLETTER, status: opts.status })
  return {
    locals: { user: { id: 'u1', roles: ['finance'] } },
    params: { id: '7' },
    fetch: opts.fetchImpl,
  } as unknown as Parameters<typeof load>[0]
}

describe('/newsletter/[id] load — #412 inline editor token', () => {
  beforeEach(() => {
    mockHasRole.mockReset().mockReturnValue(true)
    mockResolveBackend.mockReset().mockReturnValue(backend)
    backend.getNewsletter.mockReset()
    backend.getNewsletterRecipients.mockReset().mockResolvedValue([])
    backend.listMailingLists.mockReset().mockResolvedValue([])
  })

  it("fetches the editor token for a 'draft' newsletter", async () => {
    const fetchImpl = makeFetch({ ok: true, json: async () => TOKEN_PAYLOAD })
    const data = (await load(makeEvent({ status: 'draft', fetchImpl }))) as LoadData
    expect(fetchImpl).toHaveBeenCalledWith('/api/newsletter/7/wopi-token')
    expect(data.wopiToken).toEqual(TOKEN_PAYLOAD)
  })

  it("also fetches the editor token for a 'failed' newsletter (re-schedulable, needs content fixes)", async () => {
    const fetchImpl = makeFetch({ ok: true, json: async () => TOKEN_PAYLOAD })
    const data = (await load(makeEvent({ status: 'failed', fetchImpl }))) as LoadData
    expect(fetchImpl).toHaveBeenCalledWith('/api/newsletter/7/wopi-token')
    expect(data.wopiToken).toEqual(TOKEN_PAYLOAD)
  })

  it('omits the token (wopiToken: null) when the token route responds non-ok, without throwing', async () => {
    const fetchImpl = makeFetch({ ok: false })
    const data = (await load(makeEvent({ status: 'draft', fetchImpl }))) as LoadData
    expect(data.wopiToken).toBeNull()
  })

  it('does not fetch a token at all for a non-editable status (e.g. sent)', async () => {
    const fetchImpl = makeFetch({ ok: true, json: async () => TOKEN_PAYLOAD })
    const data = (await load(makeEvent({ status: 'sent', fetchImpl }))) as LoadData
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(data.wopiToken).toBeNull()
  })
})
