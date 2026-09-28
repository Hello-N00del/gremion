// scripts/migrations/runner/suite.mjs -- TASK-075: the `expand-contract`
// verify suite (TRD-361, TASK-045 shape). Required: scripts/verify/
// required-suites.txt names it and scripts/verify/verify.mjs registers it.
//
// One run checks, and counts as collected:
//   1. chain-runners.json covers scripts/migrations/ranges.json exactly, every
//      chain with a known class (tenant-store | legacy-boot | unadopted);
//   2. expand-contract-baseline.json is the one written at the merge: its
//      digest equals BASELINE_DIGEST, every entry is a locked file (applied.
//      lock.json) whose bytes still hash to the lock (LOCKED_FILE_CHANGED);
//   3. every canary (fixtures/canaries.json) still fails with its rule, or
//      still passes -- so a run that lints no real file still collects > 0
//      and a lint that stopped refusing is caught;
//   4. every file of every chain's dirs[] that the baseline does not map is
//      linted by its declared phase (lint.mjs), contract files also against
//      git (checkContract), and a new file in an unadopted chain must carry
//      -- gremion:manual-dump <runbook step>.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainFileNames } from '../pre-apply.mjs'
import { BASELINE_FILE, baselineDigest, fileDir } from './baseline.mjs'
import { checkContract, createdRoutineNames, formatProblem, lintSql, RULES } from './lint.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The digest of the baseline written at the TASK-075 merge. Never edited. */
export const BASELINE_DIGEST = '3f2bd952230928b410796c0a948371c6b23e27ee75efdbcab2b363d97a3bf014'

export const CLASSES = ['tenant-store', 'legacy-boot', 'unadopted']

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

export function loadCanaries(path = join(import.meta.dirname, 'fixtures', 'canaries.json')) {
  const c = readJson(path).canaries
  if (!Array.isArray(c) || c.length === 0) throw new Error(`${path}: no canaries`)
  return c
}

/**
 * Lints one file: its statements (lintSql) and, for a contract, the git rule.
 * Returns the problems, each {statement, rule, message}.
 */
export function lintFile({ root, relPath, text, priorRoutines, chainClass, excludeDirs }) {
  const r = lintSql(text, { priorRoutines })
  const problems = [...r.problems]
  if (r.phase === 'contract') {
    for (const p of checkContract({ cwd: root, file: relPath, contractAfter: r.contractAfter, dropped: r.dropped, excludeDirs })) problems.push({ statement: 0, ...p })
  }
  if (chainClass === 'unadopted' && r.manualDump === null) {
    problems.push({ statement: 0, rule: RULES.manualDumpMissing, message: 'no runner in this repo dumps this chain yet: name the runbook step that takes the pre-migration dump (-- gremion:manual-dump <step>)' })
  }
  return problems
}

/** Runs one canary; returns null when it behaves, else what went wrong. */
export function runCanary(c) {
  const r = lintSql(c.sql)
  const got = r.problems.map((p) => p.rule)
  if (r.phase === 'contract') got.push(...checkContract({ cwd: REPO_ROOT, file: `canary/${c.name}.sql`, contractAfter: r.contractAfter, dropped: r.dropped }).map((p) => p.rule))
  if (c.expect === null) return got.length === 0 ? null : `canary ${c.name} should pass but fails with ${got.join(', ')}`
  return got.includes(c.expect) ? null : `canary ${c.name} stopped failing with ${c.expect} (got ${got.length ? got.join(', ') : 'no problem at all'})`
}

export function runExpandContractSuite({ root = REPO_ROOT, canaries, pinnedDigest = BASELINE_DIGEST } = {}) {
  const base = { toolMissing: null, skipped: 0 }
  let register
  let lock
  let runners
  let baseline
  try {
    register = readJson(join(root, 'scripts', 'migrations', 'ranges.json'))
    lock = readJson(join(root, 'scripts', 'migrations', 'applied.lock.json'))
    runners = readJson(join(root, 'scripts', 'migrations', 'runner', 'chain-runners.json'))
    baseline = readJson(join(root, 'scripts', 'migrations', 'runner', BASELINE_FILE))
    canaries ??= loadCanaries()
    if (!Array.isArray(register.chains) || !register.chains.length) throw new Error('ranges.json declares no chain')
    if (!baseline || typeof baseline.chains !== 'object' || baseline.chains === null) throw new Error(`${BASELINE_FILE} has no chains map`)
    if (!runners || typeof runners.chains !== 'object' || runners.chains === null) throw new Error('chain-runners.json has no chains map')
  } catch (err) {
    return { ...base, unparseable: true, collected: 0, passed: 0, failed: 0, detail: `expand-contract: cannot read its inputs: ${err.message}` }
  }

  let collected = 0
  let failed = 0
  const details = []
  const check = (label, problems) => {
    collected++
    if (problems.length) {
      failed++
      details.push(...problems.map((p) => `${label}: ${p}`))
    }
  }

  // 1. chain-runners.json covers ranges.json exactly
  const ids = register.chains.map((c) => c.id)
  const coverage = []
  for (const id of ids) if (!(id in runners.chains)) coverage.push(`chain ${id} has no runner class (gap)`)
  for (const [id, cls] of Object.entries(runners.chains)) {
    if (!ids.includes(id)) coverage.push(`chain ${id} is not in ranges.json (extra)`)
    if (!CLASSES.includes(cls)) coverage.push(`chain ${id} has unknown class ${JSON.stringify(cls)}`)
  }
  check('chain-runners.json', coverage)

  // 2. the baseline is the one written once, and every entry still locked
  const bproblems = []
  const digest = baselineDigest(baseline)
  if (digest !== pinnedDigest) bproblems.push(`digest ${digest} is not the pinned ${pinnedDigest}: the baseline is written once and never edited`)
  for (const [chainId, files] of Object.entries(baseline.chains)) {
    const chain = register.chains.find((c) => c.id === chainId)
    if (!chain) {
      bproblems.push(`chain ${chainId} is not in ranges.json`)
      continue
    }
    for (const [file, phase] of Object.entries(files)) {
      if (!['expand', 'migrate', 'contract'].includes(phase)) bproblems.push(`${chainId}/${file}: phase ${JSON.stringify(phase)}`)
      const pinned = lock.chains?.[chainId]?.files?.[file]
      if (pinned === undefined) {
        bproblems.push(`${chainId}/${file}: not in applied.lock.json`)
        continue
      }
      const dir = fileDir(root, chain, file)
      if (dir === null) {
        bproblems.push(`${chainId}/${file}: in the baseline but not on disk`)
        continue
      }
      const sha = createHash('sha256').update(readFileSync(join(root, dir, file))).digest('hex')
      if (sha !== pinned) bproblems.push(`LOCKED_FILE_CHANGED ${dir}/${file}: its bytes no longer hash to the lock; a locked file is never re-hashed (not even to add a header)`)
    }
  }
  check(BASELINE_FILE, bproblems)

  // 3. canaries
  for (const c of canaries) {
    const bad = runCanary(c)
    check(`canary ${c.name}`, bad ? [bad] : [])
  }

  // 4. every file the baseline does not map
  const excludeDirs = register.chains.flatMap((c) => c.dirs)
  let linted = 0
  for (const chain of register.chains) {
    const mapped = baseline.chains[chain.id] ?? {}
    const prior = new Set()
    for (const file of chainFileNames(chain.id, { root, register })) {
      const dir = fileDir(root, chain, file)
      const relPath = `${dir}/${file}`
      const text = readFileSync(join(root, dir, file), 'utf8')
      if (!(file in mapped)) {
        linted++
        const problems = lintFile({ root, relPath, text, priorRoutines: prior, chainClass: runners.chains[chain.id], excludeDirs })
        check(relPath, problems.map((p) => formatProblem(relPath, p).slice(relPath.length + 2)))
      }
      for (const n of createdRoutineNames(text)) prior.add(n)
    }
  }
  details.unshift(`linted ${linted} file(s) outside the baseline, ${canaries.length} canary(ies)`)
  return { ...base, unparseable: false, collected, passed: collected - failed, failed, detail: details.join('\n') }
}
