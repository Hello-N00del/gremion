import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSql = vi.hoisted(() => {
  const fn = vi.fn()
  fn.mockImplementation((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]))
  // #235 (defect 3): the publish flow runs updateProtocol + setProtocolStatus +
  // the per-resolution global_nr assignment inside ONE getDb().begin(...) tx.
  // The protocol-db functions select their SQL runner with getRunner(tx, …), so
  // when a tx is passed they must issue every query on THAT handle. This shim
  // hands the same mockSql in as `tx`, so .begin transparently runs the callback
  // and every query inside it is still recorded on mockSql.mock.calls — letting
  // the tests assert ordering/atomicity without a real database.
  ;(fn as unknown as { begin: (cb: (tx: typeof fn) => unknown) => unknown }).begin = (
    cb: (tx: typeof fn) => unknown,
  ) => cb(fn)
  return fn
})

vi.mock('../db', () => ({ getDb: () => mockSql }))

import {
  createProtocol,
  getProtocol,
  listProtocols,
  updateProtocol,
  setProtocolStatus,
  upsertAttendance,
  addResolution,
  updateResolution,
  deleteResolution,
  addActionItem,
  updateActionItem,
  nextGlobalNr,
  assignGlobalNrs,
  getBeschlussregisterSettings,
  upsertBeschlussregisterSettings,
} from './protocol-db'

describe('createProtocol', () => {
  beforeEach(() => mockSql.mockReset())

  it('inserts and returns the new protocol', async () => {
    const now = new Date().toISOString()
    mockSql.mockResolvedValueOnce([{
      id: 'proto-uuid',
      committee_id: 'comm-1',
      meeting_date: '2026-04-16',
      location: 'Raum A',
      title: 'VV April',
      body_html: null,
      status: 'draft',
      guest_edit_enabled: false,
      approval_poll_id: null,
      revision_notes: null,
      nextcloud_draft_path: null,
      nextcloud_published_path: null,
      created_by: 'user-1',
      created_at: now,
      updated_at: now,
    }])

    const result = await createProtocol({
      committeeId: 'comm-1',
      meetingDate: '2026-04-16',
      location: 'Raum A',
      title: 'VV April',
      createdBy: 'user-1',
    })

    expect(result.id).toBe('proto-uuid')
    expect(result.status).toBe('draft')
    expect(mockSql).toHaveBeenCalledOnce()
  })
})

describe('setProtocolStatus', () => {
  beforeEach(() => mockSql.mockReset())

  it('throws if trying to update a published protocol', async () => {
    mockSql.mockResolvedValueOnce([{ status: 'published' }])
    await expect(setProtocolStatus('proto-uuid', 'draft')).rejects.toThrow('published')
  })

  it('updates status when not published', async () => {
    mockSql
      .mockResolvedValueOnce([{ status: 'draft' }])
      .mockResolvedValueOnce([{ id: 'proto-uuid', status: 'submitted' }])
    const result = await setProtocolStatus('proto-uuid', 'submitted')
    expect(result.status).toBe('submitted')
  })
})

describe('nextGlobalNr', () => {
  beforeEach(() => mockSql.mockReset())

  it('returns B-2026-001 for the first resolution in a committee in 2026', async () => {
    mockSql.mockResolvedValueOnce([{ count: '0' }])
    const nr = await nextGlobalNr('comm-1', 2026)
    expect(nr).toBe('B-2026-001')
  })

  it('returns B-2026-004 when 3 already exist', async () => {
    mockSql.mockResolvedValueOnce([{ count: '3' }])
    const nr = await nextGlobalNr('comm-1', 2026)
    expect(nr).toBe('B-2026-004')
  })
})

describe('assignGlobalNrs (#235 defect 2 — sequential/atomic numbering)', () => {
  beforeEach(() => mockSql.mockReset())

  // The previous Promise.all + check-then-act nextGlobalNr handed the SAME
  // count (and thus the SAME B-number) to every resolution. The fix assigns
  // numbers sequentially inside one tx so each COUNT(*) observes the prior
  // UPDATE. This stateful mock proves DISTINCT, monotonic numbers: every
  // assigned global_nr increments the count the next COUNT(*) reads back.
  function statefulCounter() {
    let assigned = 0
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      // Guard: vitest invokes the value RETURNED from a beforeEach as a teardown
      // hook, and `mockSql.mockReset()` returns `mockSql` — so this impl is also
      // called once with no args at teardown. Ignore that call.
      if (!strings) return Promise.resolve([])
      const text = strings.join(' ')
      if (text.includes('COUNT(*)')) {
        return Promise.resolve([{ count: String(assigned) }])
      }
      if (text.includes('UPDATE protocol_resolutions') && text.includes('global_nr')) {
        assigned += 1
        return Promise.resolve([{ id: `r${assigned}`, global_nr: `assigned-${assigned}` }])
      }
      return Promise.resolve([])
    })
  }

  it('assigns DISTINCT sequential numbers B-2026-001, 002, 003 to 3 resolutions', async () => {
    statefulCounter()
    const nrs = await assignGlobalNrs('comm-1', 2026, ['r1', 'r2', 'r3'], mockSql as never)
    expect(nrs).toEqual(['B-2026-001', 'B-2026-002', 'B-2026-003'])
    // No duplicates — the load-bearing invariant the racing version violated.
    expect(new Set(nrs).size).toBe(3)
  })

  it('runs every query on the passed tx handle (atomicity)', async () => {
    statefulCounter()
    await assignGlobalNrs('comm-1', 2026, ['r1', 'r2'], mockSql as never)
    // 2 resolutions => 2 COUNT(*) + 2 UPDATE = 4 queries, all on mockSql (the tx).
    expect(mockSql).toHaveBeenCalledTimes(4)
  })
})

describe('updateProtocol (#235 defect 4 — pdf_nextcloud_path column)', () => {
  beforeEach(() => mockSql.mockReset())

  it('includes pdf_nextcloud_path in the UPDATE column set when pdfNextcloudPath is passed', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'p1', status: 'submitted' }])
    await updateProtocol('p1', { pdfNextcloudPath: '/protocols/published/p1/protocol.pdf' })
    const strings = mockSql.mock.calls[0][0] as TemplateStringsArray
    const sqlText = strings.join('?')
    expect(sqlText).toContain('pdf_nextcloud_path')
    // The interpolated value must be carried as a bound parameter.
    expect(mockSql.mock.calls[0]).toContain('/protocols/published/p1/protocol.pdf')
  })

  it('runs the UPDATE on the passed tx handle and neutralises the published-guard when allowPublished', async () => {
    const txSql = vi.fn().mockResolvedValue([{ id: 'p1', status: 'submitted' }])
    await updateProtocol('p1', { bodyHtml: '<p>x</p>' }, { tx: txSql as never, allowPublished: true })
    // The query ran on the caller's tx, NOT on getDb()/mockSql.
    expect(txSql).toHaveBeenCalledOnce()
    expect(mockSql).not.toHaveBeenCalled()
    // The published-guard is gated by a bound boolean that is `true` here, so an
    // already-published row would still be updated by the publish tx.
    expect(txSql.mock.calls[0]).toContain(true)
    const sqlText = (txSql.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sqlText).toContain("status != 'published'")
  })
})
