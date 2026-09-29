// TDD 2 (compose cross-check), 3 (vacuity) and 4 (derivations), plus the
// Amendment R27 additions for runtime.platformServer. Post-conditions on the
// derived values, never on an exit code.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCatalogue, loadCatalogue } from '../src/catalogue.ts'
import { COMPOSE_POSTGRES_LABEL, readCompose } from '../src/compose.ts'
import {
  deriveBackupServices,
  deriveColourGatedJobs,
  KERNEL_PLATFORM_DATABASES,
  platformDatabases,
  POSTGRES_LABEL,
  type CatalogueEntry,
  type ModuleJson,
} from '../src/runtime.ts'
import { checkClaims } from '../src/validate.ts'

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url))
const THREE = join(FIX, 'roots/three')
const compose = readCompose(join(FIX, 'compose/base.yml'))
// Scratch copies live under the package (gitignored .tmp/), never the OS temp
// dir; one subdirectory per file and process, so parallel spec files never
// remove each other's scratch.
const TMP = join(fileURLToPath(new URL('./.tmp/', import.meta.url)), `catalogue-${process.pid}`)
let n = 0
const scratchCopy = (): string => {
  const dir = join(TMP, `root-${process.pid}-${n++}`)
  mkdirSync(TMP, { recursive: true })
  cpSync(THREE, dir, { recursive: true })
  return dir
}
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const entry = (id: string, runtime: Partial<ModuleJson['runtime']>): CatalogueEntry => ({
  id,
  dir: join(THREE, id),
  moduleJson: {
    schemaVersion: 1,
    id,
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: { version: '1.0.0', database: null, export: null, timedJobs: [], platformServer: null, ...runtime },
  },
})
const db = (svc: string) => ({ postgresService: svc, migrations: 'migrations' })

describe('loadCatalogue + checkCatalogue on the three-module fixture root', () => {
  it('loads alpha, beta, gamma in directory order and finds no problem', () => {
    const cat = loadCatalogue(THREE)
    expect(cat.problems).toEqual([])
    expect(cat.modules.map((m) => m.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(checkCatalogue(THREE, { compose }).problems).toEqual([])
  })
})

describe('TDD 2 — compose cross-check (claims)', () => {
  const alpha = entry('alpha', { database: db('alpha-postgres') })
  const beta = entry('beta', { database: db('beta-postgres') })
  const gamma = entry('gamma', { platformServer: { postgresService: 'gamma-postgres', databases: ['synapse'] } })

  it('every module:* service claimed exactly once is clean', () => {
    expect(checkClaims([alpha, beta, gamma], compose)).toEqual([])
  })

  it('an unclaimed module:* service is refused', () => {
    expect(checkClaims([alpha, gamma], compose)).toEqual([
      'beta-postgres is labelled org.gremion.postgres=module:beta but no module.json claims it (runtime.database or runtime.platformServer)',
    ])
  })

  it('a service claimed by two modules is refused', () => {
    const alpha2 = entry('delta', { database: db('alpha-postgres') })
    expect(checkClaims([alpha, alpha2, beta, gamma], compose)).toEqual(['alpha-postgres is claimed by two or more modules: alpha, delta'])
  })

  it('Amendment test 2: messaging-postgres unclaimed is refused, claimed through platformServer is clean, named by a platformServer and another module\'s database is refused', () => {
    const withMsg = readCompose(join(FIX, 'compose/with-messaging.yml'))
    expect(checkClaims([alpha, beta, gamma], withMsg)).toEqual([
      'messaging-postgres is labelled org.gremion.postgres=module:messaging but no module.json claims it (runtime.database or runtime.platformServer)',
    ])
    const messaging = entry('messaging', { platformServer: { postgresService: 'messaging-postgres', databases: ['synapse'] } })
    expect(checkClaims([alpha, beta, gamma, messaging], withMsg)).toEqual([])
    const thief = entry('votes', { database: db('messaging-postgres') })
    expect(checkClaims([alpha, beta, gamma, messaging, thief], withMsg)).toEqual(['messaging-postgres is claimed by two or more modules: messaging, votes'])
  })

  it('a module whose database and platformServer name the same service claims it once', () => {
    const both = entry('gamma', { database: db('gamma-postgres'), platformServer: { postgresService: 'gamma-postgres', databases: ['synapse'] } })
    expect(checkClaims([alpha, beta, both], compose)).toEqual([])
  })
})

describe('TDD 3 — vacuity', () => {
  it('an empty root is refused', () => {
    const dir = join(TMP, `empty-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    expect(checkCatalogue(dir, { compose }).problems).toEqual([`no module directory under ${dir} — the check would pass vacuously`])
  })

  it('a root of non-module directories is refused per directory', () => {
    const dir = join(TMP, `nonmod-${process.pid}`)
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'not a module\n')
    const r = checkCatalogue(dir, { compose })
    expect(r.problems).toEqual(['docs/: no module.json — every directory under the modules root is a module and must declare one'])
    expect(r.modules).toEqual([])
  })

  it('a root that does not exist is refused, not read as empty', () => {
    expect(checkCatalogue(join(TMP, 'no-such-root'), { compose }).problems[0]).toMatch(/is not a directory/)
  })

  it('malformed JSON is named, not thrown', () => {
    const dir = scratchCopy()
    writeFileSync(join(dir, 'beta', 'module.json'), '{ not json')
    expect(checkCatalogue(dir, { compose }).problems.join('\n')).toMatch(/beta\/module\.json: not parseable JSON/)
  })
})

describe('TDD 4 — the backup list is derived from the catalogue', () => {
  it('a 3-module root yields postgres first, then each declared service, then each platform server, in catalogue order', () => {
    expect(deriveBackupServices(loadCatalogue(THREE).modules)).toEqual(['postgres', 'alpha-postgres', 'beta-postgres', 'gamma-postgres'])
  })

  it('deleting a module directory drops its service (database module)', () => {
    const dir = scratchCopy()
    expect(deriveBackupServices(loadCatalogue(dir).modules)).toContain('beta-postgres')
    rmSync(join(dir, 'beta'), { recursive: true })
    expect(deriveBackupServices(loadCatalogue(dir).modules)).toEqual(['postgres', 'alpha-postgres', 'gamma-postgres'])
  })

  it('Amendment test 4: deleting the platform-server module drops its server', () => {
    const dir = scratchCopy()
    expect(deriveBackupServices(loadCatalogue(dir).modules)).toContain('gamma-postgres')
    rmSync(join(dir, 'gamma'), { recursive: true })
    expect(deriveBackupServices(loadCatalogue(dir).modules)).toEqual(['postgres', 'alpha-postgres', 'beta-postgres'])
  })

  it('a service named by both fields of one module is listed once', () => {
    const both = entry('gamma', { database: db('gamma-postgres'), platformServer: { postgresService: 'gamma-postgres', databases: ['synapse'] } })
    expect(deriveBackupServices([both])).toEqual(['postgres', 'gamma-postgres'])
  })

  it('an empty catalogue still backs up the kernel server', () => {
    expect(deriveBackupServices([])).toEqual(['postgres'])
  })
})

describe('colour-gated jobs are derived too', () => {
  it('only activeColourOnly jobs, in catalogue order, and a removed module drops out', () => {
    expect(deriveColourGatedJobs(loadCatalogue(THREE).modules)).toEqual(['alpha-sync', 'gamma-tick'])
    const dir = scratchCopy()
    rmSync(join(dir, 'alpha'), { recursive: true })
    expect(deriveColourGatedJobs(loadCatalogue(dir).modules)).toEqual(['gamma-tick'])
  })
})

describe('platformDatabases(service) — a closed list', () => {
  const cat = loadCatalogue(THREE).modules

  it('the kernel server: the Q6 list plus its POSTGRES_DB', () => {
    expect(platformDatabases('postgres', { compose, catalogue: cat })).toEqual([...KERNEL_PLATFORM_DATABASES].sort())
  })

  it('a module server: built-ins plus its POSTGRES_USER default database', () => {
    expect(platformDatabases('alpha-postgres', { compose, catalogue: cat })).toEqual(['alpha', 'postgres', 'template0', 'template1'])
    expect(platformDatabases('beta-postgres', { compose, catalogue: cat })).toEqual(['beta', 'postgres', 'template0', 'template1'])
  })

  it('Amendment item 4: a platform server adds its declared databases', () => {
    expect(platformDatabases('gamma-postgres', { compose, catalogue: cat })).toEqual(['gamma', 'postgres', 'synapse', 'template0', 'template1'])
  })

  it('no entry is a prefix pattern (never a t_ filter)', () => {
    for (const svc of ['postgres', 'alpha-postgres', 'gamma-postgres']) {
      for (const name of platformDatabases(svc, { compose, catalogue: cat })) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('compose.ts reads the same label runtime.ts names', () => {
    expect(COMPOSE_POSTGRES_LABEL).toBe(POSTGRES_LABEL)
  })

  it('an unknown or unlabelled service throws', () => {
    expect(() => platformDatabases('ghost-postgres', { compose, catalogue: cat })).toThrow(/no compose service ghost-postgres/)
    expect(() => platformDatabases('web', { compose, catalogue: cat })).toThrow(/web carries no org\.gremion\.postgres label/)
  })
})
