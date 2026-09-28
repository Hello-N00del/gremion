// services/vault/src/migrations.ts
//
// The vault leaf's manifest-verified migration runner (manifest-hash, G-012
// pattern). Split out of store/index.ts and kept at src/ DEPTH 1 — mirroring the
// sibling leaves (services/board). This matters because esbuild bundles the whole
// leaf into a SINGLE depth-1 file (dist/index.js): a depth-1 source location + one
// '..' resolves MIGRATIONS_DIR to <leaf>/migrations from the source tree AND to
// /app/migrations from the bundle under WORKDIR /app (Dockerfile copies
// migrations → /app/migrations). A depth-2 location (src/store/index.ts, two '..')
// is correct from source but resolves to /migrations from the bundle, which fails
// ENOENT on the first getStore() call.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MANIFEST_FILE = path.join(MIGRATIONS_DIR, 'manifest.json')

let _manifestCache: Record<string, string> | null = null

async function loadManifest(override?: Record<string, string>): Promise<Record<string, string>> {
  if (override !== undefined) return override
  if (_manifestCache !== null) return _manifestCache
  let raw: string
  try {
    raw = await readFile(MANIFEST_FILE, 'utf-8')
  } catch (err) {
    throw new Error(`[vault-store] failed to read migration manifest at ${MANIFEST_FILE}: ${String(err)}`)
  }
  _manifestCache = JSON.parse(raw) as Record<string, string>
  return _manifestCache
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Verify every migration's on-disk SHA-256 against manifest.json BEFORE running
 * any SQL (fail-closed), then apply each *.sql file IN ORDER over a dedicated
 * max:1 connection. DDL uses IF NOT EXISTS guards so re-running is a safe no-op.
 */
export async function runMigrations(pgUrl: string, overrideManifest?: Record<string, string>): Promise<void> {
  const manifest = await loadManifest(overrideManifest)

  let entries: string[]
  try {
    entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    throw new Error(`[vault-store] failed to read migrations dir: ${String(err)}`)
  }

  for (const file of entries) {
    const expected = manifest[file]
    if (expected === undefined) {
      throw new Error(
        `[vault-store] migration file "${file}" has no entry in manifest.json — ` +
          `run scripts/build-migration-manifest.mjs to regenerate the manifest.`,
      )
    }
    const buf = await readFile(path.join(MIGRATIONS_DIR, file))
    const actual = sha256hex(buf)
    if (actual !== expected) {
      throw new Error(
        `[vault-store] manifest hash mismatch for ${file} — manifest says ${expected}, ` +
          `on-disk hash is ${actual}. Migration aborted (fail-closed). ` +
          `If you edited a migration file, run scripts/build-migration-manifest.mjs.`,
      )
    }
  }

  const migrator = postgres(pgUrl, { max: 1, prepare: false })
  try {
    for (const file of entries) {
      const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), 'utf-8')
      await migrator.unsafe(sqlText)
    }
  } finally {
    await migrator.end().catch(() => {})
  }
}

/** TEST-ONLY: clear the manifest cache (called from store's _resetStoreForTests). */
export function _resetMigrationCacheForTests(): void {
  _manifestCache = null
}
