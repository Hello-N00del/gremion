// The local backend refuses a root that is not a mount point (spec-b §1.3).
//
// WHY A MOUNT-TABLE READ AND NOT A stat(): an empty directory on a container's
// writable layer looks exactly like a mounted volume to stat(). Files written
// there are ephemeral and invisible to every backup arm (which enumerate only
// labelled volumes). The only reliable signal is the kernel's own mount table
// for this process's mount namespace: /proc/self/mountinfo.
//
// WHEN THE TABLE IS ABSENT: /proc/self/mountinfo exists on every Linux kernel
// the pilot runs on (containers included). It is ABSENT on a Windows or macOS
// development host. There the check cannot run, so it is SKIPPED — and the
// skip is returned with its reason (and logged by the backend), never treated
// as a silent pass. Any OTHER read failure (EACCES, EIO, ...) fails closed.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_MOUNTINFO_PATH = '/proc/self/mountinfo'

export type MountCheck = { readonly checked: true } | { readonly checked: false; readonly reason: string }

/** mountinfo escapes space, tab, newline and backslash as \ooo octal. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

/** Mount points listed in a mountinfo document (field 5 of each line). */
export function parseMountPoints(text: string): Set<string> {
  const points = new Set<string>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ')
    // id parent major:minor root mount-point options [optional...] - fstype source super-options
    if (fields.length < 10 || !fields.includes('-')) continue
    points.add(unescapeMountField(fields[4]!))
  }
  return points
}

/**
 * Throw `storage(local): <root> is not a mount point` unless `root` (resolved)
 * is listed as a mount point in `mountinfoPath`. Returns `{ checked: false,
 * reason }` ONLY when the mount table does not exist (non-Linux host).
 */
export function assertMountedRoot(
  root: string,
  mountinfoPath: string = DEFAULT_MOUNTINFO_PATH,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): MountCheck {
  const abs = resolve(root)
  let text: string
  try {
    text = readText(mountinfoPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
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
  const points = parseMountPoints(text)
  if (points.size === 0) {
    throw new Error(
      `storage(local): mount table ${mountinfoPath} lists no mount points; refusing to assume the root is mounted`,
    )
  }
  if (!points.has(abs)) {
    throw new Error(`storage(local): ${abs} is not a mount point`)
  }
  return { checked: true }
}
