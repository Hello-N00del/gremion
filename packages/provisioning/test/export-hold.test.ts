// How long a switched-off module's export outlives day 30, and the day-30 entry point of the modules port that
// hands that decision to the Karenz job. Pure: the lifecycle function is a recording fake.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ finalizeDueKarenz: vi.fn() }))
vi.mock('@gremion/tenant-store/lifecycle', async (orig) => ({
  ...(await orig<typeof import('@gremion/tenant-store/lifecycle')>()),
  finalizeDueKarenz: lifecycle.finalizeDueKarenz,
}))

import { EXPORT_KEEP_DAYS, exportHold, exportKeptUntil } from '../src/export-hold.ts'
import { pgModules } from '../src/index.ts'

const DAY = 24 * 3600 * 1000
const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const ctx = (finalAt: Date, over: Partial<Parameters<typeof exportHold>[2]> = {}) => ({ karenzState: 'finalizing' as const, databaseDropped: true, finalAt, ...over })

describe('exportKeptUntil and exportHold', () => {
  it('board has an entry and its date is final_at plus the days, to the millisecond', () => {
    expect(EXPORT_KEEP_DAYS.board).toBeGreaterThan(30)
    const finalAt = new Date('2026-12-01T10:00:00.123Z')
    expect(exportKeptUntil('board', finalAt)?.getTime()).toBe(finalAt.getTime() + EXPORT_KEEP_DAYS.board! * DAY)
    expect(exportHold(T, 'board', ctx(finalAt))?.getTime()).toBe(finalAt.getTime() + EXPORT_KEEP_DAYS.board! * DAY)
  })

  it('counts elapsed days across a leap day and a change of the clock: the same instant on every run and in every zone', () => {
    // The end instant is fixed and final_at is derived from it, so the cases do not depend on the length: when the
    // DPO changes EXPORT_KEEP_DAYS, only the constant and the catalogue change. The days are elapsed days
    // (n x 24 h), not calendar days: the span below holds 29 February 2028 when the length is more than ~9 months.
    const days = EXPORT_KEEP_DAYS.board!
    const startOf = (end: string) => new Date(new Date(end).getTime() - days * DAY)
    expect(exportKeptUntil('board', startOf('2028-11-30T10:00:00Z'))?.toISOString()).toBe('2028-11-30T10:00:00.000Z')
    expect(exportKeptUntil('board', startOf('2027-10-20T12:00:00Z'))?.toISOString()).toBe('2027-10-20T12:00:00.000Z')
    const finalAt = new Date('2026-12-01T10:00:00Z')
    expect(exportKeptUntil('board', finalAt)?.getTime()).toBe(exportKeptUntil('board', new Date(finalAt.getTime()))?.getTime())
  })

  it('a change of the clock inside the year moves nothing: elapsed days are counted on the instant, under a zone that has daylight saving', () => {
    // The span ends just after the spring change of 2028 (26 March, Europe/Berlin) and, for the length in force,
    // holds a leap day and a change of the clock. Days counted on the local date land one hour off the instant
    // that n x 24 h reach; only counting on the instant gives the same answer in every zone.
    const before = process.env.TZ
    process.env.TZ = 'Europe/Berlin'
    try {
      const probe = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTimezoneOffset()
      // the zone is really in effect: winter and summer differ, or this guard checks nothing
      expect([probe(2027, 0, 15), probe(2027, 6, 15)], 'process.env.TZ did not take effect').toEqual([-60, -120])
      const days = EXPORT_KEEP_DAYS.board!
      const end = new Date('2028-03-26T10:00:00Z')
      const finalAt = new Date(end.getTime() - days * DAY)
      expect(exportKeptUntil('board', finalAt)?.toISOString()).toBe(end.toISOString())
      // and the other direction: the span ends just after the autumn change
      const autumnEnd = new Date('2027-10-30T10:00:00Z')
      const autumn = new Date(autumnEnd.getTime() - days * DAY)
      expect(exportKeptUntil('board', autumn)?.getTime()).toBe(autumnEnd.getTime())
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  })

  it('a module with no entry has no hold, including names that exist on every object', () => {
    for (const key of ['calendar', 'finance', 'lcfix', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(exportKeptUntil(key, new Date('2026-12-01T10:00:00Z')), JSON.stringify(key)).toBeNull()
      expect(exportHold(T, key, ctx(new Date('2026-12-01T10:00:00Z'))), JSON.stringify(key)).toBeNull()
    }
  })

  it('fails closed on a final_at that is not a valid date: it throws, which keeps the export', () => {
    for (const bad of [new Date('nope'), undefined, null, '2026-12-01', 0]) {
      expect(() => exportKeptUntil('board', bad as unknown as Date), String(bad)).toThrow(/final_at/)
    }
    // a module without an entry never reads the date
    expect(exportKeptUntil('calendar', new Date('nope'))).toBeNull()
  })

  it('the table cannot be changed at run time', () => {
    expect(Object.isFrozen(EXPORT_KEEP_DAYS)).toBe(true)
    expect(() => {
      ;(EXPORT_KEEP_DAYS as Record<string, number>).calendar = 5
    }).toThrow(TypeError)
  })
})

describe('the retention catalogue and the table say the same number', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const text = readFileSync(join(root, 'docs/compliance/retention-catalogue.md'), 'utf8').replace(/\r\n/g, '\n')
  const row = (id: string) => {
    const line = text.split('\n').find((l) => l.startsWith(`| ${id} `))
    expect(line, `${id} row not found in the retention catalogue`).toBeTruthy()
    return line!
  }
  // the machine-read phrase of both rows: "board ... **N days after day 30**"
  const keptDays = (line: string) => [...line.matchAll(/board[^|]*?\*\*(\d+) days after day 30\*\*/g)].map((m) => Number(m[1]))

  it('RC-MOD-EXPORT and RC-BRD each state the board keep time of EXPORT_KEEP_DAYS', () => {
    expect(keptDays(row('RC-MOD-EXPORT'))).toEqual([EXPORT_KEEP_DAYS.board])
    expect(keptDays(row('RC-BRD'))).toEqual([EXPORT_KEEP_DAYS.board])
  })

  it('RC-BRD says the length is provisional and that erasure does not reach the kept export; RC-MOD-EXPORT names the DPO as the one who sets it', () => {
    const brd = row('RC-BRD')
    expect(brd).toMatch(/provisional/i)
    expect(brd).toMatch(/erasure/i)
    expect(brd).toMatch(/kept export/i)
    expect(row('RC-MOD-EXPORT')).toMatch(/DPO/)
  })
})

describe('the retention catalogue describes a board export that is taken', () => {
  // Board declares its own module database and an export, so a switch-off takes the export and the hold has one to
  // keep. The rows and the change note must say so plainly, with no condition that is no longer true, so a reader
  // never takes the keep time for a rule about a file that does not exist.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const text = readFileSync(join(root, 'docs/compliance/retention-catalogue.md'), 'utf8').replace(/\r\n/g, '\n')
  const lineOf = (start: string) => text.split('\n').find((l) => l.startsWith(start)) ?? ''
  const stale = /only once board has its own module database|today (it|board) has none|no board export is taken/i

  it('RC-BRD, RC-MOD-EXPORT and the change note carry no condition that board has no module database', () => {
    expect(lineOf('| RC-BRD '), 'RC-BRD').not.toMatch(stale)
    expect(lineOf('| RC-MOD-EXPORT '), 'RC-MOD-EXPORT').not.toMatch(stale)
    const start = text.indexOf('> **Change note 2026-11-17')
    expect(start, 'change note 2026-11-17').toBeGreaterThanOrEqual(0)
    const note = text.slice(start, text.indexOf('> **Change note 2026-10-27'))
    expect(note.replace(/\n> ?/g, ' ')).not.toMatch(stale)
  })

  it('RC-BRD and the change note say that a board still held in the kernel tables has nothing to export at switch-off', () => {
    // A customer whose board was switched on while board had no database of its own keeps the cards in the kernel
    // tables: its switch-off opens the 30-day clock but exports nothing, and the catalogue must not promise an export
    // for it.
    const start = text.indexOf('> **Change note 2026-11-17')
    const note = text.slice(start, text.indexOf('> **Change note 2026-10-27')).replace(/\n> ?/g, ' ')
    for (const [name, body] of [['RC-BRD', lineOf('| RC-BRD ')], ['the change note', note]] as const) {
      expect(body, name).toMatch(/kernel tables/i)
      expect(body, name).toMatch(/nothing to export/i)
    }
  })

  it('the change note says that a later change of the length does not re-date an export that is already kept', () => {
    const start = text.indexOf('> **Change note 2026-11-17')
    const note = text.slice(start, text.indexOf('> **Change note 2026-10-27')).replace(/\n> ?/g, ' ')
    expect(note).toMatch(/already kept/i)
    expect(note).toMatch(/does not re-date/i)
  })
})

describe('the modules port hands the export hold to the day-30 job', () => {
  beforeEach(() => lifecycle.finalizeDueKarenz.mockReset())

  const modules = () =>
    pgModules({
      platform: {} as never,
      catalogue: [],
      lifecycle: { server: () => ({}) as never, exportDir: '/exports', releaseRef: 'dist-v0.0.1' } as never,
    })

  it('finalizeDue passes an exportHold that keeps board for its days after final_at and no other module', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: true, errors: [], orphanedExports: [] })
    await modules().finalizeDue!({ finalDeletion: true, deadlineMs: 1000 })
    const passed = lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { exportHold?: typeof exportHold; finalDeletion: boolean }
    expect(passed.finalDeletion).toBe(true)
    expect(typeof passed.exportHold).toBe('function')
    const finalAt = new Date('2026-12-01T10:00:00Z')
    expect(passed.exportHold!(T, 'board', ctx(finalAt))?.getTime()).toBe(finalAt.getTime() + EXPORT_KEEP_DAYS.board! * DAY)
    expect(passed.exportHold!(T, 'calendar', ctx(finalAt))).toBeNull()
  })

  it('a dry run still passes the hold (the job itself never asks it in a dry run)', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: true, errors: [], orphanedExports: [] })
    await modules().finalizeDue!({ finalDeletion: false, deadlineMs: 1000 })
    expect(typeof (lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { exportHold?: unknown }).exportHold).toBe('function')
  })
})
