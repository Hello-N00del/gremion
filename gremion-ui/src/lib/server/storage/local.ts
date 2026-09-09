// src/lib/server/storage/local.ts
// Local-disk StorageBackend. Files are written under a root directory
// (env.RECEIPT_STORAGE_DIR, default ./var/storage relative to cwd). The
// returned handle is the absolute filesystem path of the written file.
//
// Path-traversal defence: relPath is normalised and we assert the resolved
// absolute path stays beneath the configured root. Any attempt to escape
// (".." segments, absolute paths, drive letters on Windows) throws before
// any I/O happens.
//
// The local backend is the dev-friendly default — no external services
// required. Production deployments typically switch STORAGE_BACKEND=nextcloud.

import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { StorageBackend } from './types'

const DEFAULT_ROOT = './var/storage'

function resolveRoot(rootOverride: string | undefined): string {
  return resolve(rootOverride ?? DEFAULT_ROOT)
}

/** Reject any path that would escape the root after resolution. */
function safeJoin(root: string, relPath: string): string {
  // Normalise away leading slashes / backslashes so callers can pass
  // "finance/expense/1/foo.pdf" or "/finance/...". We never accept absolute
  // paths or drive letters — only relative segments beneath the root.
  const stripped = relPath.replace(/^[/\\]+/, '')
  if (/^[a-zA-Z]:/.test(stripped)) {
    throw new Error(`storage(local): refusing absolute path: ${relPath}`)
  }
  const candidate = resolve(root, stripped)
  // resolve() collapses ".." segments — verify the result is still under root.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`storage(local): path escapes root: ${relPath}`)
  }
  return candidate
}

export class LocalStorageBackend implements StorageBackend {
  private readonly root: string

  constructor(rootOverride?: string) {
    this.root = resolveRoot(rootOverride)
  }

  async put(relPath: string, bytes: Uint8Array): Promise<string> {
    const abs = safeJoin(this.root, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
    return abs
  }

  async read(handle: string): Promise<Uint8Array> {
    // handle is an absolute path produced by put() — verify it is under root
    // before any I/O so a tampered DB value cannot read arbitrary files.
    const abs = resolve(handle)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`storage(local): handle escapes root: ${handle}`)
    }
    const buf = await readFile(abs)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async delete(handle: string): Promise<void> {
    const abs = resolve(handle)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`storage(local): handle escapes root: ${handle}`)
    }
    try {
      await unlink(abs)
    } catch (err) {
      // ENOENT is idempotent — only re-throw other errors.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
