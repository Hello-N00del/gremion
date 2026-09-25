// @vitest-environment node
// TASK-117 TDD 4 (+7, Q6) — the backend-selectability contract (TRD-066).
//
// ONE suite, run against every backend in STORAGE_BACKENDS. The ONLY thing
// that differs between the runs is the `backend` name handed to
// configureStorage() — backend selection is configuration alone. A backend
// added to STORAGE_BACKENDS without passing this suite fails the guard test
// at the bottom.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configureStorage, getStorageFor, resetStorageForTest, STORAGE_BACKENDS } from './index.js'
import { mountedScratchRoot, TENANT_A as A, TENANT_B as B } from '../test/support.js'

const CONTRACT_BACKENDS = ['local', 'memory'] as const

describe.each(CONTRACT_BACKENDS)('StorageBackend contract: STORAGE_BACKEND=%s', (backend) => {
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const m = await mountedScratchRoot(`contract-${backend}`)
    cleanup = m.cleanup
    configureStorage({ backend, root: m.root, mountinfoPath: m.mountinfoPath, allowTestDouble: true })
  })
  afterEach(async () => {
    resetStorageForTest()
    await cleanup()
  })

  it('round-trips bytes and returns a tenant-prefixed handle', async () => {
    const h = await getStorageFor(A).put('a/b/c.bin', new Uint8Array([1, 2, 3]))
    expect(h).toBe(`${A}/a/b/c.bin`)
    expect(Array.from(await getStorageFor(A).read(h))).toEqual([1, 2, 3])
  })

  it('put overwrites in place; read returns a copy the caller cannot mutate into storage', async () => {
    const h = await getStorageFor(A).put('o.bin', new Uint8Array([1]))
    await getStorageFor(A).put('o.bin', new Uint8Array([2, 2]))
    const got = await getStorageFor(A).read(h)
    expect(Array.from(got)).toEqual([2, 2])
    got[0] = 9
    expect(Array.from(await getStorageFor(A).read(h))).toEqual([2, 2])
  })

  it('isolation: B cannot read or delete A\'s handle; A\'s bytes survive', async () => {
    const hA = await getStorageFor(A).put('x/r.pdf', new Uint8Array([0x41]))
    await expect(getStorageFor(B).read(hA)).rejects.toThrow(/handle escapes tenant root/)
    await expect(getStorageFor(B).delete(hA)).rejects.toThrow(/handle escapes tenant root/)
    expect(Array.from(await getStorageFor(A).read(hA))).toEqual([0x41])
  })

  it('refuses traversal, absolute and drive-letter paths', async () => {
    await expect(getStorageFor(A).put('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/escapes tenant root/)
    await expect(getStorageFor(A).put(`../${B}/x`, new Uint8Array([1]))).rejects.toThrow(/escapes tenant root/)
    await expect(getStorageFor(A).put('C:/x', new Uint8Array([1]))).rejects.toThrow(/refusing absolute path/)
  })

  it('refuses non-Uint8Array bytes', async () => {
    await expect(getStorageFor(A).put('x', 'text' as never)).rejects.toThrow(/bytes must be a Uint8Array/)
  })

  it('read of a missing object rejects; delete is idempotent', async () => {
    const h = await getStorageFor(A).put('gone.txt', new Uint8Array([1]))
    await getStorageFor(A).delete(h)
    await expect(getStorageFor(A).read(h)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(getStorageFor(A).delete(h)).resolves.toBeUndefined()
  })

  it('list() returns only the calling tenant\'s handles, sorted, optionally under a prefix (Q6)', async () => {
    await getStorageFor(A).put('news/drafts/2.odt', new Uint8Array([2]))
    await getStorageFor(A).put('news/drafts/1.odt', new Uint8Array([1]))
    await getStorageFor(A).put('branding/logo.svg', new Uint8Array([3]))
    await getStorageFor(B).put('news/drafts/1.odt', new Uint8Array([4]))
    expect(await getStorageFor(A).list()).toEqual([
      `${A}/branding/logo.svg`,
      `${A}/news/drafts/1.odt`,
      `${A}/news/drafts/2.odt`,
    ])
    expect(await getStorageFor(A).list('news/drafts')).toEqual([`${A}/news/drafts/1.odt`, `${A}/news/drafts/2.odt`])
    expect(await getStorageFor(A).list('news/dr')).toEqual([])
    expect(await getStorageFor(A).list('nothing-here')).toEqual([])
    expect(await getStorageFor(B).list()).toEqual([`${B}/news/drafts/1.odt`])
    await expect(getStorageFor(A).list(`../${B}`)).rejects.toThrow(/escapes tenant root/)
  })

  it('every listed handle is readable by its own tenant', async () => {
    await getStorageFor(A).put('p/q.bin', new Uint8Array([5]))
    for (const h of await getStorageFor(A).list()) {
      expect((await getStorageFor(A).read(h)).length).toBeGreaterThan(0)
    }
  })

  it('TRD-067: two concurrent writes from two tenant contexts to the same relPath resolve to distinct, independently readable keys', async () => {
    const payloadA = new Uint8Array(64 * 1024).fill(0xaa)
    const payloadB = new Uint8Array(64 * 1024).fill(0xbb)
    const settled = await Promise.allSettled([
      getStorageFor(A).put('news/drafts/shared.odt', payloadA),
      getStorageFor(B).put('news/drafts/shared.odt', payloadB),
    ])
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled'])
    const [hA, hB] = settled.map((s) => (s as PromiseFulfilledResult<string>).value)
    expect(hA).not.toBe(hB)
    expect(hA).toBe(`${A}/news/drafts/shared.odt`)
    expect(hB).toBe(`${B}/news/drafts/shared.odt`)
    const [rA, rB] = await Promise.all([getStorageFor(A).read(hA!), getStorageFor(B).read(hB!)])
    expect(rA.every((x) => x === 0xaa) && rA.length === payloadA.length).toBe(true)
    expect(rB.every((x) => x === 0xbb) && rB.length === payloadB.length).toBe(true)
  })

  it('a directory-shaped handle behaves the same on every backend: read ENOENT, delete no-op', async () => {
    await getStorageFor(A).put('news/x.odt', new Uint8Array([1]))
    await expect(getStorageFor(A).read(`${A}/news`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(getStorageFor(A).delete(`${A}/news`)).resolves.toBeUndefined()
    expect(await getStorageFor(A).list()).toEqual([`${A}/news/x.odt`])
  })

  it('refuses a relPath shaped like the local backend\'s in-flight temp names', async () => {
    await expect(
      getStorageFor(A).put('d/.x.odt.12345678-1234-4234-8234-123456789012.partial', new Uint8Array([1])),
    ).rejects.toThrow(/reserved temp-file name/)
  })

  it('memoises one backend per tenant; reconfiguring drops the map', async () => {
    const a1 = getStorageFor(A)
    expect(getStorageFor(A)).toBe(a1)
    expect(getStorageFor(B)).not.toBe(a1)
    expect(a1.tenantId).toBe(A)
    configureStorage({ backend: 'memory', allowTestDouble: true })
    expect(getStorageFor(A)).not.toBe(a1)
    resetStorageForTest()
    expect(() => getStorageFor(A)).toThrow(/not configured/)
  })
})

describe('selectability guard', () => {
  it('every selectable backend runs the contract suite', () => {
    expect([...STORAGE_BACKENDS].sort()).toEqual([...CONTRACT_BACKENDS].sort())
  })

  it('an unknown STORAGE_BACKEND is refused at configuration, not at first use', () => {
    expect(() => configureStorage({ backend: 's3' })).toThrow(/unknown STORAGE_BACKEND="s3"/)
    expect(() => configureStorage({ backend: '' })).toThrow(/unknown STORAGE_BACKEND/)
  })

  it('the memory test double must be explicitly allowed (review round 1)', () => {
    expect(() => configureStorage({ backend: 'memory' })).toThrow(/test double.*allowTestDouble/)
  })

  it('local: the root is mount-checked at configuration time, not first use (review round 1)', async () => {
    const m = await mountedScratchRoot('eager')
    try {
      expect(() => configureStorage({ backend: 'local', root: `${m.root}/sub`, mountinfoPath: m.mountinfoPath })).toThrow(
        /is not a mount point/,
      )
      expect(() => getStorageFor(A)).toThrow(/not configured/)
    } finally {
      await m.cleanup()
    }
  })

  it('backend names are case- and whitespace-insensitive', () => {
    configureStorage({ backend: ' MEMORY ', allowTestDouble: true })
    expect(getStorageFor(A).constructor.name).toBe('MemoryStorageBackend')
    resetStorageForTest()
  })
})
