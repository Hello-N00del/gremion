#!/usr/bin/env node
/**
 * G-012: SHA-256 manifest builder for Postgres migrations.
 *
 * Scans gremion-ui/migrations/*.sql, computes sha256(hex) of each file's bytes,
 * and writes the result to gremion-ui/migrations/manifest.json with sorted keys
 * for deterministic output. db.ts loads this manifest at boot and refuses to
 * run any migration whose on-disk hash doesn't match.
 *
 * Wired into `pnpm prebuild` so every production build regenerates the
 * manifest against the migrations actually being copied into the image.
 *
 * Usage:
 *   node scripts/build-migration-manifest.mjs
 *
 * Exit codes:
 *   0 — manifest written
 *   1 — failed to read migrations dir or any *.sql file
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Accept a dir-name arg so the same builder produces both the data-plane
// manifest (migrations/) and the control-plane manifest (migrations-control/).
const DIR_NAME = process.argv[2] ?? 'migrations'
const MIGRATIONS_DIR = path.resolve(__dirname, '..', DIR_NAME)
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'manifest.json')

async function main() {
  let entries
  try {
    entries = await readdir(MIGRATIONS_DIR)
  } catch (err) {
    console.error(`[manifest] failed to read ${MIGRATIONS_DIR}: ${err.message}`)
    process.exit(1)
  }

  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort()
  if (sqlFiles.length === 0) {
    console.error(`[manifest] no *.sql files found in ${MIGRATIONS_DIR}`)
    process.exit(1)
  }

  /** @type {Record<string, string>} */
  const manifest = {}
  for (const file of sqlFiles) {
    const full = path.join(MIGRATIONS_DIR, file)
    let buf
    try {
      buf = await readFile(full)
    } catch (err) {
      console.error(`[manifest] failed to read ${full}: ${err.message}`)
      process.exit(1)
    }
    manifest[file] = createHash('sha256').update(buf).digest('hex')
  }

  // Re-build with sorted keys so JSON output is deterministic regardless of
  // readdir ordering on the host.
  /** @type {Record<string, string>} */
  const sorted = {}
  for (const key of Object.keys(manifest).sort()) {
    sorted[key] = manifest[key]
  }

  const json = JSON.stringify(sorted, null, 2) + '\n'
  await writeFile(MANIFEST_PATH, json, 'utf-8')
  console.info(`[manifest] wrote ${MANIFEST_PATH} (${sqlFiles.length} migrations)`)
}

main().catch((err) => {
  console.error(`[manifest] unexpected error: ${err.stack || err.message}`)
  process.exit(1)
})
