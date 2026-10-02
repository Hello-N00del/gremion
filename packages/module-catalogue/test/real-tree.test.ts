// TDD 5 — the real tree: modules/*/module.json against the real
// docker-compose.yml. 11 of 11, and a mutation of a scratch COPY (never the
// tree itself) goes red. Post-conditions on the derived values.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCatalogue, KERNEL_ROOT, loadCatalogue } from '../src/catalogue.ts'
import { readCompose } from '../src/compose.ts'
import { deriveBackupServices, KERNEL_PLATFORM_DATABASES, platformDatabases } from '../src/runtime.ts'

const MODULES = join(KERNEL_ROOT, 'modules')
const compose = readCompose(join(KERNEL_ROOT, 'docker-compose.yml'))
const TMP = join(fileURLToPath(new URL('./.tmp/', import.meta.url)), `real-${process.pid}`)
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const EXPECTED_IDS = ['board', 'calendar', 'content', 'elections', 'files', 'finance', 'handover', 'messaging', 'publishing', 'vault', 'votes']

/** A copy of what the validator reads (module.json + migrations/), without node_modules or source. */
let copies = 0
function scratchModules(): string {
  const root = join(TMP, `modules-${copies++}`)
  for (const id of readdirSync(MODULES)) {
    const src = join(MODULES, id)
    if (!statSync(src).isDirectory()) continue
    mkdirSync(join(root, id), { recursive: true })
    if (existsSync(join(src, 'module.json'))) cpSync(join(src, 'module.json'), join(root, id, 'module.json'))
    if (existsSync(join(src, 'migrations'))) cpSync(join(src, 'migrations'), join(root, id, 'migrations'), { recursive: true })
  }
  return root
}

describe('the real modules/ tree', () => {
  it('--check modules: 11 of 11 module directories carry a valid module.json, every module:* server claimed once', () => {
    const r = checkCatalogue(MODULES, { compose })
    expect(r.problems).toEqual([])
    expect(r.directories).toBe(11)
    expect(r.valid).toBe(11)
    expect(r.modules.map((m) => m.id)).toEqual(EXPECTED_IDS)
  })

  it('the CLI says the same under plain node (the scoped-gate command)', () => {
    const r = spawnSync(process.execPath, [join(KERNEL_ROOT, 'packages/module-catalogue/bin/check.mjs'), '--check', MODULES], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/OK — 11 of 11 module directories under .* carry a valid module\.json/)
    expect(r.status).toBe(0)
  })

  it('deleting runtime.database from calendar/module.json goes RED (its migrations are still on disk)', () => {
    const root = scratchModules()
    expect(checkCatalogue(root, { compose }).problems).toEqual([]) // positive control: the copy is clean
    const file = join(root, 'calendar', 'module.json')
    const json = JSON.parse(readFileSync(file, 'utf8'))
    delete json.runtime.database
    writeFileSync(file, JSON.stringify(json))
    const text = checkCatalogue(root, { compose }).problems.join('\n')
    expect(text).toMatch(/calendar: runtime\.database is missing/)
    expect(text).toMatch(/calendar: migrations\/manifest\.json is on disk but runtime\.database is null/)
  })

  it('the derived backup list is the kernel server, the six database servers, then messaging-postgres exactly when compose carries it; removing calendar drops calendar-postgres, which is then unclaimed', () => {
    // Amendment R27 order (TASK-198 route (a)): the platform server is listed
    // after the database servers, and only once compose carries it.
    const platform = compose.services.has('messaging-postgres') ? ['messaging-postgres'] : []
    expect(deriveBackupServices(loadCatalogue(MODULES).modules)).toEqual([
      'postgres',
      'board-postgres',
      'calendar-postgres',
      'content-postgres',
      'finance-postgres',
      'newsletter-postgres',
      'vault-postgres',
      ...platform,
    ])
    const root = scratchModules()
    rmSync(join(root, 'calendar'), { recursive: true })
    expect(deriveBackupServices(loadCatalogue(root).modules)).not.toContain('calendar-postgres')
    expect(checkCatalogue(root, { compose }).problems).toEqual([
      'calendar-postgres is labelled org.gremion.postgres=module:calendar but no module.json claims it (runtime.database or runtime.platformServer)',
    ])
  })

  it('Amendment R27 order: messaging claims messaging-postgres exactly when compose carries it', () => {
    const messaging = loadCatalogue(MODULES).modules.find((m) => m.id === 'messaging')
    const inCompose = compose.services.has('messaging-postgres')
    // Absent route (TASK-021 before TASK-198): platformServer null. Present route: the claim.
    expect(messaging?.moduleJson.runtime.platformServer?.postgresService ?? null).toBe(inCompose ? 'messaging-postgres' : null)
  })

  it('platformDatabases on the real compose: the kernel closed list, and a module server\'s built-ins plus its init database', () => {
    const cat = loadCatalogue(MODULES).modules
    expect(platformDatabases('postgres', { compose, catalogue: cat })).toEqual([...KERNEL_PLATFORM_DATABASES].sort())
    expect(platformDatabases('board-postgres', { compose, catalogue: cat })).toEqual(['board', 'postgres', 'template0', 'template1'])
    expect(platformDatabases('newsletter-postgres', { compose, catalogue: cat })).toEqual(['newsletter', 'postgres', 'template0', 'template1'])
    // TASK-198: messaging's platform server holds only platform databases (synapse), never a customer one.
    const messagingServer = compose.services.has('messaging-postgres')
    expect(messagingServer ? platformDatabases('messaging-postgres', { compose, catalogue: cat }) : null).toEqual(
      messagingServer ? ['messaging', 'postgres', 'synapse', 'template0', 'template1'] : null,
    )
  })

  it('scripts/check-extraction-source.mjs agrees: 11 of 11 module directories', () => {
    const r = spawnSync(process.execPath, [join(KERNEL_ROOT, 'scripts/check-extraction-source.mjs'), '--modules-root', MODULES], { encoding: 'utf8' })
    expect(r.stdout).toMatch(/11 of 11 module directories under .* carry an agreeing module\.json/)
    expect(r.status).toBe(0)
  })
})
