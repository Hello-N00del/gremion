// TDD 14 (brief s.5.8, Q11): no role comparison in kernel API code outside the
// PDP. Scope: services/kernel-api/src/** minus src/authz/**. A hit in another
// owner's code stops the unit; there is no exemption list. The scan is watched
// failing on a seeded TS check, a seeded SQL predicate, and zero files.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLES } from '../../src/authz/catalogue.ts'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const KEYS = [...ROLES.map((r) => r.key), ...CAPABILITIES.map((c) => c.key)]
const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const KEY_ALT = KEYS.map(esc).join('|')

const TS_PATTERNS: RegExp[] = [
  /\b(role|roles|roleKey|grantKind)\s*[!=]==?/,
  new RegExp(`\\.includes\\(\\s*['"](?:${KEY_ALT})`),
  new RegExp(`case\\s+['"](?:${KEY_ALT})['"]`),
  new RegExp(`['"](?:${KEY_ALT})['"]\\s+in\\b`),
  /\bhasRole\(/,
]
const SQL_PATTERN = /\b(role_key|capability_key|grant_kind)\s*(=|<>|!=|IN\b)/i

export function scanText(text: string): string[] {
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    if (TS_PATTERNS.some((p) => p.test(code))) hits.push(`${i + 1}: ${line.trim()}`)
    // SQL only inside string or template literals
    if (/['"`]/.test(code) && SQL_PATTERN.test(code)) hits.push(`${i + 1}: ${line.trim()}`)
  })
  return hits
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (relative(SRC, p).replaceAll('\\', '/') === 'authz') continue
      walk(p, out)
    } else if (/\.(ts|mts)$/.test(name)) out.push(p)
  }
  return out
}

describe('no role comparison outside the PDP', () => {
  it('scans at least one file (zero files is a failure, not a pass)', () => {
    expect(walk(SRC).length).toBeGreaterThan(5)
  })
  it('finds nothing in services/kernel-api/src outside src/authz', () => {
    const found = walk(SRC).flatMap((f) => scanText(readFileSync(f, 'utf8')).map((h) => `${relative(SRC, f)}:${h}`))
    expect(found).toEqual([])
  })
  it('is watched failing: a seeded TS check, TS includes, a seeded SQL predicate', () => {
    expect(scanText("if (claims.role === 'council_admin') allow()").length).toBeGreaterThan(0)
    expect(scanText("if (roles.includes('finance')) allow()").length).toBeGreaterThan(0)
    expect(scanText("const q = `SELECT 1 FROM idt.authz_grant WHERE role_key = 'finance'`").length).toBeGreaterThan(0)
    expect(scanText('const x = hasRole(user, a)').length).toBeGreaterThan(0)
  })
  it('does not flag harmless text', () => {
    expect(scanText('const roleLabel = 1\nreturn tenant.status === "active"')).toEqual([])
  })
})
