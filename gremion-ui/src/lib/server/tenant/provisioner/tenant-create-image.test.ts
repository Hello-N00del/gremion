// TASK-043 TDD 19 (G4): the tenant-create image (gremion-ui/Dockerfile's
// builder stage) carries everything the verbs load: every module.json of the
// catalogue, the migration directory of every module that declares a database,
// and the manifest AND source of every workspace package @gremion/provisioning
// reaches. A dropped COPY goes RED here, not on a host.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const dockerfile = readFileSync(join(REPO, 'gremion-ui', 'Dockerfile'), 'utf-8')
const copies = dockerfile
  .split('\n')
  .map((l) => /^COPY\s+(?!--from)(\S+)\s+(\S+)\s*$/.exec(l.trim()))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => m[1]!)

function workspaceDeps(pkg: string, seen = new Set<string>()): Set<string> {
  const json = JSON.parse(readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> }
  for (const [name, range] of Object.entries(json.dependencies ?? {})) {
    if (!range.startsWith('workspace:') || !name.startsWith('@gremion/')) continue
    const dir = name.slice('@gremion/'.length)
    if (seen.has(dir)) continue
    seen.add(dir)
    workspaceDeps(dir, seen)
  }
  return seen
}

describe('the tenant-create image (G4)', () => {
  const modules = readdirSync(join(REPO, 'modules')).filter((d) => existsSync(join(REPO, 'modules', d, 'module.json')))

  it('the catalogue is non-empty (the check is not vacuous)', () => {
    expect(modules.length).toBeGreaterThan(5)
  })

  it.each(modules)('module %s: its module.json is copied, and its migrations when it declares a database', (id) => {
    expect(copies).toContain(`modules/${id}/module.json`)
    const mj = JSON.parse(readFileSync(join(REPO, 'modules', id, 'module.json'), 'utf-8')) as { runtime: { database: { migrations: string } | null } }
    if (mj.runtime.database) expect(copies).toContain(`modules/${id}/${mj.runtime.database.migrations}`)
  })

  it('every workspace package @gremion/provisioning reaches is copied, manifest first and then source', () => {
    const deps = [...workspaceDeps('provisioning'), 'provisioning']
    expect(deps).toEqual(expect.arrayContaining(['tenant-store', 'module-catalogue', 'edge-routers', 'nats-auth', 'db']))
    for (const d of deps) {
      const manifest = copies.indexOf(`packages/${d}/package.json`)
      const source = copies.indexOf(`packages/${d}`)
      expect(manifest, `COPY packages/${d}/package.json`).toBeGreaterThan(-1)
      expect(source, `COPY packages/${d}`).toBeGreaterThan(manifest)
    }
  })

  it('no module package.json is copied (it would join the frozen install as a workspace project)', () => {
    expect(copies.filter((c) => /^modules\/[^/]+\/package\.json$/.test(c))).toEqual([])
  })
})
