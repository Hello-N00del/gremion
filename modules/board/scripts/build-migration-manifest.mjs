#!/usr/bin/env node
/**
 * SHA-256 manifest builder for board leaf migrations.
 *
 * Mirrors gremion-ui/scripts/build-migration-manifest.mjs (the house pattern,
 * G-012). Scans services/board/migrations/*.sql, computes sha256(hex) of each
 * file's bytes, and writes migrations/manifest.json with sorted keys for
 * deterministic output. store/index.ts loads this manifest at boot and refuses
 * to run any migration whose on-disk hash does not match (fail-closed).
 *
 * Wired into the build step (prebuild); also run manually before committing new
 * SQL files.
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
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations')
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
