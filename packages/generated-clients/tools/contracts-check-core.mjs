// packages/generated-clients/tools/contracts-check-core.mjs
//
// T9: the whole pipeline as one importable function, so both the CLI
// (contracts-check.mjs) and its own test (src/contracts-check.test.ts) call
// the SAME code — the pipeline the brief's acceptance demo and Q2 default
// (`pnpm --filter @gremion/generated-clients contracts:check`) both mean.
//
// Base ref (brief §5 "Base ref"): CONTRACTS_BASE_REF overrides; otherwise the
// merge-base with the target branch; an UNRESOLVED ref, and a discovered
// merge-base equal to HEAD (see discoverBaseRef), fail closed (it is
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

// origin/main first: on a local `main` carrying unpushed commits its
// merge-base is the last pushed commit, a real base; local `main` covers a
// clone with no remote. release-1/local-integration is NOT a candidate: that
// branch is frozen and local-only (TASK-018-FU).
const BASE_REF_CANDIDATES = ['origin/main', 'main']

function revParseHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** Discovery with its reason. A merge-base equal to HEAD (HEAD is ON a
 *  candidate branch, e.g. a clone of main) is NOT a base: diffing every spec
 *  against itself reports "OK ... N compat-checked" having compared nothing
 *  (TASK-018-FU finding 1, reproduced: a removed endpoint at an unchanged
 *  version passed on trunk). Such a candidate is skipped; if every candidate
 *  that resolved was HEAD, `baseIsHead` is true and the caller fails closed.
 *  An explicit CONTRACTS_BASE_REF is returned verbatim, even when it names
 *  HEAD — that is the operator's choice (the README's acceptance demo uses
 *  CONTRACTS_BASE_REF=HEAD to isolate an uncommitted edit). */
export function discoverBaseRef(repoRoot, env = process.env) {
  if (env.CONTRACTS_BASE_REF) return { ref: env.CONTRACTS_BASE_REF, baseIsHead: false }
  const head = revParseHead(repoRoot)
  let baseIsHead = false
  for (const branch of BASE_REF_CANDIDATES) {
    let ref = ''
    try {
      // stderr piped, not inherited: a missing candidate is expected, and a
      // stray `fatal:` line on a run that then succeeds trains people to
      // ignore `fatal:` lines.
      ref = execFileSync('git', ['merge-base', 'HEAD', branch], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
      continue // this candidate branch does not exist locally — try the next one
    }
    if (!ref) continue
    if (head !== null && ref === head) {
      baseIsHead = true
      continue
    }
    return { ref, baseIsHead: false }
  }
  return { ref: null, baseIsHead }
}

export function resolveBaseRef(repoRoot, env = process.env) {
  return discoverBaseRef(repoRoot, env).ref
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

/** Commit SHA `ref` names, or null. */
function revParseCommit(repoRoot, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** True when none of `files` differs between HEAD and the working tree. */
function specsCleanAgainstHead(repoRoot, files) {
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...files], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/** The path `file` had at `ref` when it was renamed since (base vs working
 *  tree, rename detection on), or null. Round-1 verifier HIGH: `git mv` of a
 *  spec plus a break made the new path look "new since base", so it was never
 *  diffed and the whole check said OK. */
function renamedFrom(repoRoot, ref, file) {
  let out = ''
  try {
    out = execFileSync('git', ['diff', '-M', '--name-status', '-z', ref, '--'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const f = out.split('\0')
  for (let i = 0; i < f.length; ) {
    const status = f[i]
    if (!status) break
    if (status.startsWith('R') || status.startsWith('C')) {
      if (f[i + 2] === file && status.startsWith('R')) return f[i + 1]
      i += 3
    } else {
      i += 2
    }
  }
  return null
}

/** The base copy of a registered spec: at its own path, else at the path it
 *  was renamed from. null = genuinely new since base. */
function readBaseCopy(repoRoot, ref, file) {
  const own = readAtRef(repoRoot, ref, file)
  if (own !== null) return own
  const old = renamedFrom(repoRoot, ref, file)
  return old === null ? null : readAtRef(repoRoot, ref, old)
}

function readAtRef(repoRoot, ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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

  const { ref: baseRef, baseIsHead } = discoverBaseRef(repoRoot, env)
  let baseRefValid = false
  if (baseRef === null && baseIsHead) {
    problems.push('[contracts-check] the discovered base ref equals HEAD (HEAD is on one of ' + BASE_REF_CANDIDATES.join(', ') + ', e.g. a clone of trunk) — diffing every spec against itself would check nothing, so failing closed. Set CONTRACTS_BASE_REF to the commit to compare against (e.g. CONTRACTS_BASE_REF=HEAD~1 to gate the last commit).')
  } else if (baseRef === null) {
    problems.push('[contracts-check] could not resolve a base ref (tried CONTRACTS_BASE_REF, then ' + BASE_REF_CANDIDATES.join(', ') + ') — failing closed. Set CONTRACTS_BASE_REF explicitly.')
  } else if (!isResolvableCommit(repoRoot, baseRef)) {
    // An unresolved ref must fail closed, not silently skip every compat
    // check (brief §5 "Base ref": "an unresolved ref fails closed"). This
    // is deliberately separate from "baseRef === null" above: here a ref WAS
    // supplied (usually CONTRACTS_BASE_REF), it just does not name a real
    // commit.
    problems.push(`[contracts-check] base ref '${baseRef}' does not resolve to a real commit — failing closed. There is no environment bypass; fix CONTRACTS_BASE_REF or unset it to use automatic discovery.`)
  } else if (env.CONTRACTS_BASE_REF
    && revParseCommit(repoRoot, baseRef) === revParseCommit(repoRoot, 'HEAD')
    && specsCleanAgainstHead(repoRoot, entries.map((e) => e.file))) {
    // Round-1 review MEDIUM: an explicit ref that RESOLVES to HEAD (`HEAD`,
    // `main`, or `origin/main` on a push to trunk) with no spec edits in the
    // working tree diffs every spec against itself — the same vacuous OK the
    // discovery guard above refuses. HEAD as the base for an UNCOMMITTED spec
    // edit (the README's acceptance demo) is a real diff and still honoured.
    problems.push(`[contracts-check] CONTRACTS_BASE_REF '${baseRef}' resolves to HEAD and no registered spec differs from HEAD — diffing every spec against itself would check nothing, so failing closed. Point CONTRACTS_BASE_REF at an earlier commit (e.g. HEAD~1).`)
  } else {
    baseRefValid = true
  }

  let compatChecked = 0
  if (baseRefValid) {
    for (const entry of entries) {
      const oldRaw = readBaseCopy(repoRoot, baseRef, entry.file)
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
    const allNew = entries.every((e) => readBaseCopy(repoRoot, baseRef, e.file) === null)
    if (!allNew) problems.push(`vacuity: compat-checked 0 of ${entries.length} registered spec(s) against base ${baseRef}`)
  }

  return { ok: problems.length === 0, problems, entryCount: entries.length, compatChecked, baseRef }
}
