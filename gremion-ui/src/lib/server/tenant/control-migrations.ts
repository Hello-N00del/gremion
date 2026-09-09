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
  for (const file of files) {
    const rows = await sql`SELECT 1 FROM schema_migrations WHERE filename = ${file}`
    if (rows.length > 0) continue
    const sql_text = readFileSync(join(dir, file), 'utf-8')
    verifyMigrationIntegrity(file, sql_text, manifest)
    await applyMigrationFile(sql, file, sql_text)
    console.info(`[control-migrations] applied ${file}`)
  }
}
