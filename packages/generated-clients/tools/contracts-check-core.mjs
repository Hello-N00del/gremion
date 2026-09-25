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

function readAtRef(repoRoot, ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8' })
  } catch {
    return null // file is new since base, or the ref/path genuinely has nothing
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
  if (baseRef === null) {
    problems.push('[contracts-check] could not resolve a base ref (tried CONTRACTS_BASE_REF, then ' + BASE_REF_CANDIDATES.join(', ') + ') — failing closed. Set CONTRACTS_BASE_REF explicitly.')
  }

  let compatChecked = 0
  if (baseRef !== null) {
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
  } else if (baseRef !== null && compatChecked === 0) {
    const allNew = entries.every((e) => readAtRef(repoRoot, baseRef, e.file) === null)
    if (!allNew) problems.push(`vacuity: compat-checked 0 of ${entries.length} registered spec(s) against base ${baseRef}`)
  }

  return { ok: problems.length === 0, problems, entryCount: entries.length, compatChecked, baseRef }
}
