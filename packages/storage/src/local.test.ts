// @vitest-environment node
// LocalStorageBackend unit tests — moved from gremion-ui/src/lib/server/storage
// (TASK-117 §6.8) with their three behaviours kept: path-traversal refusal,
// absolute-path/drive-letter refusal, ENOENT-idempotent delete. Roots now live
// under <checkout>/.scratch/t117 instead of mkdtemp(tmpdir()).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stat, readFile, symlink, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalStorageBackend, nodeFs } from './local.js'
import { mountedScratchRoot, SCRATCH, TENANT_A, TENANT_B } from '../test/support.js'

// A directory link on win32 is a junction: it needs no privilege, and lstat
// reports it as a symbolic link, so the refusal is exercised on every host.
const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

// A FILE symlink on an unprivileged win32 host fails with EPERM (no
// SeCreateSymbolicLinkPrivilege / developer mode). Probe the capability
// instead of assuming it; any other probe error is a real failure.
const canSymlinkFiles: boolean = await (async () => {
  const dir = join(SCRATCH, `symlink-probe-${process.pid}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, 't'), 'x')
    await symlink(join(dir, 't'), join(dir, 'l'), 'file')
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})()

let root: string
let backend: LocalStorageBackend
let cleanup: () => Promise<void>
let mountinfo: string

beforeEach(async () => {
  const m = await mountedScratchRoot('local')
  root = m.root
  cleanup = m.cleanup
  mountinfo = m.mountinfoPath
  backend = new LocalStorageBackend(TENANT_A, { root, mountinfoPath: m.mountinfoPath })
})
afterEach(async () => {
  await cleanup()
})

describe('LocalStorageBackend.put', () => {
  it('writes the bytes under <root>/<tenant>/, returns the tenant-prefixed key, creates parent dirs', async () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
    const handle = await backend.put('finance/expense/42/r.pdf', bytes)
    expect(handle).toBe(`${TENANT_A}/finance/expense/42/r.pdf`)
    const written = await readFile(join(root, TENANT_A, 'finance/expense/42/r.pdf'))
    expect(Buffer.from(written).toString('utf-8')).toBe('hello')
  })

  it('refuses paths that try to escape the root via ..', async () => {
    await expect(backend.put('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/escapes tenant root/)
    await expect(backend.put('a/../../b', new Uint8Array([1]))).rejects.toThrow(/escapes tenant root/)
  })

  it('refuses drive letters; strips a leading slash instead of treating it as absolute', async () => {
    await expect(backend.put('C:/Windows/x', new Uint8Array([1]))).rejects.toThrow(/refusing absolute path/)
    await expect(backend.put('c:x', new Uint8Array([1]))).rejects.toThrow(/refusing absolute path/)
    expect(await backend.put('/etc/passwd', new Uint8Array([1]))).toBe(`${TENANT_A}/etc/passwd`)
    await expect(stat(join(root, TENANT_A, 'etc/passwd'))).resolves.toBeTruthy()
  })

  it('refuses backslashes, NUL, empty and directory-shaped paths', async () => {
    for (const bad of ['a\\b', 'a\0b', '', '.', 'dir/']) {
      await expect(backend.put(bad, new Uint8Array([1]))).rejects.toThrow(/storage\(local\)/)
    }
  })
})

describe('LocalStorageBackend.read / delete', () => {
  it('round-trips bytes through put -> read', async () => {
    const handle = await backend.put('a/b/c.bin', new Uint8Array([1, 2, 3, 4, 5]))
    expect(Array.from(await backend.read(handle))).toEqual([1, 2, 3, 4, 5])
  })

  it('delete removes the file and is idempotent on missing files', async () => {
    const handle = await backend.put('x.txt', new Uint8Array([9]))
    await backend.delete(handle)
    await expect(stat(join(root, handle))).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.delete(handle) // second delete must not throw
  })

  it('refuses to read/delete a handle outside the tenant root', async () => {
    const outside = join(root, '..', 'definitely-not-mine.txt')
    await expect(backend.read(outside)).rejects.toThrow(/escapes tenant root/)
    await expect(backend.delete(outside)).rejects.toThrow(/escapes tenant root/)
  })
})

describe('LocalStorageBackend symlink refusal (review round 1, security M1)', () => {
  it('a symlink planted under the tenant root into another tenant is never followed', async () => {
    const other = join(root, TENANT_B, 'secret')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 's.txt'), 'B-SECRET')
    await mkdir(join(root, TENANT_A), { recursive: true })
    await symlink(join(root, TENANT_B), join(root, TENANT_A, 'link'), DIR_LINK_TYPE)
    await expect(backend.read(`${TENANT_A}/link/secret/s.txt`)).rejects.toThrow(/refusing symlink/)
    await expect(backend.put('link/secret/planted.txt', new Uint8Array([1]))).rejects.toThrow(/refusing symlink/)
    await expect(backend.delete(`${TENANT_A}/link/secret/s.txt`)).rejects.toThrow(/refusing symlink/)
    await expect(backend.list('link')).rejects.toThrow(/refusing symlink/)
    expect(await backend.list()).toEqual([])
    await expect(stat(join(other, 'planted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(other, 's.txt'), 'utf8')).toBe('B-SECRET')
  })

  // Linux (the gate that matters) always runs this; an unprivileged win32
  // host skips it, and the directory case above still covers the lstat walk.
  it.skipIf(!canSymlinkFiles)('a symlinked file under the tenant root is refused too', async () => {
    await mkdir(join(root, TENANT_A), { recursive: true })
    await writeFile(join(root, 'outside.txt'), 'X')
    await symlink(join(root, 'outside.txt'), join(root, TENANT_A, 'f.txt'), 'file')
    await expect(backend.read(`${TENANT_A}/f.txt`)).rejects.toThrow(/refusing symlink/)
  })
})

describe('LocalStorageBackend.list when the root vanished (review round 1, silent-failure)', () => {
  it('throws instead of reporting an empty tenant', async () => {
    await backend.put('x.txt', new Uint8Array([1]))
    await rm(root, { recursive: true, force: true })
    await expect(backend.list()).rejects.toThrow(/storage root .* is missing \(ENOENT\)/)
  })
})

describe('review round 2 (LocalStorageBackend)', () => {
  it('delete/read through a path whose middle component is a FILE are "no object", not ENOTDIR', async () => {
    const h = await backend.put('file', new Uint8Array([1]))
    await expect(backend.delete(`${h}/y`)).resolves.toBeUndefined()
    await expect(backend.read(`${h}/y`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('list() refuses when the root is no longer a mount point (volume detached, directory left behind)', async () => {
    await backend.put('x.txt', new Uint8Array([1]))
    await rm(join(root, TENANT_A), { recursive: true, force: true })
    const detached = new LocalStorageBackend(TENANT_A, { root, mountinfoPath: mountinfo })
    await writeFile(mountinfo, '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n')
    await expect(detached.list()).rejects.toThrow(/is not a mount point/)
  })
})

describe('intake round 1: unlink(dir) is EPERM on win32/macOS, EISDIR on Linux', () => {
  // Host-independent: the injected fs answers unlink the way win32 and macOS
  // do, so this runs (and guards) on the Linux gate too.
  const epermUnlink = (isDir: boolean) => ({
    ...nodeFs,
    unlink: async (p: string) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' })
    },
    lstat: async (p: string) => {
      const real = await nodeFs.lstat(p)
      return { isSymbolicLink: () => real.isSymbolicLink(), isDirectory: () => isDir }
    },
  })

  it('delete() on a directory-shaped handle is a no-op when unlink reports EPERM', async () => {
    await backend.put('news/x.odt', new Uint8Array([1]))
    const b = new LocalStorageBackend(TENANT_A, { root, mountinfoPath: mountinfo, fs: epermUnlink(true) })
    await expect(b.delete(`${TENANT_A}/news`)).resolves.toBeUndefined()
  })

  it('delete() still rejects EPERM on a real object (a permission failure is never swallowed)', async () => {
    await backend.put('news/x.odt', new Uint8Array([1]))
    const b = new LocalStorageBackend(TENANT_A, { root, mountinfoPath: mountinfo, fs: epermUnlink(false) })
    await expect(b.delete(`${TENANT_A}/news/x.odt`)).rejects.toMatchObject({ code: 'EPERM' })
  })
})
