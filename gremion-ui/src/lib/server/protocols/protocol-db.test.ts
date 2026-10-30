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
  updateProtocol,
  deleteProtocol,
  updateResolution,
  deleteResolution,
  ResolutionPublishedError,
  ResolutionNotFoundError,
  setProtocolStatus,
  nextGlobalNr,
  assignGlobalNrs,
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

  it('writes global_nr with allowPublished=true (runs inside the publish tx and on republish)', async () => {
    statefulCounter()
    await assignGlobalNrs('comm-1', 2026, ['r1', 'r2'], mockSql as never)
    const updates = mockSql.mock.calls.filter((c) =>
      (c[0] as TemplateStringsArray).join('?').includes('UPDATE protocol_resolutions'),
    )
    expect(updates).toHaveLength(2)
    // The publish-lock bypass is a bound boolean param; it must be `true` here, or
    // the lock would refuse the numbering write on a protocol that is (being) published.
    for (const call of updates) expect(call).toContain(true)
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

// ─── Atomic publish lock (#433 / #454) ───────────────────────────────────────
//
// The route's read-then-write check (loadEditableResolution) leaves a window in
// which a publish can commit between the SELECT and the write. The lock must
// therefore ride IN the write statement. A mocked sql cannot evaluate a WHERE
// clause, so this stand-in derives the match from what the statement ACTUALLY
// emits: it only refuses a published parent when the emitted SQL carries the
// `status != 'published'` predicate AND the bound allowPublished flag is not
// true. A statement without the predicate therefore writes (and the test
// fails), instead of a canned [] answer hiding the missing guard.
describe('atomic publish lock (#433, #454)', () => {
  type Row = { id: string }

  function standIn(parentStatus: 'draft' | 'submitted' | 'published', opts: { rowExists?: boolean } = {}) {
    const rowExists = opts.rowExists ?? true
    return vi.fn((strings?: TemplateStringsArray, ...values: unknown[]) => {
      // vitest calls the value returned from a beforeEach as teardown (see above).
      if (!strings) return Promise.resolve([])
      const text = strings.join('?')
      // The follow-up read that tells "locked" from "gone" after a zero-row write.
      if (text.includes('SELECT id FROM protocol_resolutions')) {
        return Promise.resolve(rowExists ? ([{ id: 'x1' }] as Row[]) : [])
      }
      if (!rowExists) return Promise.resolve([])
      const guarded = text.includes("status != 'published'")
      const bypass = values.includes(true)
      const refused = guarded && !bypass && parentStatus === 'published'
      const wantsRows = text.includes('RETURNING')
      return Promise.resolve(refused || !wantsRows ? [] : ([{ id: 'x1' }] as Row[]))
    })
  }

  beforeEach(() => mockSql.mockReset())

  describe('updateResolution', () => {
    it('rejects with ResolutionPublishedError when the parent protocol is published', async () => {
      const tx = standIn('published')
      await expect(updateResolution('r1', { text: 'edited' }, { tx: tx as never }))
        .rejects.toBeInstanceOf(ResolutionPublishedError)
    })

    it('embeds the lock in the emitted statement (EXISTS on the parent, not a prior SELECT)', async () => {
      const tx = standIn('draft')
      await updateResolution('r1', { text: 'edited' }, { tx: tx as never })
      expect(tx).toHaveBeenCalledOnce()
      const text = (tx.mock.calls[0][0] as TemplateStringsArray).join('?')
      expect(text).toContain("status != 'published'")
      expect(text).toContain('EXISTS')
    })

    it('locks the parent row and the adopted stamp inside the statement (FOR SHARE, decided_at IS NULL)', async () => {
      // The EXISTS sub-SELECT alone reads the statement snapshot and misses a publish
      // that commits while this statement waits; FOR SHARE makes it wait for the
      // publish and re-read, decided_at IS NULL is re-checked on the target row.
      // Proven against real Postgres in protocol-publish-lock.integration.test.ts.
      const tx = standIn('draft')
      await updateResolution('r1', { text: 'edited' }, { tx: tx as never })
      const text = (tx.mock.calls[0][0] as TemplateStringsArray).join('?')
      expect(text).toMatch(/FOR SHARE/)
      expect(text).toContain('decided_at IS NULL')
    })

    it('a row that no longer exists is ResolutionNotFoundError, not a publish refusal', async () => {
      const tx = standIn('draft', { rowExists: false })
      await expect(updateResolution('r1', { text: 'edited' }, { tx: tx as never }))
        .rejects.toBeInstanceOf(ResolutionNotFoundError)
    })

    it('still writes while the parent is a draft', async () => {
      const tx = standIn('draft')
      await expect(updateResolution('r1', { text: 'edited' }, { tx: tx as never })).resolves.toMatchObject({ id: 'x1' })
    })

    it('allowPublished=true bypasses the lock (publish tx / republish numbering)', async () => {
      const tx = standIn('published')
      await expect(updateResolution('r1', { globalNr: 'B-2026-001' }, { tx: tx as never, allowPublished: true }))
        .resolves.toMatchObject({ id: 'x1' })
    })

    it('runs on the passed tx, not on getDb()', async () => {
      const tx = standIn('draft')
      await updateResolution('r1', { text: 'edited' }, { tx: tx as never })
      expect(tx).toHaveBeenCalledOnce()
      expect(mockSql).not.toHaveBeenCalled()
    })

    it('a published resolution survives the attempt: the edit is refused, not applied', async () => {
      mockSql.mockImplementation(standIn('published'))
      await expect(updateResolution('r1', { text: 'tampered' })).rejects.toBeInstanceOf(ResolutionPublishedError)
    })
  })

  describe('deleteResolution', () => {
    it('rejects with ResolutionPublishedError when the parent protocol is published', async () => {
      mockSql.mockImplementation(standIn('published'))
      await expect(deleteResolution('r1')).rejects.toBeInstanceOf(ResolutionPublishedError)
    })

    it('embeds the lock in the emitted DELETE', async () => {
      mockSql.mockImplementation(standIn('draft'))
      await deleteResolution('r1')
      const text = (mockSql.mock.calls[0][0] as TemplateStringsArray).join('?')
      expect(text).toContain('DELETE FROM protocol_resolutions')
      expect(text).toContain("status != 'published'")
      expect(text).toContain('RETURNING')
    })

    it('locks the parent row and the adopted stamp inside the DELETE (FOR SHARE, decided_at IS NULL)', async () => {
      mockSql.mockImplementation(standIn('draft'))
      await deleteResolution('r1')
      const text = (mockSql.mock.calls[0][0] as TemplateStringsArray).join('?')
      expect(text).toMatch(/FOR SHARE/)
      expect(text).toContain('decided_at IS NULL')
    })

    it('a row that no longer exists is ResolutionNotFoundError, not a publish refusal', async () => {
      mockSql.mockImplementation(standIn('draft', { rowExists: false }))
      await expect(deleteResolution('r1')).rejects.toBeInstanceOf(ResolutionNotFoundError)
    })

    it('deletes while the parent is a draft', async () => {
      mockSql.mockImplementation(standIn('draft'))
      await expect(deleteResolution('r1')).resolves.toBeUndefined()
    })

    it('allowPublished=true bypasses the lock', async () => {
      const tx = standIn('published')
      await expect(deleteResolution('r1', { tx: tx as never, allowPublished: true })).resolves.toBeUndefined()
      expect(tx).toHaveBeenCalledOnce()
    })
  })

  describe('deleteProtocol', () => {
    it('refuses to delete a published protocol', async () => {
      mockSql.mockImplementation(standIn('published'))
      await expect(deleteProtocol('p1')).rejects.toThrow('Protocol p1 not found or is published')
    })

    it('carries the guard and RETURNING id in the emitted DELETE', async () => {
      mockSql.mockImplementation(standIn('draft'))
      await deleteProtocol('p1')
      const text = (mockSql.mock.calls[0][0] as TemplateStringsArray).join('?')
      expect(text).toContain("status != 'published'")
      expect(text).toContain('RETURNING')
    })

    it('deletes a draft protocol (rollback of a just-created draft)', async () => {
      mockSql.mockImplementation(standIn('draft'))
      await expect(deleteProtocol('p1')).resolves.toBeUndefined()
    })

    it('allowPublished=true bypasses the guard, on the passed tx', async () => {
      const tx = standIn('published')
      await expect(deleteProtocol('p1', { tx: tx as never, allowPublished: true })).resolves.toBeUndefined()
      expect(tx).toHaveBeenCalledOnce()
      expect(mockSql).not.toHaveBeenCalled()
    })
  })
})
