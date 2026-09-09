import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// G-011 / T2.6 — Collabora-converted HTML is sanitized with DOMPurify before
// being persisted in `protocols.body_html` and before being relayed to the
// calendar-minutes automation. This file pins the route-level wiring:
// the POST publish handler invokes the sanitizer between the Collabora
// conversion step and `updateProtocol(...)` — i.e. the DB write never sees
// the raw HTML.
//
// The sanitizer's own allowlist tests live in
// `gremion-ui/src/lib/server/security/html-sanitize.test.ts` (moved there
// when the sanitizer was extracted from this route into a shared module
// used by the news flow — Wave 3a follow-up, G-011 analog).
//
// boundary rule A3a-2: this route no longer imports protocols/protocol-wopi (which
// pulled in the files module internals). The ODT-download / WebDAV-move /
// PDF-upload ops come from the ProtocolDocumentPort registered in runtime-registry;
// the Collabora converters come from documents/collabora-convert. The test registers
// a fake port whose download/upload bodies drive the genuine NextcloudClient
// surface handles (mockDownload / mockUpload) — pinning the runtime contract the
// old getFile/putFile casts hid — and stubs only the heavyweight Collabora convert
// + WebDAV move.
// ─────────────────────────────────────────────────────────────────────────────

const {
  mockGetProtocol, mockSetProtocolStatus, mockUpdateProtocol,
  mockListResolutions, mockUpdateResolution, mockNextGlobalNr,
  mockGetPollWithOptions,
  mockConvertOdtToHtml, mockConvertOdtToPdf, mockPublishFile,
} = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockSetProtocolStatus: vi.fn(),
  mockUpdateProtocol: vi.fn(),
  mockListResolutions: vi.fn(),
  mockUpdateResolution: vi.fn(),
  mockNextGlobalNr: vi.fn(),
  mockGetPollWithOptions: vi.fn(),
  mockConvertOdtToHtml: vi.fn(),
  mockConvertOdtToPdf: vi.fn(),
  mockPublishFile: vi.fn(),
}))
const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))

const { mockAssignGlobalNrs, mockRecordResolutionAdoptions } = vi.hoisted(() => ({
  mockAssignGlobalNrs: vi.fn(),
  mockRecordResolutionAdoptions: vi.fn(),
}))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  setProtocolStatus: mockSetProtocolStatus,
  updateProtocol: mockUpdateProtocol,
  listResolutions: mockListResolutions,
  updateResolution: mockUpdateResolution,
  nextGlobalNr: mockNextGlobalNr,
  assignGlobalNrs: mockAssignGlobalNrs,
  recordResolutionAdoptions: mockRecordResolutionAdoptions,
}))
// boundary rule A3a-2: the Collabora converters are imported from documents/collabora-convert;
// stub the heavyweight convert-to/{html,pdf} round-trips here.
vi.mock('$lib/server/documents/collabora-convert', () => ({
  convertOdtToHtml: mockConvertOdtToHtml,
  convertOdtToPdf: mockConvertOdtToPdf,
}))
vi.mock('$lib/server/polls/polls-client', () => ({
  NextcloudPollsClient: { getPollWithOptions: mockGetPollWithOptions },
}))
// #235 (defect 3): the publish flow now runs its DB writes inside one
// getDb().begin(...) transaction. The handler passes that tx to the protocol-db
// functions (all mocked here), so the begin shim only needs to invoke the
// callback with a sentinel tx and propagate its resolution/rejection.
const { mockBegin, mockGetDb } = vi.hoisted(() => {
  const begin = vi.fn(async (cb: (tx: unknown) => unknown) => cb({ __tx: true }))
  return { mockBegin: begin, mockGetDb: vi.fn(() => ({ begin })) }
})
vi.mock('$lib/server/db', () => ({ getDb: mockGetDb }))
// INV-5 adoption-time quorum gate: publish refuses a protocol that carries
// binding resolutions when the meeting was not beschlussfähig.
const { mockGetQuorumContext } = vi.hoisted(() => ({ mockGetQuorumContext: vi.fn() }))
vi.mock('$lib/server/governance/quorum', () => ({ getQuorumContext: mockGetQuorumContext }))
vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { CouncilAdmin: 'council-admin' },
}))

// Avoid the outbound calendar-minutes fetch hitting anything during tests.
// G-075 refactor: the publish handler now uses `internalFetch` instead of
// raw `fetch(event.url.origin + ...)`. We mock the helper directly so the
// test continues to inspect the forwarded body without needing to wire up
// INTERNAL_PUSH_SECRET in the test environment. `vi.hoisted` is required
// because `vi.mock` is hoisted above local `const` declarations.
const { fetchSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
}))
vi.mock('$lib/server/internal-fetch', () => ({
  internalFetch: fetchSpy,
}))

import { POST } from './+server'
import {
  registerProtocolDocumentPort,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

// ─────────────────────────────────────────────────────────────────────────────
// POST handler — verify sanitization is wired between conversion and DB write.
// ─────────────────────────────────────────────────────────────────────────────

const submittedProtocol = {
  id: 'p1',
  committee_id: 'c1',
  title: 'VV April',
  meeting_date: '2026-04-16',
  status: 'submitted',
  nextcloud_draft_path: '/protocols/drafts/p1.odt',
  approval_poll_id: '42',
}

const expiredPassingPoll = {
  status: { expired: true },
  options: [
    { text: 'Ja', votes: { yes: 5 } },
    { text: 'Nein', votes: { yes: 1 } },
  ],
}

function makeEvent() {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin'] } },
    params: { id: 'p1' },
    url: { origin: 'http://localhost:4001' },
    request: { headers: { get: () => '' } },
  } as unknown as Parameters<typeof POST>[0]
}

describe('POST /api/protocols/[id]/publish — body_html sanitization', () => {
  // #235 (defect 1): the per-test handles for the genuine NextcloudClient surface
  // (download/upload), driven by the registered ProtocolDocumentPort's REAL
  // download/upload bodies. Assigned fresh in beforeEach so each test can assert
  // on them in isolation.
  // vitest 4 widened vi.fn's generic constraint to `Procedure | Constructable`
  // (to support mocking constructors), so bare `ReturnType<typeof vi.fn>` now
  // resolves to a union whose construct-only branch has no call signature —
  // `Mock` (default `Procedure`) pins this back to a plain callable mock.
  let mockDownload: Mock
  let mockUpload: Mock

  // The registered port reproduces the genuine document-op bodies: downloadDraft
  // buffers an nc.download Response (throwing on !ok), uploadPublishedPdf pushes a
  // Uint8Array via nc.upload and returns the NC-relative protocol.pdf path. Only
  // publishFile (the WebDAV move) is a bare stub (mockPublishFile) so the INV-5
  // fail-fast test can assert it was never reached.
  function registerRealBodyPort() {
    const port: ProtocolDocumentPort = {
      createDraftFile: vi.fn(),
      getDraftWopiToken: vi.fn(),
      deleteDraftFile: vi.fn(),
      publishFile: mockPublishFile,
      async downloadDraft(draftPath: string): Promise<Buffer> {
        const res = await mockDownload(draftPath)
        if (!res.ok) throw new Error(`Nextcloud download failed: ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      },
      async uploadPublishedPdf(publishedDir: string, pdfBuffer: Buffer): Promise<string> {
        const ncPdfPath = `${publishedDir.replace(/\/$/, '')}/protocol.pdf`
        await mockUpload(ncPdfPath, 'admin', new Uint8Array(pdfBuffer), 'application/pdf')
        return ncPdfPath
      },
      downloadPublishedPdf: vi.fn(),
    }
    registerProtocolDocumentPort(port)
  }

  beforeEach(() => {
    _resetRuntimeRegistryForTests()
    mockGetProtocol.mockReset()
    mockSetProtocolStatus.mockReset()
    mockUpdateProtocol.mockReset()
    mockListResolutions.mockReset()
    mockUpdateResolution.mockReset()
    mockNextGlobalNr.mockReset()
    mockAssignGlobalNrs.mockReset()
    mockRecordResolutionAdoptions.mockReset()
    mockGetPollWithOptions.mockReset()
    mockConvertOdtToHtml.mockReset()
    mockConvertOdtToPdf.mockReset()
    mockPublishFile.mockReset()
    mockBegin.mockClear()
    mockGetDb.mockClear()
    mockGetQuorumContext.mockReset()
    mockHasRole.mockReturnValue(true)
    // default: meeting was quorate (most tests don't exercise the gate)
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
    fetchSpy.mockClear()

    mockGetProtocol.mockResolvedValue(submittedProtocol)
    mockGetPollWithOptions.mockResolvedValue(expiredPassingPoll)
    // #235 (defect 1): the genuine NextcloudClient surface is download()/upload().
    // download() returns a Response (the port buffers it); upload() returns void.
    mockDownload = vi.fn().mockResolvedValue(new Response('odt'))
    mockUpload = vi.fn().mockResolvedValue(undefined)
    registerRealBodyPort()
    mockConvertOdtToHtml.mockResolvedValue('<p>default</p>')
    mockConvertOdtToPdf.mockResolvedValue(Buffer.from('pdf'))
    mockPublishFile.mockResolvedValue('/protocols/published/p1')
    mockListResolutions.mockResolvedValue([])
    mockAssignGlobalNrs.mockResolvedValue([])
    mockRecordResolutionAdoptions.mockResolvedValue(0)
    mockSetProtocolStatus.mockResolvedValue(submittedProtocol)
    mockUpdateProtocol.mockResolvedValue({ ...submittedProtocol, status: 'published' })
  })

  it('stores sanitized body_html (no <script>) and never the raw HTML', async () => {
    mockConvertOdtToHtml.mockResolvedValue(
      '<p>Agenda</p><script>fetch("/leak")</script><p>Item 1</p>'
    )

    const res = await POST(makeEvent())
    expect(res.status).toBe(200)

    expect(mockUpdateProtocol).toHaveBeenCalledOnce()
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(updateArg.bodyHtml).toBeDefined()
    expect(updateArg.bodyHtml).not.toContain('<script')
    expect(updateArg.bodyHtml).not.toContain('fetch("/leak")')
    expect(updateArg.bodyHtml).toContain('<p>Agenda</p>')
    expect(updateArg.bodyHtml).toContain('<p>Item 1</p>')
  })

  it('strips <iframe> before DB write', async () => {
    mockConvertOdtToHtml.mockResolvedValue(
      '<p>ok</p><iframe src="https://evil.example.com/"></iframe>'
    )
    await POST(makeEvent())
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(updateArg.bodyHtml).not.toContain('<iframe')
    expect(updateArg.bodyHtml).not.toContain('evil.example.com')
  })

  it('strips onerror attributes before DB write', async () => {
    mockConvertOdtToHtml.mockResolvedValue(
      '<img src="x.png" onerror="alert(1)" alt="boom">'
    )
    await POST(makeEvent())
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(updateArg.bodyHtml).not.toMatch(/onerror/i)
    expect(updateArg.bodyHtml).not.toContain('alert(1)')
  })

  it('strips data: URIs in img src before DB write', async () => {
    mockConvertOdtToHtml.mockResolvedValue(
      '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="x">'
    )
    await POST(makeEvent())
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(updateArg.bodyHtml).not.toContain('data:image')
    expect(updateArg.bodyHtml).not.toContain('PHN2Zy8+')
  })

  it('preserves safe markup end-to-end through the publish flow', async () => {
    const safe = '<p>Hello <strong>world</strong></p>'
    mockConvertOdtToHtml.mockResolvedValue(safe)
    await POST(makeEvent())
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { bodyHtml?: string }
    expect(updateArg.bodyHtml).toBe(safe)
  })

  // Carve note: the publish flow no longer forwards the sanitized minutes HTML to
  // the calendar-minutes automation (internalFetch('/api/calendar/automations/
  // minutes')) — the calendar module is not part of the governance-only kernel,
  // so that trigger was removed from the route. The body-html sanitization itself
  // is still covered above via the updateProtocol(bodyHtml) assertions.

  // ───────────────────────────────────────────────────────────────────────────
  // #235 — the 5 publish-flow defects.
  // ───────────────────────────────────────────────────────────────────────────

  it('#1: resolves 200 against the real download/upload contract (no getFile/putFile)', async () => {
    const res = await POST(makeEvent())
    expect(res.status).toBe(200)
    // The handler must have driven the genuine NextcloudClient surface via the port.
    expect(mockDownload).toHaveBeenCalled()
    expect(mockUpload).toHaveBeenCalled()
    // upload is the PDF push; its body is the converted PDF bytes (a
    // Uint8Array — Buffer is also a Uint8Array, so this matches either form).
    const uploadArgs = mockUpload.mock.calls[0]
    expect(uploadArgs.some((a: unknown) => a instanceof Uint8Array)).toBe(true)
  })

  it('#3: calls updateProtocol BEFORE setProtocolStatus, and updateProtocol carries pdfNextcloudPath', async () => {
    await POST(makeEvent())
    expect(mockUpdateProtocol).toHaveBeenCalledOnce()
    expect(mockSetProtocolStatus).toHaveBeenCalledOnce()
    const updateOrder = mockUpdateProtocol.mock.invocationCallOrder[0]
    const statusOrder = mockSetProtocolStatus.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(statusOrder)
    // #4: the PDF path is persisted into pdf_nextcloud_path via updateProtocol.
    const updateArg = mockUpdateProtocol.mock.calls[0][1] as { pdfNextcloudPath?: string }
    expect(updateArg.pdfNextcloudPath).toBeDefined()
    expect(updateArg.pdfNextcloudPath).toContain('protocol.pdf')
  })

  it('#3: when updateProtocol rejects, the whole op rejects (no published-state write persists)', async () => {
    mockUpdateProtocol.mockRejectedValueOnce(new Error('db write failed'))
    await expect(POST(makeEvent())).rejects.toThrow()
    // updateProtocol runs first inside the tx and throws, so setProtocolStatus
    // (the published-state write) must never be reached — the single sql.begin
    // rolls the whole unit back.
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
    // The DB work ran inside exactly one transaction.
    expect(mockBegin).toHaveBeenCalledOnce()
  })

  // Carve note: #5 (the calendar-minutes trigger logging a non-ok status while the
  // POST still 200s) tested the now-removed calendar automation hook. With the
  // trigger gone there is no minutes fetch to fail, so the case is dropped. The
  // publish flow's own success/200 contract stays covered by #1/#3 above.

  // ───────────────────────────────────────────────────────────────────────────
  // INV-5 adoption-time quorum gate (Governance Core).
  // ───────────────────────────────────────────────────────────────────────────

  it('blocks publish (422) when the protocol has a binding resolution but the meeting was not quorate', async () => {
    mockListResolutions.mockResolvedValue([{ id: 'r1', result: 'passed' }])
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 1, quorate: false })

    await expect(POST(makeEvent())).rejects.toMatchObject({ status: 422 })
    expect(mockGetQuorumContext).toHaveBeenCalled()
    // fail-fast: the gate runs before any Nextcloud side-effect or DB write
    expect(mockPublishFile).not.toHaveBeenCalled()
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
  })

  it('allows publish when a binding resolution exists and the meeting was quorate', async () => {
    mockListResolutions.mockResolvedValue([{ id: 'r1', result: 'passed' }])
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })

    const res = await POST(makeEvent())
    expect(res.status).toBe(200)
    expect(mockSetProtocolStatus).toHaveBeenCalledOnce()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // #320 (ported gremion#22 M3b) — adoption recording (decided_at + audit chain).
  // The route wires recordResolutionAdoptions into the SAME publish tx; the
  // behavioural contract (decided_at set, exactly-one audit row per binding
  // resolution, none for withdrawn, chain stays intact) is verified against a
  // real DB in protocols/resolution-adoption.integration.test.ts.
  // ───────────────────────────────────────────────────────────────────────────

  it('#320: records adoptions on the publish tx — with the adopting user + resolutions — after numbering, before the status flip', async () => {
    const resolutions = [{ id: 'r1', result: 'passed' }]
    mockListResolutions.mockResolvedValue(resolutions)
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })

    const res = await POST(makeEvent())
    expect(res.status).toBe(200)

    expect(mockRecordResolutionAdoptions).toHaveBeenCalledOnce()
    const [userId, passedResolutions, tx] = mockRecordResolutionAdoptions.mock.calls[0]
    expect(userId).toBe('u1') // the adopting admin (locals.user.id)
    expect(passedResolutions).toEqual(resolutions)
    expect(tx).toMatchObject({ __tx: true }) // ran on the begin() tx, not the pool

    // Ordering inside the tx: number the resolutions, THEN record the decision,
    // THEN flip to published.
    const adoptOrder = mockRecordResolutionAdoptions.mock.invocationCallOrder[0]
    const assignOrder = mockAssignGlobalNrs.mock.invocationCallOrder[0]
    const statusOrder = mockSetProtocolStatus.mock.invocationCallOrder[0]
    expect(assignOrder).toBeLessThan(adoptOrder)
    expect(adoptOrder).toBeLessThan(statusOrder)
  })

  it('#320: a failing adoption record rolls the whole publish back (status never flips)', async () => {
    mockListResolutions.mockResolvedValue([{ id: 'r1', result: 'passed' }])
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 2, quorate: true })
    mockRecordResolutionAdoptions.mockRejectedValueOnce(new Error('audit write failed'))

    await expect(POST(makeEvent())).rejects.toThrow()
    // recordResolutionAdoptions runs before setProtocolStatus in the tx, so a
    // throw there means the published-state write is never reached.
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
    expect(mockBegin).toHaveBeenCalledOnce()
  })

  it('does not require quorum when the only resolutions are withdrawn', async () => {
    mockListResolutions.mockResolvedValue([{ id: 'r1', result: 'withdrawn' }])
    mockGetQuorumContext.mockResolvedValue({ eligibleVotingCount: 3, presentVotingCount: 0, quorate: false })

    const res = await POST(makeEvent())
    expect(res.status).toBe(200)
    expect(mockGetQuorumContext).not.toHaveBeenCalled() // gate skipped for a withdrawn-only protocol
  })

  // boundary rule A3a-2 degradation: no ProtocolDocumentPort registered -> 503, before
  // any Collabora conversion or DB write.
  it('returns 503 when no ProtocolDocumentPort is registered', async () => {
    _resetRuntimeRegistryForTests() // drop the port — files module absent
    await expect(POST(makeEvent())).rejects.toMatchObject({ status: 503 })
    expect(mockConvertOdtToHtml).not.toHaveBeenCalled()
    expect(mockSetProtocolStatus).not.toHaveBeenCalled()
  })
})
