// suites.json loading and validation. Pure functions over the parsed JSON —
// no filesystem here except `loadManifest`'s single readFileSync, so the
// validation rules are testable against inline fixtures.

import { readFileSync } from 'node:fs'

export const CATEGORIES = ['unit', 'integration', 'e2e', 'shell', 'tree-guard']
export const REPOS = ['kernel', 'vertical']

export function loadManifest(path) {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text)
}

/**
 * Every REPO must declare at least one suite per CATEGORY, or the manifest is
 * invalid and snapshot.mjs must refuse to run rather than silently reporting
 * partial coverage as if it were complete.
 *
 * Returns an array of problem strings; empty means valid.
 */
export function validateManifest(manifest) {
  const problems = []
  for (const repo of REPOS) {
    const suites = manifest[repo]
    if (!Array.isArray(suites) || suites.length === 0) {
      problems.push(`manifest declares no suites at all for repo '${repo}'`)
      continue
    }
    const seenIds = new Set()
    for (const suite of suites) {
      if (seenIds.has(suite.id)) problems.push(`repo '${repo}': duplicate suite id '${suite.id}'`)
      seenIds.add(suite.id)
      if (!CATEGORIES.includes(suite.category)) {
        problems.push(`repo '${repo}': suite '${suite.id}' declares unknown category '${suite.category}'`)
      }
      // A suite with no testGlobs can never be reported as "files absent"
      // and claims nothing, so it could run nothing and still look present.
      if (!Array.isArray(suite.testGlobs) || suite.testGlobs.length === 0) {
        problems.push(`repo '${repo}': suite '${suite.id}' has no testGlobs — every suite must name the files that prove it exists`)
      }
    }
    for (const category of CATEGORIES) {
      const count = suites.filter((s) => s.category === category).length
      if (count < 1) {
        problems.push(`repo '${repo}': category '${category}' has 0 suites — every category needs at least 1`)
      }
    }
  }
  return problems
}

/** Suites for one repo, optionally filtered to an explicit id allow-list (`--only`). */
export function suitesFor(manifest, repo, onlyIds) {
  const all = manifest[repo] ?? []
  if (!onlyIds || onlyIds.length === 0) return all
  const wanted = new Set(onlyIds)
  return all.filter((s) => wanted.has(s.id))
}
