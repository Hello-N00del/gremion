// The local backend refuses a root that is not a mount point (spec-b §1.3).
//
// WHY A MOUNT-TABLE READ AND NOT A stat(): an empty directory on a container's
// writable layer looks exactly like a mounted volume to stat(). Files written
// there are ephemeral and invisible to every backup arm (which enumerate only
// labelled volumes). The only reliable signal is the kernel's own mount table
// for this process's mount namespace: /proc/self/mountinfo.
//
// WHEN THE TABLE IS ABSENT: /proc/self/mountinfo exists on every Linux kernel
// the pilot runs on (containers included). On Linux a missing table (a
// sandbox without /proc, a wrong mountinfoPath) FAILS CLOSED. Only on a
// non-Linux host (Windows/macOS development) is the check SKIPPED — and the
// skip is returned with its reason (and logged by the backend), never treated
// as a silent pass. Any other read failure (EACCES, EIO, ...) fails closed.
//
// DURABILITY: being a mount point is necessary, not sufficient. The rootfs
// (`/`, the container's overlay) and memory-backed filesystems (tmpfs,
// ramfs, ...) are refused as a storage root: both lose objects.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_MOUNTINFO_PATH = '/proc/self/mountinfo'

export type MountCheck = { readonly checked: true } | { readonly checked: false; readonly reason: string }

/** mountinfo escapes space, tab, newline and backslash as \ooo octal. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

/** Filesystem types that lose their contents on restart. */
const NON_DURABLE_FSTYPES = new Set(['tmpfs', 'ramfs', 'devtmpfs', 'proc', 'sysfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2'])

/** mount point -> fstype, from a mountinfo document. A later line for the
 *  same mount point (a stacked mount) wins, as it does in the kernel. */
export function parseMountTable(text: string): Map<string, string> {
  const table = new Map<string, string>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ')
    // id parent major:minor root mount-point options [optional...] - fstype source super-options
    const dash = fields.indexOf('-')
    if (dash < 6 || fields.length < dash + 2) continue
    table.set(unescapeMountField(fields[4]!), fields[dash + 1]!)
  }
  return table
}

/** Mount points listed in a mountinfo document (field 5 of each line). */
export function parseMountPoints(text: string): Set<string> {
  return new Set(parseMountTable(text).keys())
}

/**
 * Throw `storage(local): <root> is not a mount point` unless `root` (resolved)
 * is listed as a mount point in `mountinfoPath`. Returns `{ checked: false,
 * reason }` ONLY when the mount table does not exist on a non-Linux host.
 */
export function assertMountedRoot(
  root: string,
  mountinfoPath: string = DEFAULT_MOUNTINFO_PATH,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  platform: string = process.platform,
): MountCheck {
  const abs = resolve(root)
  let text: string
  try {
    text = readText(mountinfoPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' && platform === 'linux') {
      throw new Error(
        `storage(local): mount table ${mountinfoPath} does not exist on Linux; refusing to assume ${abs} is mounted`,
      )
    }
    if (code === 'ENOENT') {
      return {
        checked: false,
        reason:
          `${mountinfoPath} does not exist (no Linux mount table: a Windows/macOS dev host), ` +
          `so whether ${abs} is a mount point cannot be determined here`,
      }
    }
    throw new Error(
      `storage(local): cannot read mount table ${mountinfoPath} (${code ?? String(err)}); ` +
        'refusing to assume the root is mounted',
    )
  }
  const table = parseMountTable(text)
  if (table.size === 0) {
    throw new Error(
      `storage(local): mount table ${mountinfoPath} lists no mount points; refusing to assume the root is mounted`,
    )
  }
  if (abs === '/') {
    throw new Error('storage(local): / is the root filesystem, not a storage volume')
  }
  const fstype = table.get(abs)
  if (fstype === undefined) {
    throw new Error(`storage(local): ${abs} is not a mount point`)
  }
  if (NON_DURABLE_FSTYPES.has(fstype)) {
    throw new Error(`storage(local): ${abs} is a non-durable filesystem (${fstype}), not a storage volume`)
  }
  return { checked: true }
}
