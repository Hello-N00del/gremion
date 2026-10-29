// R33 residual (TASK-044 item 4). tenant-create runs as root (the image's builder
// stage); gremion-ui, kernel-api and the other readers run as the image's `node`
// user (uid/gid 1000) and mount the tenant secrets directory read-only. A
// root:root 0600 file is unreadable to them on Linux too (EACCES, proven on a
// named volume), so a file under the tenant secrets dir is handed to the reader
// uid:gid, still mode 0600. Files elsewhere (the provisioner credential) keep
// their root ownership.
import { randomBytes } from 'node:crypto'
import { chownSync, closeSync, existsSync, fchownSync, lchownSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'

export function readerIds(env: Record<string, string | undefined>): { uid: number; gid: number } {
  const one = (name: string): number => {
    const v = env[name]
    if (v === undefined || v === '') return 1000
    if (!/^\d+$/.test(v)) throw new Error(`${name} must be a numeric id, got "${v}"`)
    return Number(v)
  }
  return { uid: one('TENANT_SECRETS_UID'), gid: one('TENANT_SECRETS_GID') }
}

export function handToReader(
  hostPath: string,
  secretsDir: string,
  deps: { chown?: (path: string, uid: number, gid: number) => void; env?: Record<string, string | undefined> } = {}
): void {
  const rel = relative(resolve(secretsDir), resolve(hostPath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
  const { uid, gid } = readerIds(deps.env ?? process.env)
  try {
    ;(deps.chown ?? chownSync)(hostPath, uid, gid)
  } catch (err) {
    // Fatal: a file left root:root 0600 under the secrets dir is unreadable to
    // every reader container (EACCES at runtime, long after the create "passed").
    throw new Error(`chown ${uid}:${gid} ${hostPath} failed (${err instanceof Error ? err.message : String(err)}); the reader container would get EACCES`)
  }
}

type ReaderDeps = {
  /** chown of the open tmp file (by descriptor: never follows a planted symlink). */
  fchown?: (fd: number, uid: number, gid: number) => void
  /** chown of the slug dir and of an existing config (never follows a symlink). */
  lchown?: (path: string, uid: number, gid: number) => void
  env?: Record<string, string | undefined>
  /** The tmp name suffix; random by default. */
  suffix?: string
}

// #49: the tenant's config.json and its per-slug directory under the data root.
// tenant-create (root) made both root:root, the file 0640, and gremion-ui (uid
// 1000) got EACCES on config.json: an incomplete brand identity, a failed
// readiness, and a new customer answering 503. Both go to the reader uid:gid
// (TENANT_SECRETS_UID/GID, the secrets' reader contract), mode stays 0640.
//
// The slug dir belongs to the reader afterwards (gremion-ui writes its own
// tmp+rename there), so root never writes a predictable name into it: the tmp is
// created exclusively (O_EXCL, random suffix) and handed over by descriptor, and
// the dir and an existing file are chowned without following symlinks.
function dataRootOf(env: Record<string, string | undefined>): string {
  return resolve((env.TENANT_DATA_ROOT ?? '/data').replace(/\/+$/, '') || '/')
}

function slugDirOf(path: string, env: Record<string, string | undefined>): string {
  const dir = dirname(resolve(path))
  const rel = relative(dataRootOf(env), dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw new Error(`refusing to hand ${dir} to the config reader: not a direct child of the data root ${dataRootOf(env)}`)
  }
  return dir
}

function fail(uid: number, gid: number, p: string, err: unknown): never {
  throw new Error(`chown ${uid}:${gid} ${p} failed (${err instanceof Error ? err.message : String(err)}); gremion-ui would get EACCES on the tenant config`)
}

export function writeReaderConfigFile(path: string, text: string, deps: ReaderDeps = {}): void {
  const env = deps.env ?? process.env
  const { uid, gid } = readerIds(env)
  const dir = slugDirOf(path, env)
  mkdirSync(dir, { recursive: true })
  try {
    ;(deps.lchown ?? lchownSync)(dir, uid, gid)
  } catch (err) {
    fail(uid, gid, dir, err)
  }
  const tmp = `${path}.tmp-${deps.suffix ?? randomBytes(8).toString('hex')}`
  const fd = openSync(tmp, 'wx', 0o640)
  let ok = false
  try {
    writeFileSync(fd, text)
    try {
      ;(deps.fchown ?? fchownSync)(fd, uid, gid)
    } catch (err) {
      fail(uid, gid, tmp, err)
    }
    ok = true
  } finally {
    closeSync(fd)
    if (!ok) rmSync(tmp, { force: true })
  }
  renameSync(tmp, path)
}

/** An existing tenant config (written before #49) handed to the reader; a missing one is left alone. */
export function handConfigToReader(path: string, deps: ReaderDeps = {}): boolean {
  if (!existsSync(path)) return false
  const env = deps.env ?? process.env
  const { uid, gid } = readerIds(env)
  for (const p of [slugDirOf(path, env), path]) {
    try {
      ;(deps.lchown ?? lchownSync)(p, uid, gid)
    } catch (err) {
      fail(uid, gid, p, err)
    }
  }
  return true
}
