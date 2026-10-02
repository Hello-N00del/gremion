import { describe, it, expect, vi, beforeEach } from 'vitest'

// Civitas A3a-2: the Nextcloud document ops the protocol routes drive now live
// in the files module (they legitimately hold the NC client + WebDAV-path
// helpers). They are exposed as ONE ProtocolDocumentPort the files module
// self-registers into runtime-registry, so the protocol routes never import
// $lib/server/files. These assertions are the 7 ops moved verbatim from the
// old protocols/protocol-wopi.test.ts (same nextcloud-client mock, same DAV
// paths /remote.php/dav/files/admin/protocols/drafts|published/...).

const { mockMkcol, mockUpload, mockMove, mockDelete, mockGetFileId, mockGetCollaboraEditorUrl, mockDownload } = vi.hoisted(() => ({
  mockMkcol: vi.fn(),
  mockUpload: vi.fn(),
  mockMove: vi.fn(),
  mockDelete: vi.fn(),
  mockGetFileId: vi.fn(),
  mockGetCollaboraEditorUrl: vi.fn(),
  mockDownload: vi.fn(),
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: () => {
    const nc: Record<string, unknown> = {
      mkcol: mockMkcol,
      upload: mockUpload,
      move: mockMove,
      getFileId: mockGetFileId,
      getCollaboraEditorUrl: mockGetCollaboraEditorUrl,
      download: mockDownload,
    }
    nc['delete'] = mockDelete
    return nc
  },
}))

vi.mock('$env/dynamic/private', () => ({
  env: { NEXTCLOUD_ADMIN_USER: 'admin', COLLABORA_URL: 'http://collabora:9980' }
}))

import { protocolDocumentPort } from './protocol-documents'

const PROTOCOL_ID = 'test-uuid'
const DRAFT_PATH = '/protocols/drafts/test-uuid.odt'
const DAV_DRAFTS = '/remote.php/dav/files/admin/protocols/drafts'
const DAV_DRAFT_FILE = `/remote.php/dav/files/admin${DRAFT_PATH}`

describe('protocolDocumentPort.createDraftFile', () => {
  beforeEach(() => { mockMkcol.mockReset(); mockUpload.mockReset() })

  it('creates the drafts directory and uploads a blank .odt', async () => {
    mockMkcol.mockResolvedValue(undefined)
    mockUpload.mockResolvedValue(undefined)
    const path = await protocolDocumentPort.createDraftFile(PROTOCOL_ID)
    expect(mockMkcol).toHaveBeenCalledWith(DAV_DRAFTS, 'admin')
    expect(mockUpload).toHaveBeenCalledWith(DAV_DRAFT_FILE, 'admin', expect.any(Buffer), 'application/vnd.oasis.opendocument.text')
    expect(path).toBe(DRAFT_PATH)
  })

  it('continues if mkcol throws (directory exists)', async () => {
    mockMkcol.mockRejectedValue(new Error('already exists'))
    mockUpload.mockResolvedValue(undefined)
    await expect(protocolDocumentPort.createDraftFile(PROTOCOL_ID)).resolves.toBe(DRAFT_PATH)
  })
})

describe('protocolDocumentPort.getDraftWopiToken', () => {
  beforeEach(() => { mockGetFileId.mockReset(); mockGetCollaboraEditorUrl.mockReset() })

  it('returns editorUrl and tokenTtl for the draft file', async () => {
    mockGetFileId.mockResolvedValue(42)
    mockGetCollaboraEditorUrl.mockResolvedValue({ editorUrl: 'http://collabora/edit?token=abc', tokenTtl: 3600 })
    const result = await protocolDocumentPort.getDraftWopiToken(DRAFT_PATH)
    expect(mockGetFileId).toHaveBeenCalledWith(DAV_DRAFT_FILE, 'admin')
    expect(mockGetCollaboraEditorUrl).toHaveBeenCalledWith(42, 'admin')
    expect(result.editorUrl).toBe('http://collabora/edit?token=abc')
    expect(result.tokenTtl).toBe(3600)
  })
})

describe('protocolDocumentPort.publishFile', () => {
  beforeEach(() => { mockMkcol.mockReset(); mockMove.mockReset() })

  it('creates published dirs and moves .odt to published path', async () => {
    mockMkcol.mockResolvedValue(undefined)
    mockMove.mockResolvedValue(undefined)
    const pubPath = await protocolDocumentPort.publishFile(PROTOCOL_ID, DRAFT_PATH)
    expect(mockMove).toHaveBeenCalledWith(
      DAV_DRAFT_FILE,
      `/remote.php/dav/files/admin/protocols/published/${PROTOCOL_ID}/protocol.odt`,
      'admin'
    )
    expect(pubPath).toBe(`/protocols/published/${PROTOCOL_ID}`)
  })
})

describe('protocolDocumentPort.deleteDraftFile', () => {
  beforeEach(() => mockDelete.mockReset())

  it('deletes the draft file', async () => {
    mockDelete.mockResolvedValue(undefined)
    await protocolDocumentPort.deleteDraftFile(DRAFT_PATH)
    expect(mockDelete).toHaveBeenCalledWith(DAV_DRAFT_FILE, 'admin')
  })

  it('still calls delete even on a second invocation (no-throw contract)', async () => {
    mockDelete.mockResolvedValue(undefined)
    await protocolDocumentPort.deleteDraftFile(DRAFT_PATH)
    await protocolDocumentPort.deleteDraftFile(DRAFT_PATH)
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })
})

describe('protocolDocumentPort.downloadDraft', () => {
  beforeEach(() => mockDownload.mockReset())

  it('returns buffer of draft file', async () => {
    const buf = Buffer.from('odt content')
    mockDownload.mockResolvedValue({ ok: true, arrayBuffer: async () => buf })
    const result = await protocolDocumentPort.downloadDraft(DRAFT_PATH)
    expect(mockDownload).toHaveBeenCalledWith(DAV_DRAFT_FILE, 'admin')
    expect(result).toBeInstanceOf(Buffer)
  })

  it('throws when the Nextcloud download is not ok', async () => {
    mockDownload.mockResolvedValue({ ok: false, status: 500 })
    await expect(protocolDocumentPort.downloadDraft(DRAFT_PATH)).rejects.toThrow('Nextcloud download failed: 500')
  })
})

// #235 (defects 1 & 4): uploadPublishedPdf pushes the rendered PDF into the
// published dir via the genuine nc.upload surface and returns the NC-relative
// path persisted into protocols.pdf_nextcloud_path.
describe('protocolDocumentPort.uploadPublishedPdf', () => {
  beforeEach(() => mockUpload.mockReset())

  it('uploads protocol.pdf into the published dir and returns its NC path', async () => {
    mockUpload.mockResolvedValue(undefined)
    const publishedDir = `/protocols/published/${PROTOCOL_ID}`
    const ncPdfPath = await protocolDocumentPort.uploadPublishedPdf(publishedDir, Buffer.from('pdf'))
    expect(ncPdfPath).toBe(`${publishedDir}/protocol.pdf`)
    const [davUrl, user, body, contentType] = mockUpload.mock.calls[0]
    expect(davUrl).toBe(`/remote.php/dav/files/admin${publishedDir}/protocol.pdf`)
    expect(user).toBe('admin')
    expect(body).toBeInstanceOf(Uint8Array)
    expect(contentType).toBe('application/pdf')
  })
})

// #241: downloadPublishedPdf validates the stored path (published-prefix
// allowlist) before building the admin-credentialed WebDAV download.
describe('protocolDocumentPort.downloadPublishedPdf', () => {
  beforeEach(() => mockDownload.mockReset())

  it('downloads a validated published PDF path', async () => {
    const pdfPath = `/protocols/published/${PROTOCOL_ID}/protocol.pdf`
    mockDownload.mockResolvedValue(new Response('pdf-bytes', { status: 200 }))
    const res = await protocolDocumentPort.downloadPublishedPdf(pdfPath)
    expect(res.status).toBe(200)
    expect(mockDownload).toHaveBeenCalledWith(`/remote.php/dav/files/admin${pdfPath}`, 'admin')
  })

  it('rejects a path outside the published-protocols prefix', async () => {
    await expect(protocolDocumentPort.downloadPublishedPdf('/etc/passwd')).rejects.toMatchObject({ status: 400 })
    expect(mockDownload).not.toHaveBeenCalled()
  })
})
