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

import { mkdir, writeFile, rename, readFile, unlink, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { StorageBackend, StorageFs } from './types.js'
import { assertMountedRoot, type MountCheck } from './assertMountedRoot.js'
import { assertHandleInTenant, assertKeyInTenant, assertTenantId, composeKey } from './tenant.js'

export const DEFAULT_LOCAL_ROOT = './var/storage'

/** In-flight temp files are `.<name>.<uuid>.partial`; list() never returns them. */
const PARTIAL_RE = /^\..+\.[0-9a-f-]{36}\.partial$/

export const nodeFs: StorageFs = {
  mkdir: (p, o) => mkdir(p, o),
  writeFile: (p, d) => writeFile(p, d),
  rename: (a, b) => rename(a, b),
  readFile: async (p) => {
    const buf = await readFile(p)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  },
  unlink: (p) => unlink(p),
  listFiles: async (p) => {
    const entries = await readdir(p, { recursive: true, withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => relative(p, join(e.parentPath, e.name)))
  },
  readTextSync: (p) => readFileSync(p, 'utf8'),
}

export interface LocalStorageOptions {
  root?: string
  mountinfoPath?: string
  fs?: StorageFs
}

function toBytes(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('storage(local): bytes must be a Uint8Array')
  return bytes
}

export class LocalStorageBackend implements StorageBackend {
  readonly tenantId: string
  readonly root: string
  /** Outcome of the mount-point check (see assertMountedRoot). */
  readonly mountCheck: MountCheck
  private readonly tenantRoot: string
  private readonly fs: StorageFs

  constructor(tenantId: string, options: LocalStorageOptions = {}) {
    // Tenant first: a missing/malformed tenant throws before the mount table
    // (or anything else) is read.
    this.tenantId = assertTenantId(tenantId)
    this.fs = options.fs ?? nodeFs
    this.root = resolve(options.root ?? DEFAULT_LOCAL_ROOT)
    this.mountCheck = assertMountedRoot(this.root, options.mountinfoPath, (p) => this.fs.readTextSync(p))
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
    return this.write(abs, data).then(() => key)
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
    try {
      abs = this.toAbs(assertHandleInTenant('local', this.tenantId, handle))
    } catch (err) {
      return Promise.reject(err)
    }
    return this.fs.readFile(abs)
  }

  delete(handle: string): Promise<void> {
    let abs: string
    try {
      abs = this.toAbs(assertHandleInTenant('local', this.tenantId, handle))
    } catch (err) {
      return Promise.reject(err)
    }
    return this.fs.unlink(abs).catch((err: NodeJS.ErrnoException) => {
      // ENOENT is idempotent — only re-throw other errors.
      if (err?.code !== 'ENOENT') throw err
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
    return this.fs.listFiles(dir).then(
      (files) =>
        files
          .filter((rel) => !PARTIAL_RE.test(basename(rel)))
          .map((rel) => `${keyPrefix}/${rel.split(sep).join('/')}`)
          .sort(),
      (err: NodeJS.ErrnoException) => {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return []
        throw err
      },
    )
  }
}
