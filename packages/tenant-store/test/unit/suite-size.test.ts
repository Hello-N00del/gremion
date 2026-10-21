// TDD 10 — the COLLECTED test count (vitest list, not a regex over the
// source) is at least the named total, per file and in sum. A test deleted to
// turn a red run green, a file whose describe stopped collecting, or a config
// that collects nothing, fails here although every remaining test passes.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../../', import.meta.url))

/** The named tests per file, as of TASK-020. Raise a floor when you add tests; never lower one. */
export const NAMED: Record<'unit' | 'integration', Record<string, number>> = {
  unit: {
    'src/advisory-locks.test.ts': 5,
    'src/names.test.ts': 40,
    'src/store.test.ts': 18,
    'src/manifest.test.ts': 10,
    'src/strip-outer-transaction.test.ts': 11,
    // F1-FIX-02-K (T5): +3, the body error propagates through finally; TASK-075: +1 releaseRef refusal
    'src/runner.test.ts': 10,
    // TASK-075 G2: +7 state `ahead`; TASK-077 G3: +10 ledger / dirs / cacheTtlMs 0
    'src/schema-gate.test.ts': 25,
    'src/index.test.ts': 2,
    // TASK-075 G1b: +2 (releaseRef refusal, platform baseline phases); r2: +2 (module phases, shipped baseline drift)
    // TASK-044: +2 (the platform files after the baseline, 0007's keys)
    'src/lifecycle/lifecycle.test.ts': 28,
    'src/lifecycle/export.test.ts': 8,
    // TASK-044 TDD 3 (no database) and TDD 5 (the evidence stamp)
    'src/lifecycle/enable-gate/gate.test.ts': 21,
    // TASK-044 TDD 10: no EnableGate implementation outside enable-gate/** and test code
    'src/lifecycle/enable-gate/source-scan.test.ts': 2,
    // TASK-075 G1: phase header / baseline / PHASE_MISSING, the dump module
    'src/phase.test.ts': 7,
    // TASK-077 (C7): +1 a service:/module: chain is refused by the generic CLI
    'src/dump/dump.test.ts': 21,
    'test/unit/check-tenant-db-access.test.ts': 18,
    'test/unit/suite-size.test.ts': 4,
  },
  integration: {
    'test/integration/concurrent.test.ts': 2,
    'test/integration/manifest-before-ddl.test.ts': 6,
    // TASK-075 r2: +2 the in-place upgrade of a pre-TASK-075 ledger
    'test/integration/runner.test.ts': 16,
    'test/integration/pooler.test.ts': 3,
    'test/integration/service.test.ts': 6,
    // TASK-029: boot verification (TRD-353) and the chain hook under the runner
    'test/integration/verify-applied.test.ts': 6,
    // TASK-021 (G3): the lifecycle on the scratch stack's module server.
    // TASK-075 G1b: +1 release_ref/phase, no dump hook on a fresh DB
    'test/integration/lifecycle-enable.test.ts': 8,
    'test/integration/lifecycle-disable.test.ts': 6,
    'test/integration/lifecycle-inspect.test.ts': 7,
    // TASK-075: the dump under the real runner, restore rehearsal, import take, scratch e2e
    'test/integration/dump.test.ts': 7,
    // TASK-077 G3: the ledger option and the union of dirs (TDD 8, 17); C13 the kernel API reader role
    'test/integration/ledger-union.test.ts': 9,
    'test/integration/kernel-api-reader.test.ts': 4,
    // TASK-044: TDD 1, 2, 3, 5, 9 and the A3 re-gate on the scratch stack
    'test/integration/lifecycle-enable-gate.test.ts': 20,
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

  it('no spec is skipped, todo or focused (vitest list collects those too)', () => {
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
    const marked = specs.filter((f) => /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b/.test(readFileSync(join(PKG, f), 'utf8')))
    expect(marked).toEqual([])
  })
})
