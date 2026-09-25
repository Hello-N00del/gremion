// No shebang: invoked via `node …` (matches the sibling check-domain-regex.mjs /
// check-tenant-env-guard.mjs convention).
// @ts-nocheck — standalone node build script (CLI-invoked, not TS-typed).
/**
 * TASK-032 (TRD-410 [D R20-D5]): SvelteKit-3 major-version guard.
 *
 * WHAT THIS CATCHES. The migration to kit 3 pins an EXACT prerelease (no 3.0
 * stable tag exists yet) across two manifests, one workspace override and a
 * lockfile. Any of these can drift back to 2.x — or to a caret/range that
 * WOULD resolve 2.x on the next install — without anything else noticing:
 *
 *   1. A manifest's `@sveltejs/kit` range still resolves (or could resolve) a
 *      2.x release: wrong major, or a caret/tilde/`>=` left on a prerelease
 *      pin (`^3.0.0-next.28` still matches only 3.0.0-next.28 today, but the
 *      acceptance is an EXACT pin — no operator at all).
 *   2. `@sveltejs/adapter-node` not moved to its matching 6.x line (its peer
 *      is `^3.0.0-next.0`; an adapter still on 5.x silently no-ops against a
 *      kit-2 peer range it can no longer satisfy).
 *   3. The lockfile still resolves a 2.x copy of kit anywhere in the tree
 *      (a stale transitive copy an app manifest bump alone would not clear).
 *
 * Exit: 0 = OK; 1 = one or more problems (each printed).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APPS = ['gremion-ui', 'gremion-public']

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/

/** Raw declared range/version string for `name` in a package.json's text, or null. */
export function readDep(pkgJsonText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`"${esc}":\\s*"([^"]+)"`)
  const m = String(pkgJsonText).match(re)
  return m ? m[1] : null
}

/**
 * True if `v` is anything OTHER than an exact `x.y.z[-prerelease]` pin: a
 * caret/tilde, an explicit comparator, an OR range, a workspace/tag protocol,
 * or a bare wildcard. An exact prerelease pin (no leading operator) is the
 * only shape this returns false for.
 */
export function hasRangeOperator(v) {
  const s = String(v).trim()
  if (new RegExp(`^${VERSION.source}$`).test(s)) return false
  return true
}

/** The semver major of a version string, ignoring any leading range operator. */
export function majorOf(v) {
  const m = String(v).match(VERSION)
  if (!m) return null
  const major = Number(m[0].split('.')[0].replace(/^[^\d]*/, ''))
  return Number.isFinite(major) ? major : null
}

/** Every problem with one app's manifest text. */
export function checkManifest(app, pkgJsonText) {
  const problems = []

  const kit = readDep(pkgJsonText, '@sveltejs/kit')
  if (kit === null) {
    problems.push(`${app}/package.json: declares no @sveltejs/kit dependency`)
  } else {
    if (hasRangeOperator(kit)) {
      problems.push(
        `${app}/package.json: @sveltejs/kit "${kit}" carries a range operator — the acceptance is an EXACT pin (no 3.0 stable tag exists yet, so a caret on a prerelease is not safe: prereleases do not follow semver-compatible ordering)`
      )
    }
    const major = majorOf(kit)
    if (major !== 3) {
      problems.push(`${app}/package.json: @sveltejs/kit "${kit}" is major ${major}, not 3`)
    }
  }

  const adapter = readDep(pkgJsonText, '@sveltejs/adapter-node')
  if (adapter === null) {
    problems.push(`${app}/package.json: declares no @sveltejs/adapter-node dependency`)
  } else {
    if (hasRangeOperator(adapter)) {
      problems.push(
        `${app}/package.json: @sveltejs/adapter-node "${adapter}" carries a range operator — pin the exact 6.x prerelease`
      )
    }
    const major = majorOf(adapter)
    if (major !== 6) {
      problems.push(
        `${app}/package.json: @sveltejs/adapter-node "${adapter}" is major ${major}, not 6 (its peer is @sveltejs/kit ^3.0.0-next.0, which a 5.x adapter cannot satisfy)`
      )
    }
  }

  return problems
}

/** Every top-level lockfile resolution of `name` at a 2.x version. */
export function findLockfile2xResolutions(lockText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^ {2}'?${esc}@(${VERSION.source})`, 'gm')
  const found = new Set()
  for (const m of String(lockText).matchAll(re)) {
    if (majorOf(m[1]) === 2) found.add(m[1])
  }
  return [...found]
}

/** Problems from the lockfile still resolving a 2.x copy of kit anywhere. */
export function checkLockfile(lockText) {
  const problems = []
  const stale = findLockfile2xResolutions(lockText, '@sveltejs/kit')
  for (const v of stale) {
    problems.push(`pnpm-lock.yaml: still resolves @sveltejs/kit@${v} somewhere in the tree`)
  }
  return problems
}

/**
 * Every check, given the two app manifests' text and the lockfile's text.
 * A manifest of `null` (file unreadable) counts as "found no manifest" for
 * that app; if EVERY app is null, this is treated as a guard-itself failure
 * (a run that silently checked nothing would pass vacuously) rather than
 * reported per-app.
 */
export function runAllChecks({ uiPkg, publicPkg, lock }) {
  const manifests = [
    ['gremion-ui', uiPkg],
    ['gremion-public', publicPkg],
  ]
  if (manifests.every(([, text]) => text === null || text === undefined)) {
    return ['found zero package.json manifests to check — the guard would otherwise pass vacuously']
  }
  const problems = []
  for (const [app, text] of manifests) {
    if (text === null || text === undefined) {
      problems.push(`${app}/package.json: not found`)
      continue
    }
    problems.push(...checkManifest(app, text))
  }
  problems.push(...checkLockfile(lock ?? ''))
  return problems
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const read = (p) => {
    try {
      return readFileSync(join(ROOT, p), 'utf8')
    } catch {
      return null
    }
  }
  const problems = runAllChecks({
    uiPkg: read('gremion-ui/package.json'),
    publicPkg: read('gremion-public/package.json'),
    lock: read('pnpm-lock.yaml'),
  })
  if (problems.length > 0) {
    console.error(`[sveltekit-major] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log('[sveltekit-major] OK — both apps pinned to kit 3, adapter-node 6.x, no 2.x resolved')
}
