// @vitest-environment node
// TASK-117 TDD 2 — a write with no tenant throws SYNCHRONOUSLY, before any I/O.
// The local backend's filesystem is an injected spy: every refused call below
// must leave its call log empty. (spec-b S2; TRD-067.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configureStorage, getStorageFor, resetStorageForTest, LocalStorageBackend } from './index.js'
import { nodeFs as nodeFsForTest } from './local.js'
import type { StorageFs } from './types.js'
import { mountedScratchRoot, TENANT_A, TENANT_B } from '../test/support.js'

let calls: string[]
let spyFs: StorageFs
let root: string
let mountinfoPath: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  const m = await mountedScratchRoot('notenant')
  ;({ root, mountinfoPath, cleanup } = m)
  calls = []
  spyFs = Object.fromEntries(
    Object.entries(nodeFsForTest).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name)
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as StorageFs
  configureStorage({ backend: 'local', root, mountinfoPath, fs: spyFs })
})
afterEach(async () => {
  resetStorageForTest()
  await cleanup()
})

describe('no tenant -> synchronous throw before any I/O', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', ' '],
    ['traversal', '../x'],
  ])('getStorageFor(%s) throws synchronously with zero fs calls', (_label, bad) => {
    expect(() => getStorageFor(bad as never).put('r.pdf', new Uint8Array([1]))).toThrow(/storage: (no|invalid) tenant id/)
    expect(calls).toEqual([])
  })

  it('the backend constructor itself refuses an empty tenant before reading the mount table', () => {
    expect(() => new LocalStorageBackend('', { root, mountinfoPath, fs: spyFs })).toThrow(/storage: no tenant id/)
    expect(calls).toEqual([])
  })

  it('the tenant check runs before the not-configured check', () => {
    resetStorageForTest()
    expect(() => getStorageFor('' as never)).toThrow(/no tenant id/)
    expect(() => getStorageFor(TENANT_A)).toThrow(/not configured/)
  })

  it('a valid tenant does reach the filesystem (the spy is live, not vacuous)', async () => {
    await getStorageFor(TENANT_A).put('r.pdf', new Uint8Array([1]))
    expect(calls).toContain('writeFile')
  })

  it('a cross-tenant read/delete and a traversal put are refused with zero data I/O', async () => {
    const hA = await getStorageFor(TENANT_A).put('r.pdf', new Uint8Array([1]))
    const b = getStorageFor(TENANT_B) // constructing B reads the mount table once
    calls = []
    await expect(b.read(hA)).rejects.toThrow(/escapes tenant root/)
    await expect(b.delete(hA)).rejects.toThrow(/escapes tenant root/)
    await expect(b.put('../x', new Uint8Array([1]))).rejects.toThrow(/escapes tenant root/)
    await expect(b.list('../')).rejects.toThrow(/escapes tenant root/)
    expect(calls).toEqual([])
  })
})
