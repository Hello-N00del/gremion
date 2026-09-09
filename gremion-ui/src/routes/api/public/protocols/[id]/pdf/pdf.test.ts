import { describe, it, expect, vi, beforeEach } from 'vitest'

// boundary rule A3a-2: this route no longer imports protocols/protocol-wopi (which
// pulled in the files module internals). downloadPublishedPdf comes from the
// ProtocolDocumentPort registered in runtime-registry; the test registers a fake
// port and exercises the degradation path when no port is registered.

const { mockGetPath } = vi.hoisted(() => ({ mockGetPath: vi.fn() }))
const { mockDownload } = vi.hoisted(() => ({ mockDownload: vi.fn() }))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  getPublishedProtocolPdfPath: mockGetPath,
}))

import { GET } from './+server'
import {
  registerProtocolDocumentPort,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

function registerFakePort() {
  registerProtocolDocumentPort({
    downloadPublishedPdf: mockDownload,
    createDraftFile: vi.fn(),
    getDraftWopiToken: vi.fn(),
    downloadDraft: vi.fn(),
    publishFile: vi.fn(),
    uploadPublishedPdf: vi.fn(),
    deleteDraftFile: vi.fn(),
  } as unknown as ProtocolDocumentPort)
}

const VALID_ID = '11111111-1111-4111-8111-111111111111'
const PDF_PATH = `/protocols/published/${VALID_ID}/protocol.pdf`

function call(id: string): Promise<Response> {
  // @ts-expect-error partial event — the route only reads params.id
  return Promise.resolve(GET({ params: { id } }))
}
async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e: unknown) {
    return (e as { status?: number })?.status ?? 0
  }
}

describe('GET /api/public/protocols/[id]/pdf (#241, gremion-ui)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    registerFakePort()
    mockGetPath.mockReset()
    mockDownload.mockReset()
  })

  it('404s on a non-UUID id without touching the DB', async () => {
    expect(await statusOf(call('not-a-uuid'))).toBe(404)
    expect(mockGetPath).not.toHaveBeenCalled()
  })

  it('404s when no published+public PDF exists', async () => {
    mockGetPath.mockResolvedValue(null)
    expect(await statusOf(call(VALID_ID))).toBe(404)
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('streams the PDF (application/pdf, short cache) on the happy path', async () => {
    mockGetPath.mockResolvedValue(PDF_PATH)
    mockDownload.mockResolvedValue(new Response('pdf-bytes', { status: 200 }))
    const res = (await call(VALID_ID)) as Response
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toContain('max-age=300')
    expect(res.headers.get('cache-control')).not.toContain('86400')
    expect(mockDownload).toHaveBeenCalledWith(PDF_PATH)
  })

  it('502s when the upstream Nextcloud download is not ok', async () => {
    mockGetPath.mockResolvedValue(PDF_PATH)
    mockDownload.mockResolvedValue(new Response('nope', { status: 404 }))
    expect(await statusOf(call(VALID_ID))).toBe(502)
  })

  // boundary rule A3a-2 degradation: no ProtocolDocumentPort registered -> 503.
  it('returns 503 when no ProtocolDocumentPort is registered', async () => {
    _resetRuntimeRegistryForTests()
    mockGetPath.mockResolvedValue(PDF_PATH)
    expect(await statusOf(call(VALID_ID))).toBe(503)
  })
})
