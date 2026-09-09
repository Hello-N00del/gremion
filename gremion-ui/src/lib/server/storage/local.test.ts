// src/lib/server/storage/local.test.ts
// Unit tests for LocalStorageBackend — tmpdir-scoped, no shared state.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStorageBackend } from './local'

let root: string
let backend: LocalStorageBackend

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gremion-storage-'))
  backend = new LocalStorageBackend(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalStorageBackend.put', () => {
  it('writes the bytes, returns an absolute handle under the root, creates parent dirs', async () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
    const handle = await backend.put('finance/expense/42/r.pdf', bytes)
    expect(handle.startsWith(root)).toBe(true)
    expect(handle.endsWith('r.pdf')).toBe(true)
    const written = await readFile(handle)
    expect(Buffer.from(written).toString('utf-8')).toBe('hello')
  })

  it('refuses paths that try to escape the root via ..', async () => {
    await expect(backend.put('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/escapes root/)
  })
})

describe('LocalStorageBackend.read / delete', () => {
  it('round-trips bytes through put -> read', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const handle = await backend.put('a/b/c.bin', payload)
    const got = await backend.read(handle)
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5])
  })

  it('delete removes the file and is idempotent on missing files', async () => {
    const handle = await backend.put('x.txt', new Uint8Array([9]))
    await backend.delete(handle)
    await expect(stat(handle)).rejects.toMatchObject({ code: 'ENOENT' })
    // Second delete must not throw.
    await backend.delete(handle)
  })

  it('refuses to read/delete a handle outside the root', async () => {
    const outside = join(tmpdir(), 'definitely-not-mine.txt')
    await expect(backend.read(outside)).rejects.toThrow(/escapes root/)
    await expect(backend.delete(outside)).rejects.toThrow(/escapes root/)
  })
})
