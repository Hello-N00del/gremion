// src/lib/server/tenant/control-migrations.ts
// P2.1a — control-plane migration runner. Targets the dedicated control pool +
// migrations-control/ set. REUSES loadMigrationManifest, verifyMigrationIntegrity
// (G-012), and applyMigrationFile (G-078 atomic) from db.ts. The loop below is
// db.ts's runMigrations() minus the GREMION_DISABLE_SEEDS seed branch (the control
// set has NO seeds).
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { getControlDb } from './control-db'
import { loadMigrationManifest, verifyMigrationIntegrity, applyMigrationFile } from '../db'

export async function runControlMigrations(): Promise<void> {
  const sql = getControlDb()
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  const dir = join(process.cwd(), 'migrations-control')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const manifest = loadMigrationManifest(dir)
  // F1-FIX-02-K (K1#7, K1#37): verify EVERY file -- applied ones included --
  // against the manifest before the applied-skip below and before any file
  // runs, as db.ts runMigrations does since TASK-029 G5. Verifying only the
  // file about to be applied let a file swapped after it was applied boot
  // clean, and let a pending file run behind a tampered applied one.
  const texts = new Map<string, string>()
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf-8')
    verifyMigrationIntegrity(file, text, manifest)
    texts.set(file, text)
  }
  const appliedRows = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`
  const applied = new Set(appliedRows.map((r) => r.filename))
  for (const file of files) {
    if (applied.has(file)) continue
    // every file was verified above, before any sql.unsafe()
    await applyMigrationFile(sql, file, texts.get(file) as string)
    console.info(`[control-migrations] applied ${file}`)
  }
}
