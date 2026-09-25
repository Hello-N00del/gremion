// @vitest-environment node
// gremion-ui storage config adapter (TASK-117 §6.8): env -> @gremion/storage.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resetStorageForTest } from '@gremion/storage'
import * as adapter from './index'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const saved = { ...process.env }

afterEach(() => {
  resetStorageForTest()
  for (const k of ['STORAGE_BACKEND', 'RECEIPT_STORAGE_DIR', 'VITEST']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('storage config adapter', () => {
  it('exports getStorageFor and nothing else (no getStorage, no storage proxy)', () => {
    expect(Object.keys(adapter)).toEqual(['getStorageFor'])
  })

  it('STORAGE_BACKEND=memory selects the test double by configuration alone', async () => {
    process.env.STORAGE_BACKEND = 'memory'
    const h = await adapter.getStorageFor(A).put('news/drafts/1.odt', new Uint8Array([1]))
    expect(h).toBe(`${A}/news/drafts/1.odt`)
    await expect(adapter.getStorageFor(B).read(h)).rejects.toThrow(/handle escapes tenant root/)
  })

  it('no tenant throws synchronously, before the backend is even configured', () => {
    process.env.STORAGE_BACKEND = 'memory'
    expect(() => adapter.getStorageFor('' as never)).toThrow(/storage: no tenant id/)
    expect(() => adapter.getStorageFor(undefined as never)).toThrow(/storage: no tenant id/)
  })

  it('an unknown STORAGE_BACKEND is refused', () => {
    process.env.STORAGE_BACKEND = 'nextcloud'
    expect(() => adapter.getStorageFor(A)).toThrow(/unknown STORAGE_BACKEND="nextcloud"/)
  })

  it('the memory double is refused outside vitest', () => {
    process.env.STORAGE_BACKEND = 'memory'
    delete process.env.VITEST
    expect(() => adapter.getStorageFor(A)).toThrow(/refused outside vitest/)
  })

  it('STORAGE_BACKEND=local reads RECEIPT_STORAGE_DIR and refuses it when it is not a mount point', () => {
    process.env.STORAGE_BACKEND = 'local'
    const root = resolve(join(__dirname, '..', '..', '..', '..', '..', '.scratch', 't117', 'adapter-unmounted'))
    process.env.RECEIPT_STORAGE_DIR = root
    if (existsSync('/proc/self/mountinfo')) {
      expect(() => adapter.getStorageFor(A)).toThrow(`storage(local): ${root} is not a mount point`)
    } else {
      // no mount table on this host: the check is skipped and says so
      expect(adapter.getStorageFor(A)).toMatchObject({ mountCheck: { checked: false } })
    }
  })
})
