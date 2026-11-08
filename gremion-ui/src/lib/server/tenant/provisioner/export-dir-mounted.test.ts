// @vitest-environment node
//
// Karenz phase 2, Task 18: the switch-off / day-30 gate and the storage seam must agree on what a mounted
// export directory is. The seam (LocalStorageBackend, @gremion/storage) refuses a root that is not a mount
// point AND a root on a memory-backed filesystem; if the gate accepted what the seam refuses, the module
// database would be blocked and then every removal would fail at construction.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportDirIsMounted, exportDirRefusal } from '../../../../../scripts/tenant-provision-gate'

describe('exportDirIsMounted', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'export-dir-mounted-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  const table = (name: string, body: string) => {
    const p = join(scratch, name)
    writeFileSync(p, body)
    return p
  }
  const EXPORTS = '/var/lib/gremion/exports'

  it('accepts a directory that is its own mount on a durable filesystem', () => {
    const p = table('ext4', `36 1 8:1 / ${EXPORTS} rw - ext4 /dev/sda1 rw\n`)
    expect(exportDirIsMounted(EXPORTS, p)).toBe(true)
    expect(exportDirIsMounted(`${EXPORTS}/`, p)).toBe(true)
  })

  it('refuses a directory on a memory-backed mount (the seam refuses it, so the gate must too)', () => {
    const p = table('tmpfs', `36 1 0:30 / ${EXPORTS} rw - tmpfs tmpfs rw\n`)
    expect(exportDirIsMounted(EXPORTS, p)).toBe(false)
  })

  it('refuses a directory that is not a mount point, and a missing or empty mount table', () => {
    expect(exportDirIsMounted(EXPORTS, table('other', '36 1 8:1 / /srv/other rw - ext4 /dev/sda1 rw\n'))).toBe(false)
    expect(exportDirIsMounted(EXPORTS, join(scratch, 'does-not-exist'))).toBe(false)
    expect(exportDirIsMounted(EXPORTS, table('empty', ''))).toBe(false)
  })

  it('says WHY it refuses: the seam\'s own reason, so a tmpfs export volume is not reported as "not mounted"', () => {
    const tmpfs = table('why-tmpfs', `36 1 0:30 / ${EXPORTS} rw - tmpfs tmpfs rw\n`)
    expect(exportDirRefusal(EXPORTS, { mountinfo: tmpfs })).toMatch(/non-durable filesystem \(tmpfs\)/)
    expect(exportDirRefusal(EXPORTS, { mountinfo: table('why-other', '36 1 8:1 / /srv/other rw - ext4 /dev/sda1 rw\n') })).toMatch(/not a mount point/)
    expect(exportDirRefusal(EXPORTS, { mountinfo: table('why-empty', '') })).toMatch(/lists no mount points/)
    expect(exportDirRefusal(EXPORTS, { mountinfo: join(scratch, 'does-not-exist-either') })).toMatch(/mount table|cannot read/)
    expect(exportDirRefusal('', { mountinfo: tmpfs })).toMatch(/unset/)
    expect(exportDirRefusal(EXPORTS, { mountinfo: table('why-ok', `36 1 8:1 / ${EXPORTS} rw - ext4 /dev/sda1 rw\n`) })).toBeNull()
    expect(exportDirRefusal(EXPORTS, { override: () => true })).toBeNull()
    expect(exportDirRefusal(EXPORTS, { override: () => false })).toMatch(/not a mounted volume/)
  })

  it('reads a mount point with an escaped space the way the seam does', () => {
    const p = table('space', '36 1 8:1 / /srv/with\\040space rw - ext4 /dev/sda1 rw\n')
    expect(exportDirIsMounted('/srv/with space', p)).toBe(true)
  })
})
