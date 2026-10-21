// TASK-045: typecheck suite (brief S5). Runs gremion-ui's and
// gremion-public's `check` pipeline plus every workspace package's own
// `typecheck` script, pulling the svelte-check step out on its own with
// `--output machine` so its FILES/ERRORS counts are parseable -- the
// composite `pnpm … check` script never asked svelte-check for machine
// output, which is how the release-1 gate's unparseable-errors-passes bug
// (integration-gate.sh's `ce=${ce:-?}` defaulting to a pass) went unnoticed.
// Every step is its own combineParts part, so an empty svelte-check run or
// a missing package fails by name.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { stubEnvFilesIfAbsent } from '../lib/envstub.mjs'
import { parseSvelteCheckMachine } from '../lib/parsers.mjs'
import { run, spawnMissing, tail } from '../lib/proc.mjs'
import { REPO_ROOT } from '../lib/vitest.mjs'

// The three TASK-032-owned build guards gremion-ui's own `check` script runs
// before svelte-check. Called individually (not via `pnpm check`) so
// svelte-check can be run separately with `--output machine`.
const UI_PRECHECKS = [
  ['scripts/check-tenant-env-guard.mjs', ['--enforce', '--root', 'src']],
  ['scripts/check-app-port-binding.mjs', []],
  ['scripts/check-tenant-secrets-dir.mjs', []],
]

/** A pass/fail step with no count of its own (a guard script, tsc): one
 * collected check, judged by exit code. */
function exitCodePart(label, res, tool) {
  if (spawnMissing(res)) return { label, toolMissing: tool }
  const ok = res.code === 0
  return { label, collected: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0, detail: ok ? '' : tail(res.stdout + res.stderr) }
}

export function judgeTsc(label, res) {
  return exitCodePart(label, res, 'pnpm')
}

/** svelte-check's machine COMPLETED line, cross-checked with its exit code:
 * a non-zero exit its own summary does not explain (0 ERRORS) is untrusted. */
export function judgeSvelteCheck(label, res) {
  if (spawnMissing(res)) return { label, toolMissing: 'pnpm' }
  const out = `${res.stdout}\n${res.stderr}`
  const parsed = parseSvelteCheckMachine(out)
  if (!parsed) {
    return { label, unparseable: true, detail: `svelte-check produced no parseable COMPLETED line (exit ${res.code})\n${tail(out)}` }
  }
  if (res.code !== 0 && parsed.failed === 0) {
    return { label, unparseable: true, detail: `svelte-check exited ${res.code} but reported 0 errors -- untrusted\n${tail(out)}` }
  }
  return { label, ...parsed, detail: parsed.failed > 0 ? tail(out, 1500) : '' }
}

function svelteCheckParts(appDir, label) {
  const sync = run('pnpm', ['exec', 'svelte-kit', 'sync'], { cwd: appDir })
  if (spawnMissing(sync)) return [{ label, toolMissing: 'pnpm' }]
  if (sync.code !== 0) {
    return [{ label, unparseable: true, detail: `svelte-kit sync failed: ${tail(sync.stdout + sync.stderr)}` }]
  }
  const check = run('pnpm', ['exec', 'svelte-check', '--tsconfig', './tsconfig.json', '--output', 'machine'], { cwd: appDir })
  return [judgeSvelteCheck(label, check)]
}

/** Every packages/* directory whose package.json defines `typecheck`, so a
 * new package (TASK-030's @gremion/generated-clients was the first) is
 * typechecked without anyone remembering to add it here. */
export function typecheckPackageDirs(root = REPO_ROOT) {
  // packages/* is required (a repo with none is a failing part below); services/*
  // (TASK-077, the kernel API) is optional -- a tree without it is not an error.
  const trees = ['packages', 'services']
  return trees
    .flatMap((tree) => {
      const treeDir = path.join(root, tree)
      if (!existsSync(treeDir)) {
        if (tree === 'packages') readdirSync(treeDir) // throws ENOENT, as before
        return []
      }
      return readdirSync(treeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(treeDir, d.name))
    })
    .filter((dir) => {
      const pj = path.join(dir, 'package.json')
      if (!existsSync(pj)) return false
      return typeof JSON.parse(readFileSync(pj, 'utf8')).scripts?.typecheck === 'string'
    })
    .sort()
}

export function runTypecheckSuite({ root = REPO_ROOT } = {}) {
  const uiDir = path.join(root, 'gremion-ui')
  const publicDir = path.join(root, 'gremion-public')
  const parts = []
  try {
    stubEnvFilesIfAbsent(root)
  } catch (err) {
    return combineParts([{ label: 'stub .env / legal/legal.env', unparseable: true, detail: err.message }])
  }
  for (const [script, args] of UI_PRECHECKS) {
    parts.push(exitCodePart(`gremion-ui ${script}`, run(process.execPath, [script, ...args], { cwd: uiDir }), 'node'))
  }
  parts.push(...svelteCheckParts(uiDir, 'gremion-ui svelte-check'))
  parts.push(...svelteCheckParts(publicDir, 'gremion-public svelte-check'))
  const pkgDirs = typecheckPackageDirs(root)
  if (pkgDirs.length === 0) {
    parts.push({ label: 'packages/* typecheck (no package defines one)', collected: 0, passed: 0, failed: 0, skipped: 0 })
  }
  for (const dir of pkgDirs) {
    const name = path.relative(root, dir).split(path.sep).join('/')
    parts.push(judgeTsc(`${name} typecheck`, run('pnpm', ['run', 'typecheck'], { cwd: dir })))
  }
  return combineParts(parts)
}
