/**
 * Migration manifest drift test — Task 14 (content leaf service)
 *
 * Asserts that every *.sql file in services/content/migrations/ is
 * represented in manifest.json with the correct SHA-256 hash.  If a
 * migration is edited after it ships this test turns red immediately,
 * matching the kernel-side hash-lock behaviour (G-012).
 *
 * Run:  pnpm --filter content-service test -- deploy-drift
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ── Resolve paths ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'manifest.json')

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('content migrations — manifest drift', () => {
  it('manifest.json exists', () => {
    expect(
      fs.existsSync(MANIFEST_PATH),
      `${MANIFEST_PATH} does not exist — run: pnpm --filter content-service build:manifest`,
    ).toBe(true)
  })

  it('manifest.json contains at least one entry', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    expect(Object.keys(manifest).length).toBeGreaterThan(0)
  })

  it('every *.sql file in migrations/ is listed in manifest.json with the correct sha256', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

    expect(sqlFiles.length, 'expected at least one *.sql migration').toBeGreaterThan(0)

    for (const file of sqlFiles) {
      const fullPath = path.join(MIGRATIONS_DIR, file)
      const buf = fs.readFileSync(fullPath)
      const actual = sha256hex(buf)
      expect(
        manifest[file],
        `${file} is missing from manifest.json — re-run: pnpm --filter content-service build:manifest`,
      ).toBeDefined()
      expect(actual, `${file} sha256 mismatch — file was edited after manifest was generated`).toBe(
        manifest[file],
      )
    }
  })

  it('manifest.json contains no entries for files that no longer exist', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, string>
    const sqlFiles = new Set(
      fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')),
    )

    for (const key of Object.keys(manifest)) {
      expect(
        sqlFiles.has(key),
        `manifest.json references ${key} but the file does not exist in migrations/`,
      ).toBe(true)
    }
  })

  it('001_init.sql is present and covers the content schema', () => {
    const initSql = path.join(MIGRATIONS_DIR, '001_init.sql')
    expect(
      fs.existsSync(initSql),
      '001_init.sql is missing — the squashed content leaf migration has not been authored yet',
    ).toBe(true)

    const sql = fs.readFileSync(initSql, 'utf-8')
    // Verify key structural markers from the squashed DDL.
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS content')
    expect(sql).toContain('content.posts')
    expect(sql).toContain('content.post_media')
    expect(sql).toContain('content.post_channels')
    expect(sql).toContain('content.mailing_lists')
    expect(sql).toContain('content.mailing_list_members')
    expect(sql).toContain('content.post_recipients')
    expect(sql).toContain('content.unsubscribes')
    expect(sql).toContain('content.send_tokens')
    expect(sql).toContain('content.deliveries')
    expect(sql).toContain('content.publications')
    expect(sql).toContain('content.publish_ops')
    // Leaf-local outbox for NATS relay.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS outbox')
  })
})
