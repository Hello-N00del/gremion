// No shebang: invoked via `node …` (matches the sibling check-domain-regex.mjs
// convention).
// @ts-nocheck — standalone node build script (CLI-invoked, not TS-typed).
/**
 * TASK-032 (TRD-410 [D R20-D5], brief §6 item 3): removed-kit-3-API guard.
 *
 * Fails if any `.svelte`/`.ts` source file in either app imports an API kit 3
 * removed OUTRIGHT (confirmed against the installed 3.0.0-next.28 package,
 * not just changelog prose — this is bleeding-edge software with real churn
 * between prereleases). Deprecated-but-still-working aliases ($app/environment,
 * $env/dynamic/*) are NOT banned here: this repo migrated away from them for
 * independent correctness reasons (see the migration commits), but they are
 * still valid kit exports in 3.0.0-next.28 and banning them would make this
 * guard assert more than "removed" actually means.
 *
 * Exit: 0 = OK; 1 = one or more banned imports found (each printed).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCANNABLE = new Set(['.svelte', '.ts'])
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build'])

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

/** Every problem found in one file's text. */
export function checkFileText(relPath, text) {
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
  return problems
}

/** Scan one app's src/ directory for every banned import. */
export function checkAppSrc(srcRoot) {
  const problems = []
  const files = collectFiles(srcRoot)
  for (const file of files) {
    const rel = file.slice(srcRoot.length + 1).split('\\').join('/')
    problems.push(...checkFileText(rel, readFileSync(file, 'utf8')))
  }
  return problems
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const problems = [
    ...checkAppSrc(join(REPO_ROOT, 'gremion-ui', 'src')).map((p) => `gremion-ui/src/${p}`),
    ...checkAppSrc(join(REPO_ROOT, 'gremion-public', 'src')).map((p) => `gremion-public/src/${p}`),
  ]
  if (problems.length > 0) {
    console.error(`[removed-kit-apis] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log('[removed-kit-apis] OK — no source file imports a kit-3-removed API')
}
