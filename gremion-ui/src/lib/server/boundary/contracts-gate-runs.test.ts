// THE invariant: the enforcing contracts gate can actually RUN.
//
// `boundary-lint --contracts` is documented in contracts/README.md as the
// enforcing pass, but nothing in the suite executed it — so when the carve
// removed contracts/kernel/openapi.finance.json with the finance module, the
// mode's hardcoded document list kept naming it and every invocation died on an
// unhandled ENOENT before validating anything. A gate nobody runs is a gate
// nobody notices is broken, which is why this asserts the post-condition (exit
// code and the OK line) by running the real CLI rather than re-checking config.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..') // …/gremion-ui
const repoRoot = join(gremionUiRoot, '..')

function runGate(mode: string) {
  return spawnSync('node', ['--import', 'tsx', join(gremionUiRoot, 'scripts/boundary-lint.ts'), mode], {
    cwd: gremionUiRoot,
    encoding: 'utf8',
  })
}

describe('boundary-lint --contracts', () => {
  it('has documents to validate (vacuity)', () => {
    const docs = readdirSync(join(repoRoot, 'contracts', 'kernel')).filter(
      (f) => f.startsWith('openapi.') && f.endsWith('.json'),
    )
    expect(docs.length, 'contracts/kernel has no OpenAPI document — the gate below would be vacuous').toBeGreaterThan(0)
  })

  it('runs to completion and passes on the live tree', () => {
    const res = runGate('--contracts')
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    expect(res.status, `gate did not exit 0:\n${out}`).toBe(0)
    // The OK line carries the counts, so a gate that validated nothing cannot
    // masquerade as a pass here either.
    expect(out).toMatch(/\[contracts\] OK \((\d+) routes · (\d+) docs validated\)/)
    const [, routes, docs] = out.match(/\[contracts\] OK \((\d+) routes · (\d+) docs validated\)/)!
    expect(Number(routes), 'zero routes scanned').toBeGreaterThan(0)
    expect(Number(docs), 'zero documents validated').toBeGreaterThan(0)
  }, 60_000)
})
