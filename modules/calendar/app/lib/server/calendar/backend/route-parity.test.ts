// gremion-ui/src/lib/server/calendar/backend/route-parity.test.ts
// Task 6 — guard: no calendar route handler imports calendar-db directly.
//
// Every +server.ts / +page.server.ts under routes/api/calendar and
// routes/calendar must go through the CalendarBackendPort seam (via
// getCalendarBackend() / resolveCalendarBackendOr503() /
// resolveCalendarBackendForPage()), never `$lib/server/calendar/calendar-db`
// directly. Mirrors the content module's route-parity guard.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..') // …/gremion-ui

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function collectRouteFiles(): string[] {
  const files: string[] = []
  for (const top of ['src/routes/api/calendar', 'src/routes/calendar']) {
    const dir = join(gremionUiRoot, top)
    if (!existsSync(dir)) continue
    for (const abs of walk(dir)) {
      const rel = relative(gremionUiRoot, abs).split('\\').join('/')
      if (rel.endsWith('+server.ts') || rel.endsWith('+page.server.ts')) {
        files.push(rel)
      }
    }
  }
  return files
}

const DIRECT_IMPORT_RE = /from\s+['"][^'"]*\/calendar-db['"]/

describe('calendar route-parity — no route imports calendar-db directly', () => {
  it('collects a non-trivial set of route files (path regression guard)', () => {
    expect(collectRouteFiles().length).toBeGreaterThanOrEqual(10)
  })

  it('finds zero route files importing calendar-db directly', () => {
    const offenders: string[] = []
    for (const rel of collectRouteFiles()) {
      const content = readFileSync(join(gremionUiRoot, rel), 'utf8')
      if (DIRECT_IMPORT_RE.test(content)) offenders.push(rel)
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([])
  })
})
