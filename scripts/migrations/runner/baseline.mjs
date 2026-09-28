#!/usr/bin/env node
// scripts/migrations/runner/baseline.mjs -- TASK-075.
//
// expand-contract-baseline.json maps every migration file that was already
// locked (scripts/migrations/applied.lock.json) when the expand/contract rule
// arrived to its phase, so no locked file is ever re-hashed to gain a header.
// It is WRITTEN ONCE (`node scripts/migrations/runner/baseline.mjs --write`,
// at the TASK-075 merge) and never edited afterwards: suite.mjs pins its
// digest (BASELINE_DIGEST) the way TASK-029 pins legacyFloor, and a file
// added after it must carry its own `-- gremion:phase` header.
//
// The phase of a legacy file is classified by the lint itself: expand if the
// body passes the expand allow-list, else migrate if it passes as migrate,
// else contract (whose contract_after is BASELINE_CONTRACT_AFTER: every
// baseline file predates every release). Header, lock_timeout and tenant
// context are waived for them (they predate all three).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainFileNames } from '../pre-apply.mjs'
import { createdRoutineNames, lintSql } from './lint.mjs'

export const BASELINE_FILE = 'expand-contract-baseline.json'

/** Canonical digest of the baseline's chains map (sorted keys, no whitespace). */
export function baselineDigest(baseline) {
  const chains = baseline?.chains ?? {}
  const canon = Object.keys(chains)
    .sort()
    .map((c) => [c, Object.keys(chains[c]).sort().map((f) => [f, chains[c][f]])])
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

/** The directory of `file` within the chain's dirs[] under root, or null. */
export function fileDir(root, chain, file) {
  for (const d of chain.dirs) {
    try {
      readFileSync(join(root, d, file))
      return d
    } catch {
      /* not in this dir */
    }
  }
  return null
}

export function classify(text, priorRoutines) {
  for (const phase of ['expand', 'migrate']) {
    if (lintSql(text, { classifyAs: phase, priorRoutines }).problems.length === 0) return phase
  }
  return 'contract'
}

/** Builds the baseline from the lock: every locked file of every chain. */
export function buildBaseline(root) {
  const register = JSON.parse(readFileSync(join(root, 'scripts', 'migrations', 'ranges.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'scripts', 'migrations', 'applied.lock.json'), 'utf8'))
  const chains = {}
  for (const chain of register.chains) {
    const locked = lock.chains?.[chain.id]?.files ?? {}
    if (Object.keys(locked).length === 0) continue
    const prior = new Set()
    const out = {}
    for (const file of chainFileNames(chain.id, { root, register })) {
      const dir = fileDir(root, chain, file)
      const text = readFileSync(join(root, dir, file), 'utf8')
      if (locked[file] !== undefined) out[file] = classify(text, prior)
      for (const n of createdRoutineNames(text)) prior.add(n)
    }
    const missing = Object.keys(locked).filter((f) => !(f in out))
    if (missing.length) throw new Error(`chain ${chain.id}: locked but not on disk: ${missing.join(', ')}`)
    chains[chain.id] = out
  }
  return {
    $comment:
      'TASK-075 (TRD-361): the phase of every migration locked before the -- gremion:phase header existed. Written ONCE by baseline.mjs --write; never edited (suite.mjs pins its digest). Files added later carry their own header.',
    writtenAt: new Date().toISOString().slice(0, 10),
    chains,
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1] && process.argv.includes('--write')) {
  const root = join(import.meta.dirname, '..', '..', '..')
  const b = buildBaseline(root)
  writeFileSync(join(import.meta.dirname, BASELINE_FILE), `${JSON.stringify(b, null, 2)}\n`)
  console.log(`wrote ${BASELINE_FILE}: digest ${baselineDigest(b)}`)
}
