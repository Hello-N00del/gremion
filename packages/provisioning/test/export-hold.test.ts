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
    }).toThrow()
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
    await modules().finalizeDue({ finalDeletion: true, deadlineMs: 1000 })
    const passed = lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { exportHold?: typeof exportHold; finalDeletion: boolean }
    expect(passed.finalDeletion).toBe(true)
    expect(typeof passed.exportHold).toBe('function')
    const finalAt = new Date('2026-12-01T10:00:00Z')
    expect((await passed.exportHold!(T, 'board', ctx(finalAt)))?.getTime()).toBe(finalAt.getTime() + EXPORT_KEEP_DAYS.board! * DAY)
    expect(await passed.exportHold!(T, 'calendar', ctx(finalAt))).toBeNull()
  })

  it('a dry run still passes the hold (the job itself never asks it in a dry run)', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: true, errors: [], orphanedExports: [] })
    await modules().finalizeDue({ finalDeletion: false, deadlineMs: 1000 })
    expect(typeof (lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { exportHold?: unknown }).exportHold).toBe('function')
  })
})
