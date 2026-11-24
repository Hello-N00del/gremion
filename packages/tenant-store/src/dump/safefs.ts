// packages/tenant-store/src/dump/safefs.ts
//
// Symlink-safe file access for the dump code (CD stage 1, unit U6g and its must-fix).
//
// Why. The tenant-create one-shot runs as ROOT and writes into the dump directory, which is 0700 and owned by the
// deploy user (uid 1000). That user can create, rename and replace every entry in the directory, so a root process
// that opens, chmods or chowns a path BY NAME can be made to follow a link the deploy user planted: to write a file
// somewhere else, to hand a root-owned file to that user, or to read one. Four rules close that, and every path the
// dump code reaches goes through them:
//
//   1. Nothing is opened by a name that may be a link: every open carries O_NOFOLLOW, so a link at the LAST
//      component fails (ELOOP) instead of being followed. A refused link is DUMP_PATH_UNSAFE, never skipped.
//   2. What was opened is checked on the descriptor, not on the name: fstat says regular file with one link (a
//      hard link to a root-owned file is refused) or directory, owned by a uid the dump code may meet.
//   3. Ownership and mode are changed on the descriptor (fchown, fchmod), never by path, and only for what this
//      process made (root-owned) or the owner already has.
//   4. A directory the code works in is OPENED ONCE (O_DIRECTORY | O_NOFOLLOW) and every name below it is reached
//      through that descriptor (`/proc/self/fd/<n>/<name>` on Linux), so replacing the directory by a link, or a
//      parent by a link, after the open changes nothing. Without /proc (a non-Linux development box) the plain
//      path is used and rule 1 and 2 are all there is.
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DumpError } from './errors.js'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0
const IS_WINDOWS = process.platform === 'win32'
const PROC_FD = '/proc/self/fd'

/** The uid of this process, undefined where there is none. */
const REAL_UID = typeof process.getuid === 'function' ? process.getuid() : undefined

export function unsafePath(what: string, why: string, cause?: unknown): DumpError {
  return new DumpError('DUMP_PATH_UNSAFE', `${what} ${why}: the dump code never follows a link or changes anything it did not make; nothing was written or changed`, cause === undefined ? undefined : { cause })
}

/** The uids a node in the dump directory may belong to: root (what a root process made), the declared owner, this process. */
export function allowedOwners(ownerUid: number | undefined): number[] {
  const out = new Set<number>([0])
  if (ownerUid !== undefined) out.add(ownerUid)
  if (REAL_UID !== undefined) out.add(REAL_UID)
  return [...out]
}

/**
 * open(2) with O_NOFOLLOW. A link at the last component is DUMP_PATH_UNSAFE (ELOOP, EMLINK); any other error is
 * the caller's (ENOENT, EEXIST, EACCES ...). Where O_NOFOLLOW does not exist (Windows) the same refusal comes from
 * an lstat first.
 */
export function openNoFollow(path: string, flags: number, mode?: number): number {
  if (O_NOFOLLOW === 0) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw unsafePath(path, 'is a link')
    } catch (err) {
      if (err instanceof DumpError) throw err
      // a missing path is the open's error below
    }
  }
  try {
    return openSync(path, flags | O_NOFOLLOW, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') throw unsafePath(path, 'is a link', err)
    throw err
  }
}

/** fstat of an open descriptor as a plain node: a regular file with ONE link, or a directory; owner checked off Windows. */
export function assertPlain(fd: number, what: string, kind: 'file' | 'dir', owners?: readonly number[]): ReturnType<typeof fstatSync> {
  const st = fstatSync(fd)
  if (kind === 'file' && (!st.isFile() || st.nlink !== 1)) throw unsafePath(what, 'is not a regular file with a single link')
  if (kind === 'dir' && !st.isDirectory()) throw unsafePath(what, 'is not a directory')
  if (owners !== undefined && !IS_WINDOWS && !owners.includes(st.uid)) throw unsafePath(what, `belongs to uid ${st.uid}, which the dump code does not write for`)
  return st
}

/** fchmod on the descriptor; Windows has no usable fchmod on a directory handle and no links to guard against, so it takes the path. */
export function setMode(fd: number, path: string, mode: number): void {
  if (IS_WINDOWS) chmodSync(path, mode)
  else fchmodSync(fd, mode)
}

/** The text of a plain file, null when it does not exist. A link, a directory or a multiply linked file is refused. */
export function readTextNoFollow(path: string): string | null {
  let fd: number
  try {
    fd = openNoFollow(path, constants.O_RDONLY)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    assertPlain(fd, path, 'file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** The size of a plain file, read from the descriptor. */
export function sizeNoFollow(path: string): number {
  const fd = openNoFollow(path, constants.O_RDONLY)
  try {
    return Number(assertPlain(fd, path, 'file').size)
  } finally {
    closeSync(fd)
  }
}

/**
 * Hands `path` to `uid` and sets its mode, on a descriptor opened with O_NOFOLLOW and only when the node is plain and
 * belongs to root, the owner or this process. `chown` is a test seam standing in for fchown.
 */
export function handOverNoFollow(path: string, uid: number, mode: number, owners: readonly number[], chown?: (path: string, uid: number) => void): void {
  const fd = openNoFollow(path, constants.O_RDONLY)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() && !st.isDirectory()) throw unsafePath(path, 'is not a file or a directory')
    if (st.isFile() && st.nlink !== 1) throw unsafePath(path, 'is a file with more than one link')
    if (!IS_WINDOWS && !owners.includes(st.uid)) throw unsafePath(path, `belongs to uid ${st.uid}, which the dump code does not write for`)
    if (chown) chown(path, uid)
    else if (!IS_WINDOWS) fchownSync(fd, uid, -1)
    setMode(fd, path, mode)
  } finally {
    closeSync(fd)
  }
}

/** Sets the mode of a plain node through a descriptor opened with O_NOFOLLOW. */
export function chmodNoFollow(path: string, mode: number): void {
  const fd = openNoFollow(path, constants.O_RDONLY)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() && !st.isDirectory()) throw unsafePath(path, 'is not a file or a directory')
    if (st.isFile() && st.nlink !== 1) throw unsafePath(path, 'is a file with more than one link')
    setMode(fd, path, mode)
  } finally {
    closeSync(fd)
  }
}

// ── an anchored directory ─────────────────────────────────────────────────────

export interface Anchor {
  /** A path that stays on the opened directory (/proc/self/fd/<n> on Linux), or the plain path where there is no /proc. */
  dir: string
  /** The descriptor behind it (-1 where the directory could not be opened). */
  fd: number
  close(): void
}

function procAnchors(): boolean {
  return process.platform === 'linux' && existsSync(PROC_FD)
}

/**
 * Opens `path` as a directory: not a link at the last component, and the descriptor is the very inode lstat saw (a
 * swap between the two is refused). `verify` runs on the descriptor, so the owner and mode asked of the directory are
 * those of the inode that is used. Close it when done.
 */
export function anchorDir(path: string, verify?: (fd: number) => void): Anchor {
  let before: ReturnType<typeof lstatSync>
  try {
    before = lstatSync(path)
  } catch (err) {
    throw new DumpError('DUMP_DIR_INVALID', `${path} cannot be read: ${(err as Error).message}`, { cause: err })
  }
  if (before.isSymbolicLink()) throw unsafePath(path, 'is a link')
  if (!before.isDirectory()) throw new DumpError('DUMP_DIR_INVALID', `${path} is not a directory`)
  if (IS_WINDOWS) {
    // a directory cannot be opened here; there is no uid, no /proc: the lstat refusal above is all there is
    return { dir: path, fd: -1, close() {} }
  }
  const fd = openNoFollow(path, constants.O_RDONLY | O_DIRECTORY)
  try {
    const st = fstatSync(fd)
    const was = lstatSync(path)
    if (!st.isDirectory() || was.isSymbolicLink() || was.ino !== st.ino || was.dev !== st.dev || before.ino !== st.ino || before.dev !== st.dev) {
      throw unsafePath(path, 'changed while it was opened')
    }
    verify?.(fd)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  return { dir: procAnchors() ? `${PROC_FD}/${fd}` : path, fd, close: () => closeSync(fd) }
}

export interface ChildDirOptions {
  /** Create it (mode 0700) when it does not exist. Without it a missing directory returns null. */
  create: boolean
  /** Who may own it: allowedOwners(...). */
  owners: readonly number[]
  /** Called for a directory this process made (or that root still owns): hands it to the dump owner. */
  handOver?: (path: string, mode: number) => void
}

/**
 * The directory `name` below an anchored directory, as an anchor of its own. Never a link, never a directory of
 * another uid. A directory made now (or one root still owns, left by a run that died before it handed it over) is
 * handed over; an existing one is only checked.
 */
export function openChildDir(parent: Anchor, name: string, o: ChildDirOptions): Anchor | null {
  const path = join(parent.dir, name)
  let created = false
  if (o.create) {
    try {
      mkdirSync(path, { mode: 0o700 })
      created = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  let child: Anchor
  try {
    child = anchorDir(path, (fd) => void assertPlain(fd, path, 'dir', o.owners))
  } catch (err) {
    if (!o.create && (err as DumpError).code === 'DUMP_DIR_INVALID' && !existsSync(path)) return null
    throw err
  }
  try {
    const st = child.fd >= 0 ? fstatSync(child.fd) : undefined
    if (created || (st !== undefined && st.uid === 0)) {
      if (child.fd >= 0) setMode(child.fd, path, 0o700)
      o.handOver?.(path, 0o700)
    }
  } catch (err) {
    child.close()
    throw err
  }
  return child
}
