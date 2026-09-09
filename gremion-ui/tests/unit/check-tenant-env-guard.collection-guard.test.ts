import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression guard for #266: check-tenant-env-guard.test.ts imports the .mjs
// directly, and Vitest's inline transform of a .mjs import does NOT strip a
// hashbang under Node 26 / Vitest 3.2.4 — a leading `#!` (or BOM / NUL-byte
// corruption) makes that test file fail COLLECTION with an opaque
// `SyntaxError: Invalid or unexpected token`, so its own assertions never run.
// This guard lives in a SEPARATE file (no .mjs import) so it still executes
// and names the root cause when the importing test file cannot collect.
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-tenant-env-guard.mjs'
)

describe('check-tenant-env-guard.mjs — import-safety guard (#266)', () => {
  const bytes = readFileSync(SCRIPT)

  it('has no hashbang line (breaks the vitest inline transform of the .mjs import)', () => {
    expect(bytes.subarray(0, 2).toString('utf-8')).not.toBe('#!')
  })

  it('has no BOM and no NUL bytes (encoding corruption also breaks collection)', () => {
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf])
    expect(bytes[0] === 0xff || bytes[0] === 0xfe).toBe(false)
    expect(bytes.includes(0)).toBe(false)
  })
})
