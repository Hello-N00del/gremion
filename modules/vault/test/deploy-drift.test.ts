// services/vault/test/deploy-drift.test.ts
//
// Migration manifest drift test (T1, vault leaf). Asserts that
// services/vault/migrations/manifest.json stays in sync with the on-disk *.sql
// files: every *.sql has a manifest entry, every manifest entry points at an
// existing file, and the sha256(hex) of each file's bytes matches the recorded
// hash. This is the SAME manifest-hash pattern store/index.ts enforces at boot
// (fail-closed on mismatch); this test catches drift at commit time instead of
// at runtime.
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

describe('vault leaf migrations — manifest drift', () => {
  it('manifest.json exists and is valid JSON', () => {
    expect(fs.existsSync(MANIFEST_PATH), `${MANIFEST_PATH} does not exist`).toBe(true)
    expect(() => JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))).not.toThrow()
  })

  it('001_init.sql exists on disk', () => {
    const initPath = path.join(MIGRATIONS_DIR, '001_init.sql')
    expect(fs.existsSync(initPath), `${initPath} does not exist`).toBe(true)
  })

  it('every *.sql file in migrations/ has a manifest entry', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(sqlFiles.length, 'expected at least one migration *.sql file').toBeGreaterThan(0)
    for (const file of sqlFiles) {
      expect(manifest[file], `manifest.json missing entry for ${file}`).toBeDefined()
    }
  })

  it('every manifest entry points at an existing *.sql file', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    for (const file of Object.keys(manifest)) {
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, file)), `manifest names a missing file: ${file}`).toBe(true)
    }
  })

  it('every migration file sha256 matches its recorded manifest hash', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    for (const [file, expected] of Object.entries(manifest)) {
      const actual = sha256hex(fs.readFileSync(path.join(MIGRATIONS_DIR, file)))
      expect(actual, `hash drift for ${file} — run scripts/build-migration-manifest.mjs`).toBe(expected)
    }
  })
})
