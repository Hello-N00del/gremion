// packages/generated-clients/tools/contracts-check-core.mjs
//
// T9: the whole pipeline as one importable function, so both the CLI
// (contracts-check.mjs) and its own test (src/contracts-check.test.ts) call
// the SAME code — the pipeline the brief's acceptance demo and Q2 default
// (`pnpm --filter @gremion/generated-clients contracts:check`) both mean.
//
// Base ref (brief §5 "Base ref"): CONTRACTS_BASE_REF overrides; otherwise the
// merge-base with the target branch; an UNRESOLVED ref fails closed (it is
// recorded as a problem, not silently skipped) — the compat step below then
// treats every registered spec as "new since base" only when a ref WAS
// resolved and genuinely finds no base copy, never as a fallback for "the
// tool gave up".
//
// Imports from `../dist/*.js`, NOT `../src/*.ts`, and callers (both
// contracts-check.mjs and contracts-check.test.ts) build first. Reason:
// asyncapi-compat.ts/codegen-drift.ts import their OWN siblings with a
// `.js`-suffixed specifier (the convention `tsconfig.build.json`'s
// `nodenext` resolution requires) — correct once tsc has emitted a REAL
// sibling `.js` file into dist/, but plain `node` run straight against
// `src/*.ts` cannot follow that specifier to a `.ts` file with a different
// extension (verified empirically: `node` throws ERR_MODULE_NOT_FOUND
// resolving `./oasdiff-gate.js` from `src/asyncapi-compat.ts` with no
// build step first). vitest's own resolver papers over this for the
// UNIT tests (registry.test.ts etc., which import `../src/*.ts` fine) —
// this script has no such resolver, so it needs the real files.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRegistry } from '../dist/registry.js'
import { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } from '../dist/schema.js'
import { checkOpenApiCompat } from '../dist/oasdiff-gate.js'
import { checkAsyncApiCompat } from '../dist/asyncapi-compat.js'
import { checkCodegenDrift } from '../dist/codegen-drift.js'

const BASE_REF_CANDIDATES = ['release-1/local-integration', 'origin/release-1/local-integration', 'main', 'origin/main']

export function resolveBaseRef(repoRoot, env = process.env) {
  if (env.CONTRACTS_BASE_REF) return env.CONTRACTS_BASE_REF
  for (const branch of BASE_REF_CANDIDATES) {
    try {
      const ref = execFileSync('git', ['merge-base', 'HEAD', branch], { cwd: repoRoot, encoding: 'utf8' }).trim()
      if (ref) return ref
    } catch {
      // this candidate branch does not exist locally — try the next one
    }
  }
  return null
}

/** True only when `ref` resolves to a real commit. Callers must check this
 *  BEFORE trusting a `null` from `readAtRef` as "new since base" — an
 *  unresolvable ref (e.g. a typo'd `CONTRACTS_BASE_REF` override, which
 *  `resolveBaseRef` passes through verbatim without validating) makes every
 *  `git show <ref>:<file>` fail the SAME way a genuinely-new file does, and
 *  conflating the two silently skips every compat check instead of failing
 *  closed (round-1 verifier HIGH finding). */
function isResolvableCommit(repoRoot, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot, encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function readAtRef(repoRoot, ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8' })
  } catch {
    return null // file is new since base — ref is guaranteed valid by the isResolvableCommit gate in runContractsCheck
  }
}

/**
 * @param {string} repoRoot
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, problems: string[], entryCount: number, compatChecked: number, baseRef: string|null }}
 */
export function runContractsCheck(repoRoot, opts = {}) {
  const env = opts.env ?? process.env
  const problems = []

  const { problems: regProblems, entries } = validateRegistry(repoRoot)
  problems.push(...regProblems)

  for (const entry of entries) {
    let doc
    try {
      doc = JSON.parse(readFileSync(join(repoRoot, entry.file), 'utf8'))
    } catch (e) {
      problems.push(`${entry.file}: could not read/parse: ${e.message}`)
      continue
    }
    const structProblems = entry.type === 'openapi' ? validateOpenApiDoc(doc) : validateAsyncApiDoc(doc)
    problems.push(...structProblems.map((p) => `${entry.file}: ${p}`))
    const unresolved = collectUnresolvedRefs(doc)
    problems.push(...unresolved.map((r) => `${entry.file}: unresolved $ref ${r}`))
  }

  const baseRef = resolveBaseRef(repoRoot, env)
  let baseRefValid = false
  if (baseRef === null) {
    problems.push('[contracts-check] could not resolve a base ref (tried CONTRACTS_BASE_REF, then ' + BASE_REF_CANDIDATES.join(', ') + ') — failing closed. Set CONTRACTS_BASE_REF explicitly.')
  } else if (!isResolvableCommit(repoRoot, baseRef)) {
    // An unresolved ref must fail closed, not silently skip every compat
    // check (brief §5 "Base ref": "an unresolved ref fails closed"). This
    // is deliberately separate from "baseRef === null" above: here a ref WAS
    // supplied (usually CONTRACTS_BASE_REF), it just does not name a real
    // commit.
    problems.push(`[contracts-check] base ref '${baseRef}' does not resolve to a real commit — failing closed. There is no environment bypass; fix CONTRACTS_BASE_REF or unset it to use automatic discovery.`)
  } else {
    baseRefValid = true
  }

  let compatChecked = 0
  if (baseRefValid) {
    for (const entry of entries) {
      const oldRaw = readAtRef(repoRoot, baseRef, entry.file)
      if (oldRaw === null) continue // new since base: registered (checked above), no prior version to diff
      const newRaw = readFileSync(join(repoRoot, entry.file), 'utf8')
      let result
      try {
        result = entry.type === 'openapi' ? checkOpenApiCompat(oldRaw, newRaw, { env }) : checkAsyncApiCompat(oldRaw, newRaw)
      } catch (e) {
        problems.push(`${entry.file}: compat gate errored: ${e.message}`)
        continue
      }
      compatChecked++
      if (!result.ok) problems.push(`${entry.file}: ${result.reason}`)
    }
  }

  problems.push(...checkCodegenDrift(repoRoot))

  // Vacuity guard (T9): zero specs registered, or a base ref resolved but NONE
  // of the registered specs were actually diffed and not all of them are new,
  // both mean this pipeline checked nothing real.
  if (entries.length === 0) {
    problems.push('vacuity: contracts/registry.json has zero entries — nothing was checked')
  } else if (baseRefValid && compatChecked === 0) {
    const allNew = entries.every((e) => readAtRef(repoRoot, baseRef, e.file) === null)
    if (!allNew) problems.push(`vacuity: compat-checked 0 of ${entries.length} registered spec(s) against base ${baseRef}`)
  }

  return { ok: problems.length === 0, problems, entryCount: entries.length, compatChecked, baseRef }
}
