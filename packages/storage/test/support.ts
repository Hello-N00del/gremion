// Shared test support (not a spec). Test roots live under
// <checkout>/.scratch/t117, never os.tmpdir() (TASK-117 §9).
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'

export const SCRATCH = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '.scratch', 't117')
export const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')

export const TENANT_A = '11111111-1111-4111-8111-111111111111'
export const TENANT_B = '22222222-2222-4222-8222-222222222222'

let seq = 0

/** A fresh scratch root plus a synthetic mountinfo file that lists it as a
 *  mount point, so the local backend's mount check passes for the test. */
export async function mountedScratchRoot(label: string): Promise<{ root: string; mountinfoPath: string; cleanup: () => Promise<void> }> {
  const dir = join(SCRATCH, `${label}-${process.pid}-${Date.now()}-${seq++}`)
  const root = join(dir, 'root')
  await mkdir(root, { recursive: true })
  const mountinfoPath = join(dir, 'mountinfo')
  await writeFile(
    mountinfoPath,
    `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n` +
      `98 22 8:1 /t117 ${root.replace(/ /g, '\\040')} rw,relatime shared:2 - ext4 /dev/sda1 rw\n`,
  )
  return { root, mountinfoPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
