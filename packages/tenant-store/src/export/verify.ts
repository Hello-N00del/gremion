// The completeness check (TRD-151): read manifest.json back FROM DISK and
// prove every file it names is present, readable, non-empty, the recorded
// size and sha256, and that its JSON file parses to the recorded row count.
// Nothing is taken from the writer's memory. Files the manifest does not name
// are reported too.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_FILE = 'manifest.json'
export const MANIFEST_SCHEMA_VERSION = 1

export interface ManifestFile {
  path: string
  scope: string
  /** The table's schema (absent in exports written before HIGH-2: public). */
  schema?: string
  table: string
  format: 'csv' | 'json'
  rows: number
  bytes: number
  sha256: string
}
export interface ExportManifest {
  schema_version: number
  tenant: { slug: string }
  generated_at: string
  files: ManifestFile[]
  modules: { id: string; status: 'exported' | 'excluded'; reason?: string }[]
  excluded_systems: { system: string; reason: string }[]
  excluded_tables: { scope: string; schema?: string; table: string; reason: string }[]
}

export type ProblemCode = 'MANIFEST_MISSING' | 'MANIFEST_INVALID' | 'MISSING' | 'UNREADABLE' | 'EMPTY' | 'SIZE_MISMATCH' | 'SHA_MISMATCH' | 'ROWCOUNT_MISMATCH' | 'UNLISTED'
export interface Problem {
  path: string
  code: ProblemCode
  detail: string
}
export interface VerifyResult {
  ok: boolean
  checked: number
  problems: Problem[]
}

const SAFE_PATH = /^[a-z0-9_]+\/(?:[a-z0-9_-]+\.)?[a-z0-9_-]+\.(csv|json)$/

export function verifyExport(dir: string): VerifyResult {
  const problems: Problem[] = []
  const mpath = join(dir, MANIFEST_FILE)
  let manifest: ExportManifest
  try {
    manifest = JSON.parse(readFileSync(mpath, 'utf8')) as ExportManifest
  } catch (err) {
    const missing = !existsSync(mpath)
    return { ok: false, checked: 0, problems: [{ path: MANIFEST_FILE, code: missing ? 'MANIFEST_MISSING' : 'MANIFEST_INVALID', detail: missing ? 'manifest.json is missing' : `manifest.json is unreadable: ${(err as Error).message}` }] }
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    return { ok: false, checked: 0, problems: [{ path: MANIFEST_FILE, code: 'MANIFEST_INVALID', detail: 'unsupported schema_version or no files list' }] }
  }
  const listed = new Set<string>([MANIFEST_FILE])
  for (const f of manifest.files) {
    listed.add(f.path)
    if (typeof f.path !== 'string' || !SAFE_PATH.test(f.path)) {
      problems.push({ path: String(f.path), code: 'MANIFEST_INVALID', detail: 'path is not <scope>/[<schema>.]<table>.(csv|json)' })
      continue
    }
    const p = join(dir, f.path)
    if (!existsSync(p)) {
      problems.push({ path: f.path, code: 'MISSING', detail: 'listed in the manifest but not on disk' })
      continue
    }
    let buf: Buffer
    try {
      buf = readFileSync(p)
    } catch (err) {
      problems.push({ path: f.path, code: 'UNREADABLE', detail: (err as Error).message })
      continue
    }
    if (buf.length === 0) problems.push({ path: f.path, code: 'EMPTY', detail: `0 bytes (the manifest records ${f.rows} rows; even an empty table has a header or [])` })
    if (buf.length !== f.bytes) problems.push({ path: f.path, code: 'SIZE_MISMATCH', detail: `${buf.length} bytes on disk, ${f.bytes} in the manifest` })
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== f.sha256) problems.push({ path: f.path, code: 'SHA_MISMATCH', detail: `sha256 ${sha} on disk, ${f.sha256} in the manifest` })
    else if (f.format === 'json' && buf.length > 0) {
      try {
        const rows = (JSON.parse(buf.toString('utf8')) as unknown[]).length
        if (rows !== f.rows) problems.push({ path: f.path, code: 'ROWCOUNT_MISMATCH', detail: `${rows} rows in the file, ${f.rows} in the manifest` })
      } catch (err) {
        problems.push({ path: f.path, code: 'UNREADABLE', detail: `not JSON: ${(err as Error).message}` })
      }
    }
  }
  for (const scope of readdirSync(dir)) {
    if (scope === MANIFEST_FILE) continue
    const sp = join(dir, scope)
    if (!statSync(sp).isDirectory()) {
      problems.push({ path: scope, code: 'UNLISTED', detail: 'file not named by the manifest' })
      continue
    }
    for (const name of readdirSync(sp)) if (!listed.has(`${scope}/${name}`)) problems.push({ path: `${scope}/${name}`, code: 'UNLISTED', detail: 'file not named by the manifest' })
  }
  return { ok: problems.length === 0, checked: manifest.files.length, problems }
}
