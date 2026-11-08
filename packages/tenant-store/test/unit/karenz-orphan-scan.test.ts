// The orphaned-export listing is informational (it is never acted on), so a failure while walking the
// export tree must not stop the day-30 pass: every due row is still processed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readdirSync: () => {
      throw Object.assign(new Error("EACCES: permission denied, scandir 'x'"), { code: 'EACCES' })
    },
  }
})

const { finalizeDueKarenz } = await import('../../src/lifecycle/karenz.js')

// a tagged-template stand-in for the platform connection: every statement answers with no rows
const emptyPlatform = (async () => []) as unknown as Sql

describe('finalizeDueKarenz: the orphaned-export scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karenz-orphan-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('an unreadable export tree is logged and leaves the list empty; the pass itself still runs', async () => {
    const lines: string[] = []
    const r = await finalizeDueKarenz({
      platform: emptyPlatform,
      server: () => {
        throw new Error('no server expected')
      },
      catalogue: [],
      exportDir: dir,
      finalDeletion: true,
      log: (l) => lines.push(l),
    })
    expect(r).toMatchObject({ due: 0, finalized: 0, errors: [], orphanedExports: [] })
    expect(lines.join('\n')).toMatch(/orphaned-export scan failed/)
    expect(lines.join('\n')).toMatch(/EACCES/)
  })
})
