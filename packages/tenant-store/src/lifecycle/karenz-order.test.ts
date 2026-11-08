// Order of the day-30 row: everything the later export delete will refuse about the export STORAGE (a root that is
// not the export directory, a mount check that fails at construction) is refused before the row is claimed and
// before the database is dropped. The platform and the module server are recording fakes: no database is needed
// to prove that a destructive step did not run.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorageBackend } from '@gremion/storage'
import { afterAll, describe, expect, it } from 'vitest'
import { tenantModuleDbName } from '../names.js'
import { finalizeDueKarenz, type FinalizeDeps } from './karenz.js'
import type { LifecycleModule } from './types.js'

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const content = 'dump bytes'
const root = mkdtempSync(join(tmpdir(), 'karenz order '))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function harness(exportStorage: FinalizeDeps['exportStorage']) {
  const exportDir = join(root, `case-${Math.random().toString(36).slice(2)}`)
  const dump = join(exportDir, T, 'lcfix', 'a.dump')
  mkdirSync(join(exportDir, T, 'lcfix'), { recursive: true })
  writeFileSync(dump, content)
  const dueRow = {
    karenz_id: 'k1', customer_id: T, module_id: 'm1', module_key: 'lcfix', state: 'open', export_path: dump,
    export_sha256: createHash('sha256').update(content).digest('hex'), export_deleted_at: null, platform_done_at: null, tenant_done_at: null, retained_ok_at: null,
  }
  const events: string[] = []
  const platform = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?')
      if (/FROM plt\.module_karenz k JOIN/.test(text)) return [dueRow]
      if (/FROM plt\.module_database/.test(text)) {
        return [{ db_name: tenantModuleDbName(T, 'lcfix'), state: 'blocked', export_path: dump, export_sha256: dueRow.export_sha256, exported_at: new Date() }]
      }
      return []
    },
    { begin: async () => { events.push('claim'); return false } },
  )
  const admin = Object.assign(async () => { events.push('admin'); throw new Error('the database must not be touched') }, {})
  const deps = {
    platform,
    server: () => ({ admin, open: () => { throw new Error('unused') } }),
    catalogue: [{ id: 'lcfix', moduleJson: { runtime: { database: { postgresService: 'pgm' } } } }] as unknown as LifecycleModule[],
    exportDir,
    exportStorage,
    finalDeletion: true,
  } as unknown as FinalizeDeps
  return { deps, events }
}

describe('finalizeDueKarenz: the export storage is validated before the row is claimed and the database dropped', () => {
  it('an export storage rooted elsewhere is refused with nothing claimed and nothing dropped', async () => {
    const { deps, events } = harness((tenant) => Object.assign(new MemoryStorageBackend(tenant), { root: join(root, 'elsewhere') }))
    const r = await finalizeDueKarenz(deps)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.message).toMatch(/TARGET_REFUSED.*rooted at/)
    expect(events).toEqual([])
  })

  it('a storage that fails at construction (the seam\'s mount check) is refused the same way', async () => {
    const { deps, events } = harness(() => {
      throw new Error('storage root is not a mount point')
    })
    const r = await finalizeDueKarenz(deps)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.message).toMatch(/not a mount point/)
    expect(events).toEqual([])
  })

  it('a storage that agrees with the export directory goes on to claim the row', async () => {
    let exportDir = ''
    const { deps, events } = harness((tenant) => Object.assign(new MemoryStorageBackend(tenant), { root: exportDir }))
    exportDir = deps.exportDir
    const r = await finalizeDueKarenz(deps)
    expect(r.errors).toEqual([])
    expect(events).toEqual(['claim'])
  })
})
