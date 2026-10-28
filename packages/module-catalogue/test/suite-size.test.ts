// TDD 3 (vacuity, the suite itself): the COLLECTED test count (vitest list,
// not a regex over the source) equals the declared count, per file. A test
// deleted to turn a red run green, a describe that stopped collecting, or a
// config that collects nothing fails here although every remaining test
// passes. Raise a count when you add a test; never lower one to pass.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../', import.meta.url))

export const DECLARED: Record<string, number> = {
  'test/catalogue.test.ts': 22,
  'test/cli.test.ts': 6,
  'test/real-tree.test.ts': 7,
  'test/suite-size.test.ts': 3,
  'test/validate.test.ts': 29,
}

function collected(): Record<string, number> {
  const r = spawnSync('pnpm', ['exec', 'vitest', 'list', '--no-staticParse', '--json'], { cwd: PKG, encoding: 'utf8', shell: process.platform === 'win32' })
  expect(r.status, r.stderr).toBe(0)
  const out: Record<string, number> = {}
  for (const t of JSON.parse(r.stdout) as { file: string }[]) {
    const f = t.file.replaceAll('\\', '/').slice(PKG.replaceAll('\\', '/').length)
    out[f] = (out[f] ?? 0) + 1
  }
  return out
}

export function assertDeclared(got: Record<string, number>, declared: Record<string, number>): void {
  const total = Object.values(got).reduce((a, b) => a + b, 0)
  if (total === 0) throw new Error('zero tests collected')
  const files = [...new Set([...Object.keys(got), ...Object.keys(declared)])].sort()
  const off = files.filter((f) => (got[f] ?? 0) !== (declared[f] ?? 0)).map((f) => `${f}: collected ${got[f] ?? 0}, declared ${declared[f] ?? 0}`)
  if (off.length) throw new Error(`collected != declared: ${off.join('; ')}`)
}

describe('suite size (TDD 3)', () => {
  it('the collected count equals the declared count, per file', () => {
    expect(() => assertDeclared(collected(), DECLARED)).not.toThrow()
  }, 120_000)

  it('zero collected is a failure, and so is one test too few or too many', () => {
    expect(() => assertDeclared({}, { 'a.test.ts': 1 })).toThrow(/zero tests collected/)
    expect(() => assertDeclared({ 'a.test.ts': 1 }, { 'a.test.ts': 2 })).toThrow(/a\.test\.ts: collected 1, declared 2/)
    expect(() => assertDeclared({ 'a.test.ts': 3 }, { 'a.test.ts': 2 })).toThrow(/a\.test\.ts: collected 3, declared 2/)
  })

  it('no spec is skipped, todo or focused', () => {
    const specs = readdirSync(join(PKG, 'test')).filter((f) => f.endsWith('.test.ts'))
    expect(specs.length).toBe(Object.keys(DECLARED).length)
    const marked = specs.filter((f) => /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b/.test(readFileSync(join(PKG, 'test', f), 'utf8')))
    expect(marked).toEqual([])
  })
})
