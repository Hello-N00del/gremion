// @vitest-environment node
// LocalStorageBackend unit tests — moved from gremion-ui/src/lib/server/storage
// (TASK-117 §6.8) with their three behaviours kept: path-traversal refusal,
// absolute-path/drive-letter refusal, ENOENT-idempotent delete. Roots now live
// under <checkout>/.scratch/t117 instead of mkdtemp(tmpdir()).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalStorageBackend } from './local.js'
import { mountedScratchRoot, TENANT_A } from '../test/support.js'

let root: string
let backend: LocalStorageBackend
let cleanup: () => Promise<void>

beforeEach(async () => {
  const m = await mountedScratchRoot('local')
  root = m.root
  cleanup = m.cleanup
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
