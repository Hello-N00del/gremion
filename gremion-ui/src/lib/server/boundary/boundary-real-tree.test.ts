// THE invariant: the live tree has zero boundary violations and zero stale
// allowlist entries. This test runs in the normal unit suite, so EVERY
// `pnpm test:unit` (and the periodic scheduled run) re-proves the boundary.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBoundaryLint, type LintInput } from './engine'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..') // …/gremion-ui

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function collect(): LintInput[] {
  const inputs: LintInput[] = []
  for (const top of ['migrations', 'migrations-control', 'src']) {
    const dir = join(gremionUiRoot, top)
    if (!existsSync(dir)) continue // migrations-control may not exist yet (control schema lives in TS at this commit)
    for (const abs of walk(dir)) {
      const rel = relative(gremionUiRoot, abs).split('\\').join('/')
      if (rel.endsWith('.sql') || rel.endsWith('.ts')) {
        inputs.push({ file: rel, content: readFileSync(abs, 'utf8') })
      }
    }
  }
  return inputs
}

describe('boundary-lint on the real tree', () => {
  it('finds zero violations', () => {
    const inputs = collect()
    // Floor lowered post-carve: removing the feature-module migrations + src dirs
    // dropped the scanned .sql/.ts count from ~600 to ~398. 300 keeps the guard
    // non-vacuous (it still walks the whole governance-only tree and reds on any
    // real boundary violation) with headroom, while still catching a path
    // regression that collected almost nothing.
    expect(inputs.length, 'collect() returned suspiciously few files — path regression?').toBeGreaterThan(300)
    const res = runBoundaryLint(inputs)
    expect(res.violations, JSON.stringify(res.violations, null, 2)).toEqual([])
  })
  it('has no stale allowlist entries', () => {
    const res = runBoundaryLint(collect())
    expect(res.unusedAllow, res.unusedAllow.join('; ')).toEqual([])
  })
})
