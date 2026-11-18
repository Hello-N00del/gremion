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
    // 365 days are 365 x 24 h: a year that holds 29 February ends one calendar day earlier
    expect(exportKeptUntil('board', new Date('2027-12-01T10:00:00Z'))?.toISOString()).toBe('2028-11-30T10:00:00.000Z')
    expect(exportKeptUntil('board', new Date('2026-10-20T12:00:00Z'))?.toISOString()).toBe('2027-10-20T12:00:00.000Z')
    const finalAt = new Date('2026-12-01T10:00:00Z')
    expect(exportKeptUntil('board', finalAt)?.getTime()).toBe(exportKeptUntil('board', new Date(finalAt.getTime()))?.getTime())
  })

  it('a change of the clock inside the year moves nothing: elapsed days are counted on the instant, under a zone that has daylight saving', () => {
    // 2027-03-27 to 2028-03-27 holds a leap day AND the spring change of 2028 (26 March, Europe/Berlin). 365 calendar
    // days counted on the local date land one hour off the instant that 365 x 24 h reach; only counting on the
    // instant gives the same answer in every zone.
    const before = process.env.TZ
    process.env.TZ = 'Europe/Berlin'
    try {
      const probe = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTimezoneOffset()
      // the zone is really in effect: winter and summer differ, or this guard checks nothing
      expect([probe(2027, 0, 15), probe(2027, 6, 15)], 'process.env.TZ did not take effect').toEqual([-60, -120])
      const finalAt = new Date('2027-03-27T10:00:00Z')
      expect(exportKeptUntil('board', finalAt)?.toISOString()).toBe('2028-03-26T10:00:00.000Z')
      expect(exportKeptUntil('board', finalAt)?.getTime()).toBe(finalAt.getTime() + 365 * DAY)
      // and the other direction: autumn change
      const autumn = new Date('2027-10-30T10:00:00Z')
      expect(exportKeptUntil('board', autumn)?.getTime()).toBe(autumn.getTime() + 365 * DAY)
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

describe('the retention catalogue does not describe a board export that is not taken', () => {
  // The hold is wired for board, but board declares no module database in this tree, so no board export is taken
  // at switch-off and the hold has nothing to keep. The rows must say when the keep time starts to apply, so a
  // reader never takes them as a statement about a file that exists today.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const text = readFileSync(join(root, 'docs/compliance/retention-catalogue.md'), 'utf8').replace(/\r\n/g, '\n')
  const lineOf = (start: string) => text.split('\n').find((l) => l.startsWith(start)) ?? ''
  const conditional = /only once board has its own module database/i

  it('RC-BRD, RC-MOD-EXPORT and the change note say the keep time applies only once board has its own module database', () => {
    expect(lineOf('| RC-BRD '), 'RC-BRD').toMatch(conditional)
    expect(lineOf('| RC-MOD-EXPORT '), 'RC-MOD-EXPORT').toMatch(conditional)
    const start = text.indexOf('> **Change note 2026-11-17')
    expect(start, 'change note 2026-11-17').toBeGreaterThanOrEqual(0)
    const note = text.slice(start, text.indexOf('> **Change note 2026-10-27'))
    expect(note.replace(/\n> ?/g, ' ')).toMatch(conditional)
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
