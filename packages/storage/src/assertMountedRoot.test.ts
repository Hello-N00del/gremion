// @vitest-environment node
// TASK-117 TDD 3 — the local backend refuses an unmounted root (spec-b §1.3).
// Fixture mount tables stand in for /proc/self/mountinfo; the live proof
// (paired `docker run`, with and without a volume) is in scripts/mount-proof.mjs.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { assertMountedRoot, parseMountPoints } from './assertMountedRoot.js'
import { LocalStorageBackend } from './local.js'
import { FIXTURES, TENANT_A } from '../test/support.js'

const MOUNTED = join(FIXTURES, 'mountinfo-mounted.txt')
const UNMOUNTED = join(FIXTURES, 'mountinfo-unmounted.txt')
const EMPTY = join(FIXTURES, 'mountinfo-empty.txt')
const MISSING = join(FIXTURES, 'no-such-mountinfo.txt')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('assertMountedRoot', () => {
  it('passes when the root is listed as a mount point', () => {
    expect(assertMountedRoot('/srv/gremion/storage', MOUNTED)).toEqual({ checked: true })
  })

  it('decodes octal escapes in the mount-point field', () => {
    expect(parseMountPoints('99 22 8:1 /x /srv/with\\040space rw - ext4 /dev/sda1 rw\n').has('/srv/with space')).toBe(true)
    expect(assertMountedRoot('/srv/with space', MOUNTED)).toEqual({ checked: true })
  })

  it('throws when the root is absent — a parent mount or a subdirectory does not count', () => {
    expect(() => assertMountedRoot('/srv/gremion/storage', UNMOUNTED)).toThrow(
      'storage(local): /srv/gremion/storage is not a mount point',
    )
    expect(() => assertMountedRoot('/srv/gremion/storage/sub', MOUNTED)).toThrow(/is not a mount point/)
  })

  it('compares the RESOLVED root (trailing slash, relative segments)', () => {
    expect(assertMountedRoot('/srv/gremion/storage/', MOUNTED)).toEqual({ checked: true })
    expect(assertMountedRoot('/srv/gremion/x/../storage', MOUNTED)).toEqual({ checked: true })
  })

  it('a mount table with no mount points fails closed', () => {
    expect(() => assertMountedRoot('/srv/gremion/storage', EMPTY)).toThrow(/lists no mount points/)
  })

  it('a MISSING mount table skips the check and says why (never a silent pass)', () => {
    const result = assertMountedRoot('/srv/gremion/storage', MISSING)
    expect(result.checked).toBe(false)
    expect(result).toMatchObject({ reason: expect.stringMatching(/does not exist .*cannot be determined/) })
  })

  it('any other read error fails closed', () => {
    const eacces = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    expect(() => assertMountedRoot('/srv/gremion/storage', MOUNTED, eacces)).toThrow(/cannot read mount table .*EACCES/)
  })
})

describe('LocalStorageBackend construction', () => {
  it('refuses to construct on an unmounted root', () => {
    expect(() => new LocalStorageBackend(TENANT_A, { root: '/srv/gremion/storage', mountinfoPath: UNMOUNTED })).toThrow(
      'storage(local): /srv/gremion/storage is not a mount point',
    )
  })

  it('constructs on a mounted root and records the check', () => {
    const b = new LocalStorageBackend(TENANT_A, { root: '/srv/gremion/storage', mountinfoPath: MOUNTED })
    expect(b.mountCheck).toEqual({ checked: true })
  })

  it('logs the skip reason when the mount table is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const b = new LocalStorageBackend(TENANT_A, { root: '/srv/gremion/storage', mountinfoPath: MISSING })
    expect(b.mountCheck.checked).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mount-point check SKIPPED: .*does not exist/))
  })

  it('the default root (./var/storage) is refused on a Linux host where it is not a mount', () => {
    expect(() => new LocalStorageBackend(TENANT_A, { mountinfoPath: UNMOUNTED })).toThrow(/var\/storage is not a mount point/)
  })
})
