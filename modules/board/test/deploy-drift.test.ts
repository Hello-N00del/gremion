// services/board/test/deploy-drift.test.ts
//
// Migration manifest drift test (T1, board leaf). Asserts that
// services/board/migrations/manifest.json stays in sync with the on-disk *.sql
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

describe('board leaf migrations — manifest drift', () => {
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

  it('001_init.sql OMITS both cross-DB FKs (org_units + protocol_action_items)', () => {
    // The leaf owns board/stack/card only; the two governance-kernel FK targets
    // do NOT exist in this database. This pins that the squash dropped them.
    // Strip `--` comment lines first so the header (which NAMES the dropped FKs
    // to document the decision) is not mistaken for live DDL.
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), 'utf-8')
    const ddl = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(ddl).not.toMatch(/REFERENCES\s+org_units/)
    expect(ddl).not.toMatch(/REFERENCES\s+protocol_action_items/)
    // …but the INTRA-leaf FKs are KEPT.
    expect(ddl).toMatch(/REFERENCES\s+board\(id\)/)
    expect(ddl).toMatch(/REFERENCES\s+stack\(id\)/)
  })
})
