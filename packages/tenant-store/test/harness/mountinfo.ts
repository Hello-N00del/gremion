// A fake /proc/self/mountinfo that lists a scratch directory as a mount point, so the storage seam's mount
// check passes on any host (the check itself is the seam's own test, packages/storage). The kernel escapes
// space, tab, newline and backslash in a mount point as \ooo octal; so does this, because a checkout or
// tmpdir path with a space must not turn every deletion test red for a reason that is not under test.
import { resolve } from 'node:path'

export function escapeMountPoint(path: string): string {
  return path.replace(/[ \t\n\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)
}

export function mountinfoLine(root: string): string {
  return `36 1 8:1 / ${escapeMountPoint(resolve(root))} rw - ext4 /dev/scratch rw\n`
}
