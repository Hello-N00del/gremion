// TDD 1 + Amendment R27 test 1: the one module.json validator refuses every
// under- or mis-declaration, one committed fixture per rule. Each refusal is a
// named problem string (asserted by content), never an exit code.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readCompose } from '../src/compose.ts'
import { validateModuleJson } from '../src/validate.ts'

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url))
const compose = readCompose(join(FIX, 'compose/base.yml'))
const ALPHA = join(FIX, 'roots/three/alpha') // carries migrations/manifest.json
const GAMMA = join(FIX, 'roots/three/gamma') // carries no migrations

const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, 'refusals', `${name}.json`), 'utf8'))
const good = (id: 'alpha' | 'beta' | 'gamma'): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, 'roots/three', id, 'module.json'), 'utf8'))

describe('validateModuleJson — the good fixtures pass', () => {
  it('alpha (database + export + migrations on disk) has no problems', () => {
    expect(validateModuleJson(good('alpha'), { id: 'alpha', dir: ALPHA, compose })).toEqual([])
  })

  it('gamma (platform server only, no migrations) has no problems', () => {
    expect(validateModuleJson(good('gamma'), { id: 'gamma', dir: GAMMA, compose })).toEqual([])
  })
})

// [fixture, ctx id, ctx dir, expected problem]
const REFUSALS: [string, string, string, RegExp][] = [
  ['missing-runtime', 'alpha', ALPHA, /alpha: module\.json has no runtime block/],
  ['migrations-null-database', 'alpha', ALPHA, /alpha: migrations\/manifest\.json is on disk but runtime\.database is null/],
  ['database-without-export', 'alpha', ALPHA, /alpha: runtime\.database is declared but runtime\.export is null/],
  ['bare-number-retention', 'alpha', ALPHA, /alpha: runtime\.export\.retentionProfile 30 must match \^rp-/],
  ['job-without-colour', 'alpha', ALPHA, /alpha: runtime\.timedJobs\[0\]\.activeColourOnly must be true or false/],
  ['id-names-regex', 'al__pha', GAMMA, /"al__pha" must match .*names\.ts MODULE_ID/],
  ['id-schema-regex', 'alpha2', GAMMA, /"alpha2" must match .*module_module_key_check/],
  ['id-too-long', 'abcdefghijklmnopqrstuvwxyzab', GAMMA, /is 28 bytes; at most 27/],
  ['id-injection', 'x"; DROP DATABASE control; --', GAMMA, /"x\\"; DROP DATABASE control; --" must match/],
  ['extraction-source-disagrees', 'gamma', GAMMA, /extractionSource 1{40} disagrees with the frozen source/],
  ['contracts-unknown-api', 'gamma', GAMMA, /contracts: requires api "ghost-api": unknown/],
  ['platform-empty-databases', 'gamma', GAMMA, /runtime\.platformServer\.databases must be a non-empty list/],
  ['platform-t-prefix', 'gamma', GAMMA, /runtime\.platformServer\.databases\[0\] "t_x" begins with t_/],
  ['platform-postgres', 'gamma', GAMMA, /runtime\.platformServer\.databases\[0\] "postgres" is a server built-in/],
  ['platform-server-default-db', 'gamma', GAMMA, /runtime\.platformServer\.databases\[0\] "gamma" is gamma-postgres's POSTGRES_USER default database/],
  ['platform-differs', 'alpha', ALPHA, /runtime\.database\.postgresService alpha-postgres and runtime\.platformServer\.postgresService gamma-postgres differ/],
  ['ghost-postgres', 'alpha', ALPHA, /runtime\.database\.postgresService ghost-postgres is not a compose service labelled org\.gremion\.postgres=module:\*/],
]

describe('validateModuleJson — one refusal per rule (fixtures/refusals/*.json)', () => {
  it.each(REFUSALS)('%s is refused', (name, id, dir, expected) => {
    const problems = validateModuleJson(load(name), { id, dir, compose })
    expect(problems.some((p) => expected.test(p)), problems.join('\n')).toBe(true)
  })

  it('the injection id is refused by the validator alone: it takes no database, so no SQL can run', () => {
    // validateModuleJson has no connection parameter at all; the id never
    // reaches a statement. The refusal names every id rule it breaks.
    const problems = validateModuleJson(load('id-injection'), { id: 'x"; DROP DATABASE control; --', dir: GAMMA, compose })
    expect(problems.filter((p) => /must match/.test(p)).length).toBeGreaterThanOrEqual(2)
    expect(validateModuleJson.length).toBe(2)
  })

  it('a directory name that differs from the declared id is refused', () => {
    expect(validateModuleJson(good('alpha'), { id: 'beta', dir: ALPHA, compose }).join('\n')).toMatch(/beta: module\.json id "alpha" differs from its directory name beta/)
  })

  it('a database on a service that is not labelled module:* (the kernel server, a web service) is refused', () => {
    for (const svc of ['postgres', 'web']) {
      const m = good('alpha') as { runtime: { database: { postgresService: string } } }
      m.runtime.database.postgresService = svc
      expect(validateModuleJson(m, { id: 'alpha', dir: ALPHA, compose }).join('\n')).toMatch(
        new RegExp(`runtime\\.database\\.postgresService ${svc} is not a compose service labelled org\\.gremion\\.postgres=module:\\*`),
      )
    }
  })

  it('a declared database whose migrations directory carries no manifest is refused (over-declaration)', () => {
    const m = good('alpha')
    expect(validateModuleJson(m, { id: 'alpha', dir: GAMMA, compose }).join('\n')).toMatch(/alpha: runtime\.database\.migrations names migrations\/manifest\.json, which is not on disk/)
  })

  it('an export without a database is refused', () => {
    const m = good('gamma') as { runtime: Record<string, unknown> }
    m.runtime.export = { kind: 'pg_dump', retentionProfile: 'rp-gam-module-data' }
    expect(validateModuleJson(m, { id: 'gamma', dir: GAMMA, compose }).join('\n')).toMatch(/gamma: runtime\.export is declared but runtime\.database is null/)
  })

  it('MED-3: runtime.export.withhold takes schema.table or schema.table.column entries, nothing else', () => {
    const m = good('alpha') as { runtime: { export: Record<string, unknown> } }
    m.runtime.export.withhold = ['public.send_tokens', 'finance.fints_config.password_encrypted']
    expect(validateModuleJson(m, { id: 'alpha', dir: ALPHA, compose }).join('\n')).not.toMatch(/withhold/)
    for (const bad of [['token'], ['a.b.c.d'], ['Public.x'], ['public.x', 'public.x'], 'public.x', [1]]) {
      m.runtime.export.withhold = bad
      expect(validateModuleJson(m, { id: 'alpha', dir: ALPHA, compose }).join('\n'), JSON.stringify(bad)).toMatch(/alpha: runtime\.export\.withhold/)
    }
    m.runtime.export.withold = []
    delete m.runtime.export.withhold
    expect(validateModuleJson(m, { id: 'alpha', dir: ALPHA, compose }).join('\n')).toMatch(/runtime\.export\.withold is not an export field/)
  })

  it('MED-3: the real modules withhold their secrets from the open-format export', () => {
    const root = fileURLToPath(new URL('../../../modules/', import.meta.url))
    const withhold = (id: string) => (JSON.parse(readFileSync(join(root, id, 'module.json'), 'utf8')) as { runtime: { export: { withhold?: string[] } } }).runtime.export.withhold ?? []
    expect(withhold('publishing')).toEqual(expect.arrayContaining(['public.unsubscribes.token', 'public.send_tokens.token']))
    expect(withhold('content')).toEqual(expect.arrayContaining(['content.send_tokens.token']))
    expect(withhold('vault')).toEqual(expect.arrayContaining(['public.vault_item.secret_ciphertext']))
    expect(withhold('finance')).toEqual(expect.arrayContaining(['finance.fints_config.password_encrypted']))
  })

  it('a runtime key left out is refused, never defaulted (each of the five)', () => {
    for (const key of ['version', 'database', 'export', 'timedJobs', 'platformServer']) {
      const m = good('gamma') as { runtime: Record<string, unknown> }
      delete m.runtime[key]
      expect(validateModuleJson(m, { id: 'gamma', dir: GAMMA, compose }).join('\n'), key).toMatch(new RegExp(`runtime\\.${key} is missing`))
    }
  })

  it('an unknown runtime key is refused (a typo must not read as an absent field)', () => {
    const m = good('gamma') as { runtime: Record<string, unknown> }
    m.runtime.databse = null
    expect(validateModuleJson(m, { id: 'gamma', dir: GAMMA, compose }).join('\n')).toMatch(/runtime\.databse is not a runtime field/)
  })

  it('a non-semver version and a wrong schemaVersion are refused', () => {
    const m = good('gamma') as { schemaVersion: number; runtime: Record<string, unknown> }
    m.runtime.version = '1.0'
    m.schemaVersion = 2
    const text = validateModuleJson(m, { id: 'gamma', dir: GAMMA, compose }).join('\n')
    expect(text).toMatch(/runtime\.version "1\.0" is not a semver/)
    expect(text).toMatch(/schemaVersion must be 1/)
  })

  it('a duplicate timed-job id is refused', () => {
    const m = good('alpha') as { runtime: { timedJobs: unknown[] } }
    m.runtime.timedJobs = [{ id: 'x-sync', activeColourOnly: true }, { id: 'x-sync', activeColourOnly: false }]
    expect(validateModuleJson(m, { id: 'alpha', dir: ALPHA, compose }).join('\n')).toMatch(/timedJobs\[1\]\.id "x-sync" is declared twice/)
  })

  it('not an object at all is refused, not thrown', () => {
    for (const v of [null, [], 'x', 3]) {
      expect(validateModuleJson(v, { id: 'alpha', dir: ALPHA, compose }).join('\n')).toMatch(/alpha: module\.json is not a JSON object/)
    }
  })
})
