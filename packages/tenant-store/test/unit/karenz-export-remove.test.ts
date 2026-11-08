// Task 18 gate fix: the day-30 job and the retried switch-off delete export files THROUGH the storage seam
// (@gremion/storage), never with a raw fs call (scripts/check-storage-seam.mjs, guard s3).
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalStorageBackend, MemoryStorageBackend, type StorageBackend } from '@gremion/storage'
import { removeKarenzExport } from '../../src/lifecycle/export-remove.js'

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const U = '0192f0c1-2b3c-7d4e-8f00-665544332211'

/** A backend that records every delete and touches nothing. */
function recording(tenantId: string): StorageBackend & { deleted: string[] } {
  const deleted: string[] = []
  return {
    tenantId,
    deleted,
    put: async () => {
      throw new Error('put is not expected')
    },
    read: async () => {
      throw new Error('read is not expected')
    },
    delete: async (h: string) => {
      deleted.push(h)
    },
    list: async () => [],
  }
}

describe('removeKarenzExport', () => {
  const dir = '/exports'
  const path = join(dir, T, 'lcfix', '20261031T000000000Z.dump')

  it('deletes the dump and its sidecar through the injected storage, by tenant-prefixed handle', async () => {
    const seen: ReturnType<typeof recording>[] = []
    await removeKarenzExport(path, { exportDir: dir, exportStorage: (t) => (seen.push(recording(t)), seen[seen.length - 1]!) }, T, 'lcfix')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.tenantId).toBe(T)
    expect(seen[0]!.deleted).toEqual([`${T}/lcfix/20261031T000000000Z.dump`, `${T}/lcfix/20261031T000000000Z.dump.sha256`])
  })

  it('refuses a path outside <exportDir>/<tenant>/<module>/ before the storage is asked for anything', async () => {
    let asked = 0
    const deps = { exportDir: dir, exportStorage: (t: string) => (asked++, recording(t)) }
    for (const bad of [join(dir, U, 'lcfix', 'x.dump'), join(dir, T, 'board', 'x.dump'), join(dir, T, 'lcfix', 'x.txt'), '/etc/passwd']) {
      await expect(removeKarenzExport(bad, deps, T, 'lcfix'), bad).rejects.toMatchObject({ code: 'TARGET_REFUSED' })
    }
    expect(asked).toBe(0)
  })

  it('does not swallow a real storage failure (only a missing object is success, and the seam says so itself)', async () => {
    const failing: StorageBackend = { ...recording(T), delete: async () => Promise.reject(Object.assign(new Error('EPERM: denied'), { code: 'EPERM' })) }
    await expect(removeKarenzExport(path, { exportDir: dir, exportStorage: () => failing }, T, 'lcfix')).rejects.toThrow(/EPERM/)
  })

  it('a missing dump is success (the day-30 job converges after a crash between delete and the row update)', async () => {
    const mem = new MemoryStorageBackend(T, new Map())
    await expect(removeKarenzExport(path, { exportDir: dir, exportStorage: () => mem }, T, 'lcfix')).resolves.toBeUndefined()
  })
})

describe('removeKarenzExport on the local backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'karenz-export-remove-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  // a mount table that lists the scratch root, so the seam's mount check passes on any host
  const mountinfo = join(root, 'mountinfo')
  writeFileSync(mountinfo, `36 1 8:1 / ${resolve(root)} rw - ext4 /dev/sda1 rw\n`)
  const exportStorage = (t: string) => new LocalStorageBackend(t, { root, mountinfoPath: mountinfo, platform: 'linux' })

  it('removes the dump and the sidecar from disk and leaves a sibling dump and another tenant alone', async () => {
    const d = join(root, T, 'lcfix')
    const other = join(root, U, 'lcfix')
    mkdirSync(d, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(d, 'a.dump'), 'x')
    writeFileSync(join(d, 'a.dump.sha256'), 'y')
    writeFileSync(join(d, 'b.dump'), 'z')
    writeFileSync(join(other, 'a.dump'), 'w')
    await removeKarenzExport(join(d, 'a.dump'), { exportDir: root, exportStorage }, T, 'lcfix')
    expect(readdirSync(d).sort()).toEqual(['b.dump'])
    expect(existsSync(join(other, 'a.dump'))).toBe(true)
  })
})
