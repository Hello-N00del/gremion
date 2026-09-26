// Pure repo-walking and glob-matching helpers for the ci-local guard set.
//
// No git, no child_process here — snapshot.mjs and guards.mjs wire this to a
// real filesystem, and this file's own tests wire it to a temp directory, so
// the matching logic is proven without spawning anything.

import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Directories that are never test sources, and that would otherwise blow up
// the walk (node_modules) or reach into a submodule that may not be
// initialised offline (upstream) or a private build cache.
export const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'upstream',
  'dist',
  'build',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.next',
  'test_helper', // bats fixture helpers, never a suite themselves
  'fixtures',
  '__fixtures__', // JS/TS convention for the same thing — e.g. gremion-ui's
  // scripts/__fixtures__/env-guard/*.test.ts, which check-tenant-env-guard's
  // OWN real test reads as planted input data (see that fixture file's own
  // header comment: "Tests legitimately pin env behavior and do NOT ship").
  // Discovered here anyway, it is a real, false "unclaimed" finding on both
  // repos' real tips — verified against the actual kernel and StuRaOS trees.
])

/** A test file, by the five extensions the brief names. */
export const TEST_FILE_RE = /(\.test\.ts|\.spec\.ts|\.test\.mjs|\.bats|_test\.dart)$/

/**
 * Every file under `root`, as POSIX-style repo-relative paths, skipping
 * DEFAULT_EXCLUDE_DIRS (by directory basename, anywhere in the tree) plus any
 * extra names in `extraExcludeDirs`.
 */
export function walkFiles(root, { extraExcludeDirs = [] } = {}) {
  const excluded = new Set([...DEFAULT_EXCLUDE_DIRS, ...extraExcludeDirs])
  const out = []

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable / vanished mid-walk — never fatal to a census
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Dot-directories (.git, .svelte-kit, .turbo, .next, ...) are skipped
        // the same as the named excludes; dotFILES (.gitleaks.toml, .env.example)
        // are ordinary leaves and fall through to the isFile() branch below.
        if (excluded.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full)
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }

  walk(root)
  return out
}

/** Every test file (by TEST_FILE_RE) under `root`. */
export function discoverTestFiles(root, opts = {}) {
  return walkFiles(root, opts).filter((f) => TEST_FILE_RE.test(f))
}

/**
 * Compile a glob (posix-style, `**` = any depth, `*` = one segment's worth of
 * non-slash characters) into an anchored RegExp. Deliberately minimal: the
 * manifest's globs are all plain `dir/**\/*.ext` or literal paths, and a
 * dependency-free matcher is one less thing that can silently miss on a
 * platform where the dependency does not resolve.
 */
export function globToRegExp(glob) {
  let re = ''
  const g = glob.replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      // consume an optional following slash so `a/**/b` matches `a/b` too
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

/** Does `relPath` match at least one of `globs`? */
export function matchesAny(globs, relPath) {
  return globs.some((g) => globToRegExp(g).test(relPath))
}

/** Every file in `paths` that matches at least one glob in `globs`. */
export function filterMatching(globs, paths) {
  return paths.filter((p) => matchesAny(globs, p))
}
