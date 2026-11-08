// Task 18 gate fix: the day-30 job and the retried switch-off delete export files THROUGH the storage seam
// (@gremion/storage), never with a raw fs call (scripts/check-storage-seam.mjs, guard s3).
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalStorageBackend, MemoryStorageBackend, type StorageBackend } from '@gremion/storage'
import { removeKarenzExport } from '../../src/lifecycle/export-remove.js'
import { mountinfoLine } from '../harness/mountinfo.js'

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

/** A storage factory that remembers every backend it handed out. */
function recordingFactory(seen: ReturnType<typeof recording>[]): (tenantId: string) => ReturnType<typeof recording> {
  return (t) => {
    const r = recording(t)
    seen.push(r)
    return r
  }
}

describe('removeKarenzExport', () => {
  const dir = '/exports'
  const path = join(dir, T, 'lcfix', '20261031T000000000Z.dump')

  it('deletes the dump and its sidecar through the injected storage, by tenant-prefixed handle', async () => {
    const seen: ReturnType<typeof recording>[] = []
    await removeKarenzExport(path, { exportDir: dir, exportStorage: recordingFactory(seen) }, T, 'lcfix')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.tenantId).toBe(T)
    expect(seen[0]!.deleted).toEqual([`${T}/lcfix/20261031T000000000Z.dump`, `${T}/lcfix/20261031T000000000Z.dump.sha256`])
  })

  it('deletes the handle of the VALIDATED path, not of the raw string (a trailing dot segment must not change what is deleted)', async () => {
    const seen: ReturnType<typeof recording>[] = []
    await removeKarenzExport(`${path}/.`, { exportDir: dir, exportStorage: recordingFactory(seen) }, T, 'lcfix')
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

describe('removeKarenzExport: one root', () => {
  it('refuses a storage whose root is not the export directory the path was checked against, before anything is deleted', async () => {
    const real = mkdtempSync(join(tmpdir(), 'karenz one root '))
    const elsewhere = mkdtempSync(join(tmpdir(), 'karenz other root '))
    try {
      const mountinfo = join(real, 'mountinfo')
      writeFileSync(mountinfo, mountinfoLine(elsewhere))
      const d = join(real, T, 'lcfix')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'a.dump'), 'x')
      // the path is checked against `real`, the storage is rooted at `elsewhere`: a delete through it would
      // resolve as success (a missing object) while the dump under `real` stays
      const exportStorage = (t: string) => new LocalStorageBackend(t, { root: elsewhere, mountinfoPath: mountinfo, platform: 'linux' })
      await expect(removeKarenzExport(join(d, 'a.dump'), { exportDir: real, exportStorage }, T, 'lcfix')).rejects.toMatchObject({ code: 'TARGET_REFUSED' })
      expect(existsSync(join(d, 'a.dump'))).toBe(true)
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('removeKarenzExport on the local backend', () => {
  // a space in the scratch root: the mount table escapes it as \040, so the fake table must too
  const root = mkdtempSync(join(tmpdir(), 'karenz export remove '))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  // a mount table that lists the scratch root, so the seam's mount check passes on any host
  const mountinfo = join(root, 'mountinfo')
  writeFileSync(mountinfo, mountinfoLine(root))
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
