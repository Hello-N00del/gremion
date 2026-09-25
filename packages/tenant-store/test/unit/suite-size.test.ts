// TDD 10 — the COLLECTED test count (vitest list, not a regex over the
// source) is at least the named total, per file and in sum. A test deleted to
// turn a red run green, a file whose describe stopped collecting, or a config
// that collects nothing, fails here although every remaining test passes.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../../', import.meta.url))

/** The named tests per file, as of TASK-020. Raise a floor when you add tests; never lower one. */
export const NAMED: Record<'unit' | 'integration', Record<string, number>> = {
  unit: {
    'src/advisory-locks.test.ts': 5,
    'src/names.test.ts': 32,
    'src/store.test.ts': 9,
    'src/manifest.test.ts': 10,
    'src/strip-outer-transaction.test.ts': 11,
    'src/runner.test.ts': 3,
    'src/schema-gate.test.ts': 6,
    'src/index.test.ts': 2,
    'test/unit/check-tenant-db-access.test.ts': 12,
    'test/unit/suite-size.test.ts': 3,
  },
  integration: {
    'test/integration/concurrent.test.ts': 2,
    'test/integration/manifest-before-ddl.test.ts': 6,
    'test/integration/runner.test.ts': 8,
    'test/integration/service.test.ts': 6,
  },
}

function collected(config: string): Record<string, number> {
  const r = spawnSync('pnpm', ['exec', 'vitest', 'list', '--config', config, '--json'], {
    cwd: PKG,
    encoding: 'utf8',
    env: { ...process.env, T020_COLLECT_ONLY: '1' },
  })
  expect(r.status, r.stderr).toBe(0)
  const out: Record<string, number> = {}
  for (const t of JSON.parse(r.stdout) as { file: string }[]) {
    const f = t.file.slice(PKG.length)
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

describe('suite size (TDD 10)', () => {
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
})
