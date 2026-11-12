// Board wave (integration): the destructive half of board-enable-no-database.test.ts. Board is served
// in-process from the kernel tenant database (migration 0034) and modules/board/module.json declares no
// runtime.database and no runtime.export. So a switch-off and the day-30 Karenz job must not reach for a
// module server at all: there is no (tenant, board) database, and an export, a block or a DROP against one
// would act on a database that does not hold the board's rows. These guards run the REAL disableModule and
// the REAL finalizeDueKarenz against the REAL modules/board/module.json, with a server factory and an
// exporter that fail the test when they are called.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { disableModule } from '../../src/lifecycle/disable.js'
import { finalizeDueKarenz, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { LifecycleDeps, LifecycleModule } from '../../src/lifecycle/types.js'

const TENANT = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const MODULE_ROW = '0192f0c1-2b3c-7d4e-8f00-aaaaaaaaaaaa'
const KARENZ_ROW = '0192f0c1-2b3c-7d4e-8f00-ffffffffffff'
const ACTOR = { kind: 'operator', id: '0192f0c1-2b3c-7d4e-8f00-eeeeeeeeeeee' } as never

const BOARD_DIR = fileURLToPath(new URL('../../../../modules/board', import.meta.url))

function boardModule(): LifecycleModule {
  const moduleJson = JSON.parse(readFileSync(`${BOARD_DIR}/module.json`, 'utf8')) as LifecycleModule['moduleJson']
  return { id: 'board', dir: BOARD_DIR, moduleJson }
}

interface Statement {
  text: string
  values: unknown[]
}

/** A platform connection that records every statement and answers through `answer`. */
function fakePlatform(statements: Statement[], answer: (s: Statement) => unknown[]): LifecycleDeps['platform'] {
  const run = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const s = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values }
    statements.push(s)
    return Promise.resolve(answer(s))
  }
  const sql = Object.assign(run, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(run) })
  return sql as unknown as LifecycleDeps['platform']
}

/** Module-server and exporter doubles: any use is recorded and fails the caller. */
function forbidden(asked: string[]) {
  return {
    server: (service: string) => {
      asked.push(`server:${service}`)
      throw new Error(`deps.server(${JSON.stringify(service)}) must not be called for board`)
    },
    exporter: new Proxy(
      {},
      {
        get: (_t, prop) => {
          asked.push(`exporter.${String(prop)}`)
          throw new Error(`the exporter (${String(prop)}) must not be used for board`)
        },
      },
    ),
  }
}

const touchesModuleDatabase = (statements: Statement[]) =>
  statements.filter((s) => /plt\.module_database/.test(s.text) && !/^SELECT export_path AS p FROM plt\.module_database/.test(s.text))
const destructive = (statements: Statement[]) => statements.filter((s) => /\b(DROP|REVOKE|pg_terminate_backend)\b/i.test(s.text))

describe('disableModule for board (in-process, kernel tenant database)', () => {
  it('turns the enablement off and opens a Karenz without an export: no module server, no export, no module_database row', async () => {
    const statements: Statement[] = []
    const asked: string[] = []
    let karenzOpen = false
    const platform = fakePlatform(statements, (s) => {
      if (/current_database\(\)/.test(s.text)) return [{ db: 'gremion_platform' }]
      if (/SELECT module_id::text FROM plt\.module WHERE module_key/.test(s.text)) return [{ module_id: MODULE_ROW }]
      if (/UPDATE plt\.module_enablement/.test(s.text)) return [{ '?column?': 1 }]
      if (/INSERT INTO plt\.module_karenz/.test(s.text)) {
        karenzOpen = true
        return []
      }
      if (/FROM plt\.module_karenz/.test(s.text)) {
        return karenzOpen ? [{ karenz_id: KARENZ_ROW, state: 'open', final_at: new Date('2026-12-11T00:00:00Z'), tenant_done_at: null }] : []
      }
      return []
    })
    const deps = { platform, exportDir: join(tmpdir(), 'board-disable-never-written'), ...forbidden(asked) } as unknown as LifecycleDeps

    const r = await disableModule(TENANT, boardModule(), ACTOR, deps)

    expect(asked).toEqual([])
    expect(r).toMatchObject({ tenantId: TENANT, moduleId: 'board', database: null, dropped: false, blocked: false, export: null, noop: false })
    expect(r.karenz?.karenzId).toBe(KARENZ_ROW)
    expect(touchesModuleDatabase(statements)).toEqual([])
    expect(destructive(statements)).toEqual([])
    // the switch itself did happen, and the Karenz row it opened records no export of a module database
    expect(statements.some((s) => /UPDATE plt\.module_enablement SET state = 'disabled'/.test(s.text))).toBe(true)
    const karenz = statements.find((s) => /INSERT INTO plt\.module_karenz/.test(s.text))
    expect(karenz).toBeDefined()
    expect(karenz?.values.slice(-2)).toEqual([null, null])
  })
})

describe('finalizeDueKarenz for board (day 30 of a board switch-off)', () => {
  it('completes the platform side without a module server: nothing is dropped, no export is looked for', async () => {
    const statements: Statement[] = []
    const asked: string[] = []
    const steps: string[] = []
    const platform = fakePlatform(statements, (s) => {
      if (/^SELECT k\.karenz_id::text/.test(s.text)) {
        return [
          {
            karenz_id: KARENZ_ROW,
            customer_id: TENANT,
            module_id: MODULE_ROW,
            module_key: 'board',
            state: 'open',
            export_path: null,
            export_sha256: null,
            export_deleted_at: null,
            platform_done_at: null,
            tenant_done_at: null,
            retained_ok_at: null,
          },
        ]
      }
      if (/SELECT state FROM plt\.module_karenz WHERE karenz_id/.test(s.text)) return [{ state: 'open' }]
      return []
    })
    const deps = {
      platform,
      catalogue: [boardModule()],
      exportDir: join(tmpdir(), 'board-karenz-never-written'),
      finalDeletion: true,
      hooks: { afterStep: (step: string) => void steps.push(step) },
      ...forbidden(asked),
    } as unknown as FinalizeDeps

    const r = await finalizeDueKarenz(deps)

    expect(r.errors).toEqual([])
    expect(r).toMatchObject({ due: 1, finalized: 1, kept: 0, dryRun: false })
    expect(asked).toEqual([])
    expect(steps).toEqual(['cas-finalizing', 'platform-done'])
    expect(touchesModuleDatabase(statements)).toEqual([])
    expect(destructive(statements)).toEqual([])
  })
})
