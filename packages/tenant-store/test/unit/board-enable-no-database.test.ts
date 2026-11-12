// Board wave 2026-11-11 (B1): board is served in-process from the kernel tenant database (migration
// 0034), so enabling it must never open a module database. Before the wave modules/board/module.json
// declared runtime.database on board-postgres; lifting the deny alone would then have made enableModule
// open that server (a pilot host does not run it) and park disable, export and Karenz on an empty leaf
// database. This guard runs the REAL enableModule against the REAL modules/board/module.json with a
// platform connection that answers only what a database-less enable asks, and a server factory that
// fails the test when it is called for any service.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { enableModule } from '../../src/lifecycle/enable.js'
import type { LifecycleDeps, LifecycleModule } from '../../src/lifecycle/types.js'

const TENANT = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const MODULE_ROW = '0192f0c1-2b3c-7d4e-8f00-aaaaaaaaaaaa'
const VERSION_ROW = '0192f0c1-2b3c-7d4e-8f00-bbbbbbbbbbbb'
const ISOLATION_ROW = '0192f0c1-2b3c-7d4e-8f00-cccccccccccc'
const DPIA_ROW = '0192f0c1-2b3c-7d4e-8f00-dddddddddddd'

const BOARD_DIR = fileURLToPath(new URL('../../../../modules/board', import.meta.url))

function boardModule(): LifecycleModule {
  const moduleJson = JSON.parse(readFileSync(`${BOARD_DIR}/module.json`, 'utf8')) as LifecycleModule['moduleJson']
  return { id: 'board', dir: BOARD_DIR, moduleJson }
}

/** A platform connection that answers the database-less enable's queries and records every statement. */
function fakePlatform(statements: string[]): LifecycleDeps['platform'] {
  const answer = (text: string): unknown[] => {
    if (/current_database\(\)/.test(text)) return [{ db: 'gremion_platform' }]
    if (/FROM plt\.module m JOIN plt\.module_version v/.test(text)) return [{ module_id: MODULE_ROW, module_version_id: VERSION_ROW }]
    return []
  }
  const run = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    statements.push(text)
    return Promise.resolve(answer(text))
  }
  const sql = Object.assign((strings: TemplateStringsArray) => run(strings), {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn((strings: TemplateStringsArray) => run(strings)),
  })
  return sql as unknown as LifecycleDeps['platform']
}

describe('enableModule for board (in-process, kernel tenant database)', () => {
  it('opens no module database: deps.server is never called, no plt.module_database row is written, the result names no database', async () => {
    const statements: string[] = []
    const asked: string[] = []
    const deps = {
      platform: fakePlatform(statements),
      enableGate: async () => ({ isolationTestResultId: ISOLATION_ROW, dpiaDecisionId: DPIA_ROW }),
      server: (service: string) => {
        asked.push(service)
        throw new Error(`deps.server(${JSON.stringify(service)}) must not be called when enabling board`)
      },
    } as unknown as LifecycleDeps

    const r = await enableModule(TENANT, boardModule(), { kind: 'operator', id: '0192f0c1-2b3c-7d4e-8f00-eeeeeeeeeeee' } as never, deps)

    expect(asked).toEqual([])
    expect(r).toMatchObject({ tenantId: TENANT, moduleId: 'board', database: null, created: false, applied: [], noop: false })
    expect(statements.some((s) => /plt\.module_database/.test(s))).toBe(false)
    expect(statements.some((s) => /INSERT INTO plt\.module_enablement/.test(s))).toBe(true)
  })

  it('the shipped module.json declares no database and no export (as votes and files do)', () => {
    const runtime = boardModule().moduleJson.runtime
    expect(runtime.database).toBeNull()
    expect(runtime.export).toBeNull()
  })
})
