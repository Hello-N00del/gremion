// emit.ts — write (or remove) ONE tenant's file under etc/edge.
//
// Ported from B18 emitTenantRouterFile / removeTenantRouterFile with three
// hardenings for an internet-facing edge:
//
//   * the directory must already EXIST (no mkdir -p): a missing etc/edge means
//     the wrong Gremion root, and creating one would publish routers nobody's
//     Traefik reads — or, worse, somewhere else entirely;
//   * the target path is re-derived and re-checked AFTER the slug check: it must
//     sit directly inside the (real) directory and match ROUTER_FILE_RE, so no
//     slug spelling can land a write outside etc/edge;
//   * an existing target that is not a regular file (a planted symlink) is
//     refused, never read through or replaced.
//
// ATOMIC: the document is written to a dot-prefixed, `.tmp`-suffixed sibling
// (`wx`, so a pre-existing name is never followed) and renamed over the target.
// Traefik's directory provider loads only .yml/.yaml/.toml, so the temp file is
// inert while it exists; on ANY failure it is unlinked, so a failed emit leaves
// the previous document (or no document) — never a partial one.
//
// IDEMPOTENT IN EFFECT: Traefik reloads its whole dynamic configuration on any
// event in the watched directory, so an unchanged document is not rewritten at
// all (`unchanged`, mtime untouched).
//
// The app process never calls this: it holds no mount of etc/edge (brief §5,
// hygiene j4). The control plane runs it host-side.

import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { ROUTER_FILE_RE, routerFileName } from './names.js'
import { renderTenantRouter, type RenderTenantRouterInput, type RenderTenantRouterResult } from './render.js'

/** The fs calls emit makes — injectable so a failure mid-write can be simulated. */
export interface EmitIo {
  readonly writeFileSync: (path: string, data: string, options: fs.WriteFileOptions) => void
  readonly renameSync: (from: string, to: string) => void
  readonly unlinkSync: (path: string) => void
}

const REAL_IO: EmitIo = {
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  renameSync: (a, b) => fs.renameSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
}

export type EmitAction = 'written' | 'unchanged' | 'removed' | 'absent'

export interface EmitTenantRouterFileOptions extends RenderTenantRouterInput {
  /** etc/edge under the Gremion root. Must exist. */
  readonly dynamicDir: string
  /** Decide and report the action without touching anything. */
  readonly dryRun?: boolean
  readonly io?: Partial<EmitIo>
}

export interface EmitTenantRouterFileResult extends RenderTenantRouterResult {
  readonly path: string
  readonly action: EmitAction
}

/** The real directory, or a thrown error naming why it is unusable. */
function realDynamicDir(dynamicDir: string): string {
  let st: fs.Stats
  try {
    st = fs.statSync(dynamicDir)
  } catch {
    throw new Error(`edge-routers: dynamic directory ${JSON.stringify(dynamicDir)} does not exist — refusing to create it`)
  }
  if (!st.isDirectory()) throw new Error(`edge-routers: ${JSON.stringify(dynamicDir)} is not a directory`)
  return fs.realpathSync(dynamicDir)
}

/** The target path, proven to sit directly inside `dir` under an owned name. */
export function routerFilePath(slug: string, dynamicDir: string): string {
  const dir = realDynamicDir(dynamicDir)
  const name = routerFileName(slug)
  const path = resolve(dir, name)
  if (dirname(path) !== dir || basename(path) !== name || !ROUTER_FILE_RE.test(name)) {
    throw new Error(`edge-routers: ${JSON.stringify(path)} escapes ${JSON.stringify(dir)} — refusing to write`)
  }
  return path
}

/** 'file' | 'missing', or throws when the name holds anything but a regular file. */
function targetState(path: string): 'file' | 'missing' {
  let st: fs.Stats
  try {
    st = fs.lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  if (!st.isFile()) throw new Error(`edge-routers: ${JSON.stringify(path)} exists but is not a regular file — refusing to touch it`)
  return 'file'
}

/** fsync a regular file by path (a crash must never leave an empty router file).
 * Opened 'r+', not 'r': a read-only handle cannot be flushed on Windows
 * (FlushFileBuffers needs write access), which throws EPERM on every write. */
function fsyncFile(path: string): void {
  const fd = fs.openSync(path, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Best-effort fsync of the containing directory, so the rename survives a
 * crash on filesystems that need it. Windows has no directory-fsync
 * equivalent — FlushFileBuffers on a directory handle fails — so a failure
 * there is tolerated on win32 only; NTFS/ReFS journal the metadata update
 * regardless. Any other platform, or any other error, still throws. */
function fsyncDir(path: string): void {
  const fd = fs.openSync(path, 'r')
  try {
    fs.fsyncSync(fd)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EINVAL')) throw err
  } finally {
    fs.closeSync(fd)
  }
}

function readOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null // unreadable means "differs": never skip a write on an unknown current state
  }
}

export function emitTenantRouterFile(opts: EmitTenantRouterFileOptions): EmitTenantRouterFileResult {
  const rendered = renderTenantRouter(opts)
  const path = routerFilePath(opts.slug, opts.dynamicDir)
  const io: EmitIo = { ...REAL_IO, ...opts.io }
  const present = targetState(path) === 'file'

  if (rendered.yaml === null) {
    // No routable host: a stale Host() router on a released domain would keep
    // serving this tenant to whoever controls that name now.
    if (!present) return { ...rendered, path, action: 'absent' }
    if (!opts.dryRun) io.unlinkSync(path)
    return { ...rendered, path, action: 'removed' }
  }

  // Content AND mode: a same-content file Traefik cannot read (0600 after a
  // manual edit) is not "unchanged", it is broken, and a rewrite repairs it.
  if (present && readOrNull(path) === rendered.yaml && (fs.statSync(path).mode & 0o777) === 0o644) {
    return { ...rendered, path, action: 'unchanged' }
  }
  if (opts.dryRun) return { ...rendered, path, action: 'written' }

  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    io.writeFileSync(tmp, rendered.yaml, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    fs.chmodSync(tmp, 0o644) // the umask must not decide whether Traefik can read it
    fsyncFile(tmp) // the bytes are durable BEFORE the name points at them
    io.renameSync(tmp, path)
    fsyncDir(dirname(path)) // …and so is the rename
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // already gone (or never created) — the original error is the one to report
    }
    throw err
  }
  return { ...rendered, path, action: 'written' }
}

/** Delete a tenant's file (deprovision). Idempotent: false when there was none. */
export function removeTenantRouterFile(slug: string, dynamicDir: string, io: Partial<EmitIo> = {}): boolean {
  const path = routerFilePath(slug, dynamicDir)
  if (targetState(path) === 'missing') return false
  ;({ ...REAL_IO, ...io }).unlinkSync(path)
  return true
}
