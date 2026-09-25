// packages/tenant-store/src/manifest.ts
//
// TRD-353 (kept): <dir>/manifest.json maps every migration filename to the
// sha256 (hex) of its bytes — the format gremion-ui/scripts/build-migration-
// manifest.mjs writes. This module checks the WHOLE set, both directions,
// before the runner executes anything, CREATE TABLE schema_migrations
// included. The kernel runners (gremion-ui db.ts, control-migrations.ts) ran
// the ledger DDL first and checked one file at a time, so a tampered file
// late in the set was found only after earlier files had applied.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ManifestProblemCode =
  | 'MANIFEST_UNREADABLE'
  | 'MANIFEST_MALFORMED'
  | 'NO_MIGRATIONS'
  | 'FILE_NOT_IN_MANIFEST'
  | 'MANIFEST_ENTRY_WITHOUT_FILE'
  | 'HASH_MISMATCH'
  | 'NOT_UTF8'

export interface ManifestProblem {
  code: ManifestProblemCode
  file?: string
  detail?: string
}

export class MigrationManifestError extends Error {
  override name = 'MigrationManifestError'
  constructor(readonly problems: ManifestProblem[]) {
    super(
      `migration manifest check failed, nothing was executed: ` +
        problems.map((p) => `${p.code}${p.file ? ` ${p.file}` : ''}${p.detail ? ` (${p.detail})` : ''}`).join('; '),
    )
  }
}

export interface VerifiedMigration {
  file: string
  /** sha256 hex of the file's bytes, equal to its manifest entry. */
  sha256: string
  text: string
}

/** A plain migration filename: no directory part, no traversal. */
export const MIGRATION_FILENAME = /^[0-9A-Za-z][0-9A-Za-z_.-]*\.sql$/
const SHA256_HEX = /^[0-9a-f]{64}$/

const utf8 = new TextDecoder('utf-8', { fatal: true })

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Parses manifest.json; throws MigrationManifestError on anything but {name: sha256}. */
export function loadManifest(dir: string): Map<string, string> {
  let raw: string
  try {
    raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
  } catch (err) {
    throw new MigrationManifestError([{ code: 'MANIFEST_UNREADABLE', detail: (err as NodeJS.ErrnoException).code ?? 'read failed' }])
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new MigrationManifestError([{ code: 'MANIFEST_MALFORMED', detail: 'not JSON' }])
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MigrationManifestError([{ code: 'MANIFEST_MALFORMED', detail: 'not an object' }])
  }
  const out = new Map<string, string>()
  const problems: ManifestProblem[] = []
  for (const [file, hash] of Object.entries(parsed as Record<string, unknown>)) {
    if (!MIGRATION_FILENAME.test(file)) problems.push({ code: 'MANIFEST_MALFORMED', file, detail: 'not a plain *.sql filename' })
    else if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) problems.push({ code: 'MANIFEST_MALFORMED', file, detail: 'not a sha256 hex digest' })
    else out.set(file, hash)
  }
  if (problems.length) throw new MigrationManifestError(problems)
  return out
}

/**
 * Every *.sql file in `dir`, verified against manifest.json, in filename
 * order. Throws ONE MigrationManifestError listing every problem: a file with
 * no entry, an entry with no file, a hash mismatch, bytes that are not UTF-8,
 * or an empty set. Pure filesystem work: no database is touched.
 */
export function readVerifiedMigrations(dir: string): VerifiedMigration[] {
  const manifest = loadManifest(dir)
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort()
  const problems: ManifestProblem[] = []
  const out: VerifiedMigration[] = []
  for (const file of files) {
    const expected = manifest.get(file)
    if (expected === undefined) {
      problems.push({ code: 'FILE_NOT_IN_MANIFEST', file })
      continue
    }
    const bytes = readFileSync(join(dir, file))
    const actual = sha256Hex(bytes)
    if (actual !== expected) {
      problems.push({ code: 'HASH_MISMATCH', file, detail: `manifest ${expected.slice(0, 8)}…, file ${actual.slice(0, 8)}…` })
      continue
    }
    let text: string
    try {
      text = utf8.decode(bytes)
    } catch {
      problems.push({ code: 'NOT_UTF8', file })
      continue
    }
    out.push({ file, sha256: actual, text })
  }
  const present = new Set(files)
  for (const file of manifest.keys()) {
    if (!present.has(file)) problems.push({ code: 'MANIFEST_ENTRY_WITHOUT_FILE', file })
  }
  if (problems.length === 0 && out.length === 0) problems.push({ code: 'NO_MIGRATIONS' })
  if (problems.length) throw new MigrationManifestError(problems)
  return out
}
