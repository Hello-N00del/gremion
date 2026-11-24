// packages/tenant-store/src/dump/safefs.ts
//
// Symlink-safe file access for the dump code (CD stage 1, unit U6g and its must-fix).
//
// Why. The tenant-create one-shot runs as ROOT and writes into the dump directory, which is 0700 and owned by the
// deploy user (uid 1000). That user can create, rename and replace every entry in the directory, so a root process
// that opens, chmods or chowns a path BY NAME can be made to follow a link the deploy user planted: to write a file
// somewhere else, to hand a root-owned file to that user, or to read one. Four rules close that, and the
// dump directory and everything below it is held to them:
//
//   1. Nothing below the dump directory is opened by a name that may be a link: every open the dump code makes
//      carries O_NOFOLLOW, so a link at the LAST component fails (ELOOP) instead of being followed, and O_NONBLOCK,
//      so a FIFO in the place of a file cannot hold the process in open(2). A refused link is DUMP_PATH_UNSAFE,
//      never skipped. A reader outside this file (the exporter's `pg_restore --list`) is handed the descriptor, never
//      the name (Exporter.list, `fd`).
//   2. What was opened is checked on the descriptor, not on the name: fstat says regular file with one link (a
//      hard link to a root-owned file is refused) or directory, owned by a uid the dump code may meet. That holds
//      for an existing ledger too: it is read and appended to only when it belongs to such a uid.
//   3. Ownership and mode are changed on the descriptor (fchown, fchmod), never by path, and only on the very
//      descriptor that created the node (O_EXCL; or a directory made in this call and found empty, fresh and this
//      process's own; or the dump file the exporter wrote, found fresh and this process's own). A node that already
//      stands in the directory is never handed over, whoever owns it.
//   4. A directory the code works in is OPENED ONCE (O_DIRECTORY | O_NOFOLLOW) and every name below it is reached
//      through that descriptor (`/proc/self/fd/<n>/<name>` on Linux), so replacing the directory by a link, or a
//      parent by a link, after the open changes nothing.
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { DumpError } from './errors.js'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0
const O_NONBLOCK = constants.O_NONBLOCK ?? 0
const IS_WINDOWS = process.platform === 'win32'
const PROC_FD = '/proc/self/fd'
/** How far back the mtime of a file this call has just made may lie (coarse file system clocks, a clock step). */
const FRESH_SLACK_MS = 5000

/** The uid of this process, undefined where there is none: the owner of every node it creates. */
export const SELF_UID: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined

export function unsafePath(what: string, why: string, cause?: unknown): DumpError {
  return new DumpError('DUMP_PATH_UNSAFE', `${what} ${why}: the dump code never follows a link or changes anything it did not make; nothing was written or changed`, cause === undefined ? undefined : { cause })
}

/**
 * The uids a node that ALREADY stands in the dump directory may belong to. A root process that writes for a declared
 * owner finds the owner's nodes there (the host made them, or an earlier run handed them over) and never root's: what
 * root made it handed over in the same call. Any other process finds its own. (A test double that claims root on a
 * process that is not root also finds that process's own nodes.)
 */
export function allowedOwners(ownerUid: number | undefined, fsUid: number | undefined): number[] {
  const out = new Set<number>()
  if (ownerUid !== undefined && fsUid === 0) out.add(ownerUid)
  else if (fsUid !== undefined) out.add(fsUid)
  if (SELF_UID !== undefined && SELF_UID !== 0) out.add(SELF_UID)
  return [...out]
}

/**
 * open(2) with O_NOFOLLOW and O_NONBLOCK. A link at the last component is DUMP_PATH_UNSAFE (ELOOP, EMLINK); so is a
 * FIFO with no peer (ENXIO on a write-only open); any other error is the caller's (ENOENT, EEXIST, EACCES ...).
 * O_NONBLOCK makes the open of a FIFO return at once instead of waiting for a peer, and the descriptor check
 * (assertPlain) then refuses it; it changes nothing for a regular file or a directory. Where O_NOFOLLOW does not
 * exist (Windows) the link refusal comes from an lstat first.
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
    return openSync(path, flags | O_NOFOLLOW | O_NONBLOCK, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') throw unsafePath(path, 'is a link', err)
    if (code === 'ENXIO') throw unsafePath(path, 'is not a regular file', err)
    throw err
  }
}

/** fstat of an open descriptor as a plain node: a regular file with ONE link, or a directory; owner checked off Windows. */
export function assertPlain(fd: number, what: string, kind: 'file' | 'dir', owners?: readonly number[]): Stats {
  const st: Stats = fstatSync(fd)
  if (kind === 'file' && (!st.isFile() || st.nlink !== 1)) throw unsafePath(what, 'is not a regular file with a single link')
  if (kind === 'dir' && !st.isDirectory()) throw unsafePath(what, 'is not a directory')
  if (owners !== undefined && !IS_WINDOWS && !owners.includes(st.uid)) throw unsafePath(what, `belongs to uid ${st.uid}, which the dump code does not write for`)
  return st
}

/** True when a stat is of something made after `sinceMs` (less the slack): evidence it is not an older node put in its place. */
export function madeSince(st: { mtimeMs: number }, sinceMs: number): boolean {
  return st.mtimeMs >= sinceMs - FRESH_SLACK_MS
}

/** fchmod on the descriptor; Windows has no usable fchmod on a directory handle and no links to guard against, so it takes the path. */
export function setMode(fd: number, path: string, mode: number): void {
  if (IS_WINDOWS) chmodSync(path, mode)
  else fchmodSync(fd, mode)
}

/**
 * Hands the node behind `fd` to `uid` and sets its mode, on that descriptor. The caller holds the descriptor that
 * created the node (or has just verified it is fresh and its own): the node is never reopened by name. `chown` is a
 * test seam standing in for fchown.
 */
export function handOverFd(fd: number, path: string, uid: number, mode: number, chown?: (path: string, uid: number) => void): void {
  if (chown) chown(path, uid)
  else if (!IS_WINDOWS) fchownSync(fd, uid, -1)
  setMode(fd, path, mode)
}

/**
 * The text of a plain file, null when it does not exist. A link, a FIFO, a directory or a multiply linked file is
 * refused, and so is a file of a uid not in `owners` (when given).
 */
export function readTextNoFollow(path: string, owners?: readonly number[]): string | null {
  let fd: number
  try {
    fd = openNoFollow(path, constants.O_RDONLY)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    assertPlain(fd, path, 'file', owners)
    return readFileSync(fd, 'utf8')
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
  /** Who may own a directory that already stands there: allowedOwners(...). */
  owners: readonly number[]
  /** Called on the descriptor of a directory made in this call, to hand it to the dump owner. */
  handOver?: (path: string, mode: number, fd: number) => void
}

/**
 * The directory `name` below an anchored directory, as an anchor of its own. Never a link, never a directory of
 * another uid. A directory made in this call is checked to be the one mkdir made (this process's own, empty, fresh:
 * not a node that was put in its place) and handed over on its descriptor; one that already stands there is only
 * checked, never handed over.
 */
export function openChildDir(parent: Anchor, name: string, o: ChildDirOptions): Anchor | null {
  const path = join(parent.dir, name)
  const startedMs = Date.now()
  let created = false
  if (o.create) {
    try {
      mkdirSync(path, { mode: 0o700 })
      created = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  const owners = created && SELF_UID !== undefined ? [SELF_UID] : o.owners
  let child: Anchor
  try {
    child = anchorDir(path, (fd) => void assertPlain(fd, path, 'dir', owners))
  } catch (err) {
    if (!o.create && (err as DumpError).code === 'DUMP_DIR_INVALID' && !existsSync(path)) return null
    throw err
  }
  if (created) {
    try {
      if (child.fd >= 0) {
        const st = fstatSync(child.fd)
        if (readdirSync(child.dir).length !== 0 || !madeSince(st, startedMs)) throw unsafePath(path, 'is not the directory that was just made')
        setMode(child.fd, path, 0o700)
      }
      o.handOver?.(path, 0o700, child.fd)
    } catch (err) {
      child.close()
      throw err
    }
  }
  return child
}
