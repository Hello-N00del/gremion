// Local-disk StorageBackend, bound to ONE tenant. Objects live at
// <root>/<tenantId>/<relPath>; the handle is the tenant-prefixed key
// `<tenantId>/<relPath>`, never an absolute path (so a handle persisted in the
// database carries no deployment root and stays valid across a root move or
// the object-store cutover).
//
// Order of operations in every method: validate synchronously (tenant-scoped
// handle/key checks, then a resolved-path containment check against
// <root>/<tenantId>/), and only then touch the filesystem. A refused call has
// made zero filesystem calls.
//
// Construction refuses a root that is not a mount point (assertMountedRoot).

import { mkdir, writeFile, rename, readFile, unlink, readdir, lstat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { StorageBackend, StorageFs } from './types.js'
import { assertMountedRoot, type MountCheck } from './assertMountedRoot.js'
import { assertHandleInTenant, assertKeyInTenant, assertTenantId, composeKey, PARTIAL_NAME_RE } from './tenant.js'

export const DEFAULT_LOCAL_ROOT = './var/storage'


export const nodeFs: StorageFs = {
  mkdir: (p, o) => mkdir(p, o),
  writeFile: (p, d) => writeFile(p, d),
  rename: (a, b) => rename(a, b),
  readFile: async (p) => {
    const buf = await readFile(p)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  },
  unlink: (p) => unlink(p),
  lstat: (p) => lstat(p),
  listFiles: async (p) => {
    // Own walk instead of readdir({ recursive }), which descends into
    // symlinked directories. Dirent.isDirectory()/isFile() are false for a
    // symlink, so links are neither followed nor returned.
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        // Only the START directory's absence means "nothing listed"; a
        // subdirectory vanishing mid-walk must not collapse into an empty list.
        if (dir !== p) throw Object.assign(new Error(`storage(local): listing changed during walk at ${dir}`), { cause: err })
        throw err
      }
      for (const e of entries) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile()) out.push(relative(p, abs))
      }
    }
    await walk(p)
    return out
  },
  readTextSync: (p) => readFileSync(p, 'utf8'),
}

export interface LocalStorageOptions {
  root?: string
  mountinfoPath?: string
  fs?: StorageFs
  /** Host platform for the mount check; defaults to process.platform (tests). */
  platform?: string
}

const enoent = (key: string): Error =>
  Object.assign(new Error(`storage(local): no object at ${JSON.stringify(key)}`), { code: 'ENOENT' })

function toBytes(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('storage(local): bytes must be a Uint8Array')
  return bytes
}

export class LocalStorageBackend implements StorageBackend {
  readonly tenantId: string
  readonly root: string
  /** The root as configured: the mount check compares it in mount-table
   *  (POSIX) form, independent of the host's native path resolution. */
  private readonly configuredRoot: string
  /** Outcome of the mount-point check (see assertMountedRoot). */
  readonly mountCheck: MountCheck
  private readonly tenantRoot: string
  private readonly fs: StorageFs
  private readonly mountinfoPath: string | undefined
  private readonly platform: string | undefined

  constructor(tenantId: string, options: LocalStorageOptions = {}) {
    // Tenant first: a missing/malformed tenant throws before the mount table
    // (or anything else) is read.
    this.tenantId = assertTenantId(tenantId)
    this.fs = options.fs ?? nodeFs
    this.mountinfoPath = options.mountinfoPath
    this.platform = options.platform
    this.configuredRoot = options.root ?? DEFAULT_LOCAL_ROOT
    this.root = resolve(this.configuredRoot)
    this.mountCheck = assertMountedRoot(this.configuredRoot, options.mountinfoPath, (p) => this.fs.readTextSync(p), options.platform)
    if (!this.mountCheck.checked) {
      console.warn(`storage(local): mount-point check SKIPPED: ${this.mountCheck.reason}`)
    }
    this.tenantRoot = join(this.root, this.tenantId)
  }

  /** Resolve a validated key/handle to an absolute path, re-checking
   *  containment in <root>/<tenantId>/ at the path level. */
  private toAbs(key: string): string {
    const abs = resolve(this.root, key)
    if (!abs.startsWith(this.tenantRoot + sep)) {
      throw new Error(`storage(local): handle escapes tenant root: ${JSON.stringify(key)}`)
    }
    return abs
  }

  /** Refuse a symlink anywhere from <root>/<tenantId> down to `abs`: a link
   *  planted under the tenant root must never carry I/O into another tenant
   *  or out of the root. Stops at the first missing component (put creates
   *  the rest as real directories). Residual: a link swapped in between this
   *  check and the I/O (TOCTOU) is not covered; only this seam writes here. */
  private async assertNoSymlinks(abs: string, key: string): Promise<void> {
    const rel = relative(this.tenantRoot, abs)
    const parts = rel === '' ? [] : rel.split(sep)
    let p = this.tenantRoot
    for (let i = 0; i <= parts.length; i++) {
      if (i > 0) p = join(p, parts[i - 1]!)
      let st: { isSymbolicLink(): boolean }
      try {
        st = await this.fs.lstat(p)
      } catch (err) {
        // missing, or a file where a directory was expected: nothing there
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') return
        throw err
      }
      if (st.isSymbolicLink()) {
        throw new Error(`storage(local): refusing symlink in path: ${JSON.stringify(key)}`)
      }
    }
  }

  private async isDirectory(abs: string): Promise<boolean> {
    try {
      return (await this.fs.lstat(abs)).isDirectory()
    } catch {
      return false
    }
  }

  put(relPath: string, bytes: Uint8Array): Promise<string> {
    let key: string
    let abs: string
    let data: Uint8Array
    try {
      key = composeKey('local', this.tenantId, relPath)
      assertKeyInTenant('local', this.tenantId, key)
      abs = this.toAbs(key)
      data = toBytes(bytes)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.assertNoSymlinks(abs, key)
      .then(() => this.write(abs, data))
      .then(() => key)
  }

  /** Write via a sibling temp file + rename, so a concurrent reader sees the
   *  old object or the new one, never a torn write. */
  private async write(abs: string, data: Uint8Array): Promise<void> {
    await this.fs.mkdir(dirname(abs), { recursive: true })
    const tmp = join(dirname(abs), `.${basename(abs)}.${randomUUID()}.partial`)
    try {
      await this.fs.writeFile(tmp, data)
      await this.fs.rename(tmp, abs)
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => undefined)
      throw err
    }
  }

  read(handle: string): Promise<Uint8Array> {
    let abs: string
    let key: string
    try {
      key = assertHandleInTenant('local', this.tenantId, handle)
      abs = this.toAbs(key)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.assertNoSymlinks(abs, key)
      .then(() => this.fs.readFile(abs))
      .catch((err: NodeJS.ErrnoException) => {
        // A directory is not an object: same answer as the memory backend.
        throw err?.code === 'EISDIR' || err?.code === 'ENOTDIR' ? enoent(key) : err
      })
  }

  delete(handle: string): Promise<void> {
    let abs: string
    let key: string
    try {
      key = assertHandleInTenant('local', this.tenantId, handle)
      abs = this.toAbs(key)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.assertNoSymlinks(abs, key)
      .then(() => this.fs.unlink(abs))
      .catch(async (err: NodeJS.ErrnoException) => {
        // ENOENT is idempotent, and a directory holds no object (EISDIR):
        // both are "nothing to delete". win32 and macOS answer unlink(dir)
        // with EPERM instead of EISDIR, so EPERM counts as "no object" only
        // when lstat confirms a directory; on an object it is a real
        // permission failure and is re-thrown. Re-throw everything else.
        if (err?.code === 'ENOENT' || err?.code === 'EISDIR' || err?.code === 'ENOTDIR') return
        if (err?.code === 'EPERM' && (await this.isDirectory(abs))) return
        throw err
      })
  }

  list(prefix?: string): Promise<string[]> {
    let dir: string
    let keyPrefix: string
    try {
      keyPrefix = prefix === undefined ? this.tenantId : composeKey('local', this.tenantId, prefix)
      dir = keyPrefix === this.tenantId ? this.tenantRoot : this.toAbs(keyPrefix)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.assertNoSymlinks(dir, keyPrefix)
      .then(() => this.fs.listFiles(dir))
      .then(
        (files) =>
          files
            .filter((rel) => !PARTIAL_NAME_RE.test(basename(rel)))
            .map((rel) => `${keyPrefix}/${rel.split(sep).join('/')}`)
            .sort(),
        async (err: NodeJS.ErrnoException) => {
          if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
          // Nothing stored under this prefix yet — unless the storage root
          // itself is gone or no longer mounted (volume detached, directory
          // left behind), which must not read as "empty".
          try {
            await this.fs.lstat(this.root)
          } catch (e) {
            throw new Error(
              `storage(local): storage root ${this.root} is missing (${(e as NodeJS.ErrnoException)?.code ?? String(e)})`,
            )
          }
          assertMountedRoot(this.configuredRoot, this.mountinfoPath, (p) => this.fs.readTextSync(p), this.platform)
          return []
        },
      )
  }
}
