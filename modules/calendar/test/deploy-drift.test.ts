/**
 * Migration manifest drift test — Task 12 (calendar leaf, calendar-service
 * extraction).
 *
 * Asserts that services/calendar/migrations/manifest.json stays in sync with
 * the on-disk *.sql files: every *.sql file has a manifest entry, every
 * manifest entry points at an existing file, and the sha256(hex) of each
 * file's bytes matches the recorded hash. This is the same manifest-hash
 * pattern tenant-store.ts enforces at boot (fail-closed on mismatch); this
 * test catches drift at commit time instead of at runtime.
 *
 * Run:  pnpm --filter calendar-service test -- deploy-drift
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations')
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'manifest.json')

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('calendar leaf migrations — manifest drift', () => {
  it('manifest.json exists and is valid JSON', () => {
    expect(fs.existsSync(MANIFEST_PATH), `${MANIFEST_PATH} does not exist`).toBe(true)
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('001_init.sql exists on disk', () => {
    const initPath = path.join(MIGRATIONS_DIR, '001_init.sql')
    expect(fs.existsSync(initPath), `${initPath} does not exist`).toBe(true)
  })

  it('every *.sql file in migrations/ has a manifest entry', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    expect(sqlFiles.length, 'expected at least one migration *.sql file').toBeGreaterThan(0)
    for (const file of sqlFiles) {
      expect(manifest[file], `manifest.json missing entry for ${file}`).toBeDefined()
    }
  })

  it('every manifest entry points at an existing *.sql file', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    for (const file of Object.keys(manifest)) {
      const full = path.join(MIGRATIONS_DIR, file)
      expect(fs.existsSync(full), `manifest.json references missing file ${file}`).toBe(true)
    }
  })

  it('manifest sha256 hashes match the on-disk *.sql bytes (no drift)', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    for (const [file, expected] of Object.entries(manifest)) {
      const buf = fs.readFileSync(path.join(MIGRATIONS_DIR, file))
      const actual = sha256hex(buf)
      expect(actual, `sha256 mismatch for ${file} — run build-migration-manifest.mjs`).toBe(expected)
    }
  })
})
