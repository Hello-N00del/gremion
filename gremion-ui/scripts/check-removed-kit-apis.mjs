// No shebang: invoked via `node …` (matches the sibling check-domain-regex.mjs
// convention).
/**
 * TASK-032 (TRD-410 [D R20-D5], brief §6 item 3): removed-kit-3-API guard.
 *
 * Fails if any `.svelte`/`.ts` source file in either app imports an API kit 3
 * removed OUTRIGHT (confirmed against the installed 3.0.0-next.28 package,
 * not just changelog prose — this is bleeding-edge software with real churn
 * between prereleases). The deprecated `$app/environment` alias is NOT banned.
 *
 * `$env/dynamic/private` and `$env/dynamic/public` ARE banned (TASK-032
 * round-1 MEDIUM), in production code and in `vi.mock`/`vi.doMock` sites
 * alike. They still resolve in kit 3, but only as a re-export of the vars
 * declared through kit's env schema (src/runtime/env/dynamic/private.js ->
 * `<sveltekit:generated>/env/private/server.js`), which this repo does not
 * use: every undeclared var (DATABASE_URL, issuers, secrets) silently reads
 * as undefined. A test's `vi.mock('$env/dynamic/private', ...)` is inert for
 * the same reason, because migrated code reads `process.env`. Both apps read
 * `process.env` directly instead.
 *
 * Exit: 0 = OK; 1 = one or more banned imports found (each printed).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCANNABLE = new Set(['.svelte', '.ts'])
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build'])
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Each banned specifier + the named imports removed from it, confirmed
// against @sveltejs/kit@3.0.0-next.28's own ambient type declarations, not
// just the changelog narrative.
const BANNED = [
  {
    specifier: '$app/stores',
    names: null, // the whole module is gone
    note: "removed at 3.0.0-next.7/15 (upstream CHANGELOG.md: 'breaking: remove $app/stores') — use $app/state instead",
  },
  {
    specifier: '$app/paths',
    names: ['base', 'assets', 'resolveRoute'],
    note: "removed (upstream CHANGELOG.md: 'breaking: remove base, assets, and resolveRoute from $app/paths') — use resolve()/asset() or a local build-time constant",
  },
]

// `$env/dynamic/*` in each of the three shapes that make code depend on it.
const ENV_DYNAMIC_RULES = [
  { re: /\bfrom\s+['"](\$env\/dynamic\/[A-Za-z]+)['"]/g, kind: 'imports' },
  { re: /\bimport\s*\(\s*['"`](\$env\/dynamic\/[A-Za-z]+)['"`]\s*\)/g, kind: 'dynamically imports' },
  { re: /\bvi\.(?:mock|doMock)\s*\(\s*['"`](\$env\/dynamic\/[A-Za-z]+)['"`]/g, kind: 'vi.mock()s (inert under kit 3)' },
]

/**
 * Repo-relative files exempt from the `$env/dynamic/*` rule ONLY (never from
 * the removed-API rule), each with a reason. Keep it minimal; the test suite
 * re-checks that every entry exists and carries a reason.
 */
export const ENV_DYNAMIC_FIXTURE_FILES = new Map([
  [
    'gremion-ui/src/lib/server/tenant/kernel-portable.guard.test.ts',
    "holds `import('$env/dynamic/private')` only inside string fixtures for the kernel-portable guard's own RED cases; nothing imports or mocks it",
  ],
])

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(join(dir, entry.name), out)
    } else if (SCANNABLE.has(extname(entry.name))) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * Every problem found in one file's text.
 *
 * @param {string} relPath
 * @param {string} text
 * @param {{ envDynamicExempt?: boolean }} [options]
 * @returns {string[]}
 */
export function checkFileText(relPath, text, { envDynamicExempt = false } = {}) {
  /** @type {string[]} */
  const problems = []
  for (const ban of BANNED) {
    const esc = ban.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const importRe = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${esc}['"]`, 'g')
    let m
    while ((m = importRe.exec(text)) !== null) {
      if (ban.names === null) {
        problems.push(`${relPath}: imports from removed '${ban.specifier}' — ${ban.note}`)
        continue
      }
      const imported = m[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      for (const name of imported) {
        if (ban.names.includes(name)) {
          problems.push(`${relPath}: imports removed '${name}' from '${ban.specifier}' — ${ban.note}`)
        }
      }
    }
  }
  if (!envDynamicExempt) {
    for (const rule of ENV_DYNAMIC_RULES) {
      rule.re.lastIndex = 0
      let hit
      while ((hit = rule.re.exec(text)) !== null) {
        problems.push(
          `${relPath}: ${rule.kind} '${hit[1]}' — kit 3 exposes only schema-declared vars through it (undeclared vars read as undefined); read process.env directly, and set process.env in tests`
        )
      }
    }
  }
  return problems
}

/**
 * Scan one app's src/ directory for every banned import.
 *
 * @param {string} srcRoot
 * @returns {string[]}
 */
export function checkAppSrc(srcRoot) {
  /** @type {string[]} */
  const problems = []
  const files = collectFiles(srcRoot)
  for (const file of files) {
    const rel = file.slice(srcRoot.length + 1).split('\\').join('/')
    const repoRel = relative(REPO_ROOT, file).split('\\').join('/')
    const envDynamicExempt = ENV_DYNAMIC_FIXTURE_FILES.has(repoRel)
    problems.push(...checkFileText(rel, readFileSync(file, 'utf8'), { envDynamicExempt }))
  }
  return problems
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const problems = [
    ...checkAppSrc(join(REPO_ROOT, 'gremion-ui', 'src')).map((p) => `gremion-ui/src/${p}`),
    ...checkAppSrc(join(REPO_ROOT, 'gremion-public', 'src')).map((p) => `gremion-public/src/${p}`),
  ]
  if (problems.length > 0) {
    console.error(`[removed-kit-apis] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log('[removed-kit-apis] OK — no source file imports a kit-3-removed API or $env/dynamic/*')
}
