// TASK-045: typecheck suite (brief S5). Runs gremion-ui's and
// gremion-public's `check` pipeline plus @gremion/db and @gremion/ports
// `typecheck`, but pulls the svelte-check step out on its own with
// `--output machine` so its FILES/ERRORS counts are parseable -- the
// composite `pnpm … check` script never asked svelte-check for machine
// output, which is how the release-1 gate's unparseable-errors-passes bug
// (integration-gate.sh's `ce=${ce:-?}` defaulting to a pass) went unnoticed.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseSvelteCheckMachine } from '../lib/parsers.mjs'
import { run } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

// The four TASK-032-owned build guards gremion-ui's own `check` script runs
// before svelte-check. Called individually (not via `pnpm check`) so
// svelte-check can be run separately with `--output machine`.
const UI_PRECHECKS = [
  ['scripts/check-tenant-env-guard.mjs', ['--enforce', '--root', 'src']],
  ['scripts/check-app-port-binding.mjs', []],
  ['scripts/check-domain-regex.mjs', []],
  ['scripts/check-tenant-secrets-dir.mjs', []],
]

function svelteCheckApp(appDir) {
  const sync = run('pnpm', ['exec', 'svelte-kit', 'sync'], { cwd: appDir })
  if (sync.code !== 0) {
    return { unparseable: true, detail: `svelte-kit sync failed in ${appDir}: ${tail(sync.stdout + sync.stderr)}` }
  }
  const check = run('pnpm', ['exec', 'svelte-check', '--tsconfig', './tsconfig.json', '--output', 'machine'], {
    cwd: appDir,
  })
  const parsed = parseSvelteCheckMachine(check.stdout + '\n' + check.stderr)
  if (!parsed) {
    return { unparseable: true, detail: `${appDir}: svelte-check produced no parseable COMPLETED line: ${tail(check.stdout + check.stderr)}` }
  }
  return { unparseable: false, ...parsed }
}

function tscTypecheck(pkgDir) {
  const res = run('pnpm', ['run', 'typecheck'], { cwd: pkgDir })
  // tsc has no per-file COMPLETED summary to parse; it is treated as one
  // pass/fail unit rather than given a false per-file count.
  return { collected: 1, passed: res.code === 0 ? 1 : 0, failed: res.code === 0 ? 0 : 1, detail: res.code === 0 ? '' : tail(res.stdout + res.stderr) }
}

export function runTypecheckSuite({ root = REPO_ROOT } = {}) {
  const uiDir = path.join(root, 'gremion-ui')
  const publicDir = path.join(root, 'gremion-public')
  const dbDir = path.join(root, 'packages', 'db')
  const portsDir = path.join(root, 'packages', 'ports')
  if (!existsSync(uiDir) || !existsSync(publicDir) || !existsSync(dbDir) || !existsSync(portsDir)) {
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: 'workspace package missing' }
  }

  const details = []
  for (const [script, args] of UI_PRECHECKS) {
    const res = run('node', [script, ...args], { cwd: uiDir })
    if (res.code !== 0) {
      return {
        toolMissing: null,
        unparseable: false,
        collected: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        detail: `gremion-ui ${script} failed: ${tail(res.stdout + res.stderr)}`,
      }
    }
  }

  const ui = svelteCheckApp(uiDir)
  if (ui.unparseable) return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: ui.detail }

  const pub = svelteCheckApp(publicDir)
  if (pub.unparseable) return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: pub.detail }

  const db = tscTypecheck(dbDir)
  const ports = tscTypecheck(portsDir)
  if (db.detail) details.push(`@gremion/db typecheck: ${db.detail}`)
  if (ports.detail) details.push(`@gremion/ports typecheck: ${ports.detail}`)

  return {
    toolMissing: null,
    unparseable: false,
    collected: ui.collected + pub.collected + db.collected + ports.collected,
    passed: ui.passed + pub.passed + db.passed + ports.passed,
    failed: ui.failed + pub.failed + db.failed + ports.failed,
    skipped: 0,
    detail: details.join('\n'),
  }
}

function tail(text, n = 400) {
  return text.length > n ? text.slice(-n) : text
}
