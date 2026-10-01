// R29-F104-KTWIN (kernel twin of F1-FIX-04 / H19, S3#27, S3#28; ledger K2#4):
// committee_only visibility and draft status were never enforced on the kernel
// protocol read surfaces, so any signed-in user -- Guests included -- read every
// committee's drafts, attendance, resolutions and action items, and any Member
// could mint a Collabora edit token for another committee's draft.
//
// Operator decision D-3 (R29-I16, binding): a Guest sees NOTHING of a
// committee_only unit and no drafts at all -- only published protocols of
// all_members units. A Member sees the all_members units plus their own units;
// a CouncilAdmin sees everything. Editing a draft (wopi-token) needs unit
// membership or CouncilAdmin, whatever the unit's visibility.
//
// The role helper ($lib/auth) is REAL here on purpose: the existing route tests
// mock hasRole, which makes every caller an admin and is exactly why no test
// ever saw this defect.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

type Status = 'draft' | 'submitted' | 'published'
interface Unit { id: string; visibility: 'all_members' | 'committee_only' }
interface Proto { id: string; committee_id: string; status: Status }

const UNITS: Record<string, Unit> = {
  'u-closed': { id: 'u-closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', visibility: 'all_members' },
}
const PROTOCOLS: Proto[] = [
  { id: 'p-closed-draft', committee_id: 'u-closed', status: 'draft' },
  { id: 'p-closed-pub', committee_id: 'u-closed', status: 'published' },
  { id: 'p-open-draft', committee_id: 'u-open', status: 'draft' },
  { id: 'p-open-pub', committee_id: 'u-open', status: 'published' },
]
// user id -> org units the user is a member of
const MEMBERSHIPS: Record<string, string[]> = {
  'unit-member': ['u-closed'],
}

const h = vi.hoisted(() => ({
  getDraftWopiToken: vi.fn(),
  listAttendance: vi.fn(),
}))

vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: vi.fn(async (id: string) => {
    const p = PROTOCOLS.find((x) => x.id === id)
    return p ? { ...p, title: p.id, guest_edit_enabled: false, nextcloud_draft_path: `/drafts/${p.id}.odt` } : null
  }),
  listProtocols: vi.fn(async (params: { committeeId: string; status?: Status }) =>
    PROTOCOLS.filter((p) => p.committee_id === params.committeeId && (!params.status || p.status === params.status))
      .map((p) => ({ ...p, title: p.id })),
  ),
  listAttendance: h.listAttendance,
  listResolutions: vi.fn(async () => []),
  listActionItems: vi.fn(async () => []),
  createProtocol: vi.fn(),
  updateProtocol: vi.fn(),
  deleteProtocol: vi.fn(),
  upsertAttendance: vi.fn(),
}))

vi.mock('$lib/server/governance/protocols-db', () => ({
  listProtocols: vi.fn(async () =>
    PROTOCOLS.map((p) => ({
      id: p.id,
      title: p.id,
      meetingDate: '2026-09-01',
      status: p.status,
      committeeId: p.committee_id,
      committeeName: p.committee_id,
      visibility: UNITS[p.committee_id]!.visibility,
      attended: 0,
      total: 0,
      tops: 0,
    })),
  ),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
  getOrgUnitIdsForUser: vi.fn(async (userId: string) => MEMBERSHIPS[userId] ?? []),
}))

import { GET as listGET } from './+server'
import { GET as oneGET } from './[id]/+server'
import { GET as wopiGET } from './[id]/wopi-token/+server'
import { load as pageLoad } from '../../protokolle/+page.server'
import {
  registerProtocolDocumentPort,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

const GUEST = { id: 'guest', roles: [Role.Guest], groups: [], email: 'g@example.org', name: 'g' }
const STRANGER = { id: 'stranger', roles: [Role.Member], groups: [], email: 's@example.org', name: 's' }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member], groups: [], email: 'm@example.org', name: 'm' }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'a' }
type Viewer = typeof GUEST

function ev(user: Viewer, opts: { params?: Record<string, string>; search?: Record<string, string> } = {}) {
  return {
    locals: { user },
    params: opts.params ?? {},
    url: new URL(`http://localhost/api/protocols?${new URLSearchParams(opts.search ?? {})}`),
    request: new Request('http://localhost/api/protocols'),
  } as never
}

async function statusOf(run: () => Promise<Response> | Response): Promise<number> {
  try {
    return (await run()).status
  } catch (e) {
    return (e as { status?: number })?.status ?? -1
  }
}

async function listIds(user: Viewer, committeeId: string): Promise<string[]> {
  const res = (await listGET(ev(user, { search: { committeeId } }))) as Response
  if (res.status !== 200) return []
  const body = (await res.json()) as { protocols: Array<{ id: string }> }
  return body.protocols.map((p) => p.id).sort()
}

async function pageIds(user: Viewer): Promise<string[]> {
  const out = (await pageLoad(ev(user))) as unknown as { protocols: Array<{ id: string }> }
  return out.protocols.map((p) => p.id).sort()
}

beforeEach(() => {
  _resetRuntimeRegistryForTests()
  h.listAttendance.mockReset().mockResolvedValue([])
  h.getDraftWopiToken.mockReset().mockResolvedValue({ editorUrl: 'http://collabora/edit', tokenTtl: 60 })
  registerProtocolDocumentPort({
    getDraftWopiToken: h.getDraftWopiToken,
    createDraftFile: vi.fn(),
    deleteDraftFile: vi.fn(),
    downloadDraft: vi.fn(),
    publishFile: vi.fn(),
    uploadPublishedPdf: vi.fn(),
    downloadPublishedPdf: vi.fn(),
  } as unknown as ProtocolDocumentPort)
})

describe('D-3 Guest: nothing of committee_only, no drafts, only published all_members protocols', () => {
  it('/protokolle load shows the Guest only the published protocol of the all_members unit', async () => {
    expect(await pageIds(GUEST)).toEqual(['p-open-pub'])
  })

  it('GET /api/protocols lists nothing of the committee_only unit and no draft of the open unit', async () => {
    expect(await listIds(GUEST, 'u-closed')).toEqual([])
    expect(await listIds(GUEST, 'u-open')).toEqual(['p-open-pub'])
  })

  it('GET /api/protocols/[id] refuses committee_only protocols and drafts (404), allows the public one', async () => {
    for (const id of ['p-closed-draft', 'p-closed-pub', 'p-open-draft']) {
      expect(await statusOf(() => oneGET(ev(GUEST, { params: { id } }))), id).toBe(404)
    }
    expect(h.listAttendance).not.toHaveBeenCalled()
    expect(await statusOf(() => oneGET(ev(GUEST, { params: { id: 'p-open-pub' } })))).toBe(200)
  })
})

describe('Member who is not in the committee_only unit', () => {
  it('/protokolle load omits every protocol of the committee_only unit', async () => {
    expect(await pageIds(STRANGER)).toEqual(['p-open-draft', 'p-open-pub'])
  })

  it('GET /api/protocols and /api/protocols/[id] hide the committee_only unit with a 404', async () => {
    const res = (await listGET(ev(STRANGER, { search: { committeeId: 'u-closed' } }))) as Response
    expect(res.status).toBe(404)
    expect(await statusOf(() => oneGET(ev(STRANGER, { params: { id: 'p-closed-draft' } })))).toBe(404)
    expect(await statusOf(() => oneGET(ev(STRANGER, { params: { id: 'p-open-draft' } })))).toBe(200)
  })

  it('wopi-token: 403 for another committee draft, whatever the unit visibility (S3#28)', async () => {
    expect(await statusOf(() => wopiGET(ev(STRANGER, { params: { id: 'p-closed-draft' } })))).toBe(403)
    expect(await statusOf(() => wopiGET(ev(STRANGER, { params: { id: 'p-open-draft' } })))).toBe(403)
    expect(h.getDraftWopiToken).not.toHaveBeenCalled()
  })
})

describe('unit member and CouncilAdmin still see and edit the committee_only draft', () => {
  it('the unit member sees every protocol of their own unit plus the open unit', async () => {
    expect(await pageIds(UNIT_MEMBER)).toEqual(['p-closed-draft', 'p-closed-pub', 'p-open-draft', 'p-open-pub'])
    expect(await listIds(UNIT_MEMBER, 'u-closed')).toEqual(['p-closed-draft', 'p-closed-pub'])
    expect(await statusOf(() => oneGET(ev(UNIT_MEMBER, { params: { id: 'p-closed-draft' } })))).toBe(200)
    expect(await statusOf(() => wopiGET(ev(UNIT_MEMBER, { params: { id: 'p-closed-draft' } })))).toBe(200)
  })

  it('an unknown unit is a 404 for every role, the CouncilAdmin included', async () => {
    for (const user of [ADMIN, UNIT_MEMBER, STRANGER]) {
      const res = (await listGET(ev(user, { search: { committeeId: 'u-missing' } }))) as Response
      expect(res.status).toBe(404)
    }
  })

  it('the CouncilAdmin sees everything', async () => {
    expect(await pageIds(ADMIN)).toEqual(['p-closed-draft', 'p-closed-pub', 'p-open-draft', 'p-open-pub'])
    expect(await listIds(ADMIN, 'u-closed')).toEqual(['p-closed-draft', 'p-closed-pub'])
    expect(await statusOf(() => oneGET(ev(ADMIN, { params: { id: 'p-closed-draft' } })))).toBe(200)
    expect(await statusOf(() => wopiGET(ev(ADMIN, { params: { id: 'p-closed-draft' } })))).toBe(200)
  })
})
