// @vitest-environment node
// TASK-117 TDD 1 — cross-tenant isolation through the seam (TRD-065/067).
// A handle tenant A's backend produced must be refused by tenant B's backend
// on read AND delete, and A's bytes must survive the attempt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configureStorage, getStorageFor, resetStorageForTest } from './index.js'
import { mountedScratchRoot, TENANT_A as A, TENANT_B as B } from '../test/support.js'

let cleanup: () => Promise<void>

beforeEach(async () => {
  const m = await mountedScratchRoot('iso')
  cleanup = m.cleanup
  configureStorage({ backend: 'local', root: m.root, mountinfoPath: m.mountinfoPath })
})
afterEach(async () => {
  resetStorageForTest()
  await cleanup()
})

describe('cross-tenant isolation', () => {
  it("tenant B cannot read or delete a handle tenant A produced; A's bytes survive", async () => {
    const bytesA = new Uint8Array([0x41, 0x41])
    const hA = await getStorageFor(A).put('x/r.pdf', bytesA)
    await expect(getStorageFor(B).read(hA)).rejects.toThrow(/handle escapes tenant root/)
    await expect(getStorageFor(B).delete(hA)).rejects.toThrow(/handle escapes tenant root/)
    expect(Array.from(await getStorageFor(A).read(hA))).toEqual([0x41, 0x41])
  })

  it('B putting the same relPath gets a handle distinct from A', async () => {
    const hA = await getStorageFor(A).put('x/r.pdf', new Uint8Array([1]))
    const hB = await getStorageFor(B).put('x/r.pdf', new Uint8Array([2]))
    expect(hB).not.toBe(hA)
    expect(Array.from(await getStorageFor(A).read(hA))).toEqual([1])
    expect(Array.from(await getStorageFor(B).read(hB))).toEqual([2])
  })

  it('every handle begins with the tenant segment (S3 / DB-IDT-BRANDING logo_asset_key shape)', async () => {
    const hA = await getStorageFor(A).put('/branding/logo.svg', new Uint8Array([3]))
    expect(hA).toBe(`${A}/branding/logo.svg`)
  })

  it('a handle that walks out of A via .. into B is refused by A before any I/O', async () => {
    const hB = await getStorageFor(B).put('x/r.pdf', new Uint8Array([7]))
    const smuggled = `${A}/x/../../${hB}`
    await expect(getStorageFor(A).read(smuggled)).rejects.toThrow(/handle escapes tenant root/)
    await expect(getStorageFor(A).delete(smuggled)).rejects.toThrow(/handle escapes tenant root/)
    expect(Array.from(await getStorageFor(B).read(hB))).toEqual([7])
  })

  it('legacy absolute-path handles and bare-root handles are refused', async () => {
    const hA = await getStorageFor(A).put('x/r.pdf', new Uint8Array([1]))
    for (const bad of [`/${hA}`, A, `${A}/`, `${A}//x/r.pdf`, `x/r.pdf`, `${A}\\x\\r.pdf`]) {
      await expect(getStorageFor(A).read(bad)).rejects.toThrow(/handle escapes tenant root/)
    }
  })
})
