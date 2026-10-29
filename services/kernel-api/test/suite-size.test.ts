// TDD 16 -- the COLLECTED test count (vitest list, not a regex over the source)
// is at least the named total, per file and in sum. A test deleted to turn a
// red run green, a file whose describe stopped collecting, or a config that
// collects nothing, fails here although every remaining test passes.
// Mirrors packages/tenant-store/test/unit/suite-size.test.ts.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../', import.meta.url))

/** The named tests per file, as of TASK-077 G8. Raise a floor when you add tests; never lower one. */
export const NAMED: Record<'unit' | 'integration', Record<string, number>> = {
  unit: {
    'test/app/bundle-entry.test.ts': 1,
    'test/app/gate-rotation.test.ts': 3,
    'test/app/routes.test.ts': 11,
    'test/app/trd082.test.ts': 5,
    // TASK-080-a: the bodies migrations as shipped
    'test/bodies/migrations.test.ts': 10,
    'test/outbox/catalogue.test.ts': 5,
    'test/conformance/conformance.test.ts': 14,
    'test/migrate/chain.test.ts': 9,
    'test/registry/registry.test.ts': 7,
    'test/tenancy/host.test.ts': 29,
    'test/tenancy/module-callers.test.ts': 12,
    'test/tenancy/target.test.ts': 13,
    'test/tenancy/tokens.test.ts': 15,
    'test/tenancy/token-outage.test.ts': 12,
    // G8 (static half): the audience mapper in the realm template
    'test/keycloak/realm-audience.test.ts': 4,
    'test/suite-size.test.ts': 4,
  },
  integration: {
    'test/app/kernel-api.int.test.ts': 17,
    // TASK-080-a: the migrate hook and the identity domain service on the scratch PG18
    'test/bodies/hooks.int.test.ts': 7,
    'test/bodies/service.int.test.ts': 12,
    // G8 (live half): real Keycloak tokens carry / lack the audience
    'test/keycloak/audience.int.test.ts': 2,
  },
}

function collected(config: string): Record<string, number> {
  const r = spawnSync('pnpm', ['exec', 'vitest', 'list', '--config', config, '--no-staticParse', '--json'], {
    cwd: PKG,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  expect(r.status, r.stderr).toBe(0)
  const out: Record<string, number> = {}
  for (const t of JSON.parse(r.stdout) as { file: string }[]) {
    const f = t.file.split(sep).join('/').slice(PKG.split(sep).join('/').length)
    out[f] = (out[f] ?? 0) + 1
  }
  return out
}

export function assertFloor(got: Record<string, number>, named: Record<string, number>): void {
  const total = Object.values(got).reduce((a, b) => a + b, 0)
  if (total === 0) throw new Error('zero tests collected')
  const short = Object.entries(named).filter(([f, n]) => (got[f] ?? 0) < n).map(([f, n]) => `${f}: ${got[f] ?? 0} < ${n}`)
  if (short.length) throw new Error(`below the named floor: ${short.join('; ')}`)
  const sum = Object.values(named).reduce((a, b) => a + b, 0)
  if (total < sum) throw new Error(`collected ${total} < named total ${sum}`)
}

describe('suite size (TDD 16)', () => {
  it('the unit suite collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.config.ts'), NAMED.unit)).not.toThrow()
  }, 60_000)

  it('the integration suite collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.integration.config.ts'), NAMED.integration)).not.toThrow()
  }, 60_000)

  it('zero collected tests is a failure, and so is one missing test', () => {
    expect(() => assertFloor({}, { 'a.test.ts': 1 })).toThrow(/zero tests collected/)
    expect(() => assertFloor({ 'a.test.ts': 1 }, { 'a.test.ts': 2 })).toThrow(/a\.test\.ts: 1 < 2/)
  })

  it('no spec is skipped, todo or focused, and every spec on disk is named (vitest list collects those too)', () => {
    const specs: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(PKG, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'fixtures') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.test.ts')) specs.push(p)
      }
    }
    walk('src')
    walk('test')
    expect(specs.length).toBeGreaterThanOrEqual(Object.keys(NAMED.unit).length + Object.keys(NAMED.integration).length)
    const named = new Set([...Object.keys(NAMED.unit), ...Object.keys(NAMED.integration)])
    expect(specs.filter((f) => !named.has(f))).toEqual([])
    const marked = specs.filter((f) => /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b/.test(readFileSync(join(PKG, f), 'utf8')))
    expect(marked).toEqual([])
  })
})
