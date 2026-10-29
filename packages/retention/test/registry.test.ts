// Registry guards (TASK-033-a). RED recipes are named per test: edit the figure
// named in the comment and the test fails; restore it and it passes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogueDrift, parseCacheTtlHours, parseLogRows } from '../src/catalogue.ts'
import {
  CEILING_DAYS, dbWindowDays, enforcedDays, formatDuration, LOG_CLASSES, logClass, lokiClasses, lokiWorstCaseMinutes, maxLokiWindowDays,
} from '../src/registry.ts'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const CATALOGUE = readFileSync(resolve(ROOT, 'docs/compliance/retention-catalogue.md'), 'utf8').replace(/\r\n/g, '\n')

describe('registry figures', () => {
  it('enforced windows are 14/27/27/27/28 for the Loki classes and 7 for the trace store', () => {
    expect(Object.fromEntries(LOG_CLASSES.map((c) => [c.id, enforcedDays(c)]))).toEqual({
      access: 14, security: 27, finance: 27, audit: 27, application: 28, trace: 7,
    })
  })

  it('application is regular 30 but enforced 28, so the Loki worst case stays under the 30-day ceiling', () => {
    const app = logClass('application')
    expect(app.regularDays).toBe(30)
    expect(enforcedDays(app)).toBe(28)
    expect(maxLokiWindowDays(30)).toBe(28)
  })

  it('every Loki class worst case is at most the ceiling; a 30-day application window is over it (RED recipe)', () => {
    for (const c of lokiClasses()) expect(lokiWorstCaseMinutes(enforcedDays(c))).toBeLessThanOrEqual(CEILING_DAYS * 1440)
    expect(lokiWorstCaseMinutes(30)).toBeGreaterThan(CEILING_DAYS * 1440)
    expect(formatDuration(lokiWorstCaseMinutes(28))).toBe('29 d 2 h 10 min')
  })

  it('a database table purges at min(regular, cap - 1 tick), without Loki overhead: application (job_run) is 29, not 28 (RED recipe: route dbWindowDays through enforcedDays)', () => {
    expect(dbWindowDays(logClass('application'))).toBe(29)
    expect(dbWindowDays(logClass('security'))).toBe(27)
    for (const c of LOG_CLASSES) expect(dbWindowDays(c) + 1).toBeLessThanOrEqual(CEILING_DAYS)
  })

  it('audit is never shorter than security (TRD-191)', () => {
    expect(enforcedDays(logClass('audit'))).toBeGreaterThanOrEqual(enforcedDays(logClass('security')))
  })
})

describe('catalogue drift (RED recipe: edit a window in registry.ts or in the catalogue)', () => {
  it('the registry equals docs/compliance/retention-catalogue.md rows RC-LOG-* and RC-K1-CACHE', () => {
    expect(catalogueDrift(CATALOGUE)).toEqual([])
    expect(parseLogRows(CATALOGUE)).toHaveLength(6)
    expect(parseCacheTtlHours(CATALOGUE)).toBe(1)
  })

  it('goes RED when a catalogue window changes', () => {
    const edited = CATALOGUE.replace('**27 d / 30 d** | [D R29-I6] Pseudonymised logs included', '**28 d / 30 d** | [D R29-I6] Pseudonymised logs included')
    expect(edited).not.toBe(CATALOGUE)
    expect(catalogueDrift(edited).join('\n')).toMatch(/RC-LOG-SEC: regular 27 d in the registry, 28 d in the catalogue/)
  })

  it('goes RED when a log row disappears or the cache TTL changes', () => {
    expect(catalogueDrift(CATALOGUE.replace('| RC-LOG-TRC |', '| RC-LOG-XXX |')).join('\n')).toMatch(/RC-LOG-TRC: not in the catalogue/)
    expect(catalogueDrift(CATALOGUE.replace('TTL at most 1 hour', 'TTL at most 2 hours')).join('\n')).toMatch(/RC-K1-CACHE: TTL 1 h/)
  })
})
