// No shebang: this script is always invoked via `node …` (package.json `check`,
// spawnSync(process.execPath) in its unit test), and a hashbang line breaks the
// vitest inline transform of .mjs imports (SyntaxError at the importing test)
// under Node 26 / Vitest 3.2.4 — the unit test imports scanForEnvViolations.
// @ts-nocheck — standalone node build script (invoked via the CLI, not TS-typed);
// it is pulled into the svelte-check program only because the unit test imports
// `scanForEnvViolations`, and `checkJs`+`strict` would flag its untyped params.
/**
 * P2.1a (#202 §7.7): build-time tenancy env guard. Fails the build on any
 * direct $env/dynamic/private read of the PER-TENANT variable set outside the
 * allowlisted tenant-resolver path. Read shape is uniform: `env.<VAR>` (and the
 * bracket form `env['<VAR>']`). Standalone node script (no ESLint in the repo),
 * modeled on build-migration-manifest.mjs.
 *
 * Exit (CLI): 0 = no violations OR report-only; 1 = violations AND --enforce,
 * OR any unreadable directory in the scan tree (#256-7 fail-closed — an
 * unreadable subtree must never be reported clean, regardless of --enforce).
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PER_TENANT_EXACT_VARS,
  PER_TENANT_PREFIX_VARS,
  isPerTenantEnvName,
} from '../src/lib/server/env/per-tenant-env-names.js'
import { isServiceEndpointName } from '../src/lib/server/env/service-endpoint-names.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// TASK-042 Q4 / R28: the per-tenant name list is runtime data owned by
// src/lib/server/env/per-tenant-env-names.js, which platform-env.ts also
// imports; this build script re-exports it (never the reverse).
export const EXACT_VARS = PER_TENANT_EXACT_VARS
export const PREFIX_VARS = PER_TENANT_PREFIX_VARS
const SCANNABLE = /\.(ts|svelte)$/
// D-GUARD-TESTS (P2.1c T14): test files legitimately pin env behavior and do NOT
// ship, so they are exempt from the build-failing guard. Skip `*.test.ts` AND
// `*.integration.test.ts` (the latter already matches `.test.ts`, listed for clarity)
// — and the `.svelte` analogues for symmetry with SCANNABLE.
const SKIP_FILE = /\.(test|integration\.test)\.(ts|svelte)$/
const READ_RE = /\benv(?:\.([A-Z0-9_]+)\b|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g
// TASK-205 (verifier r1 MEDIUM): serviceEnv (lib/server/env/service-env.ts) reads process.env[name] with a
// computed key READ_RE cannot see. Its CALL SITES are read instead: `serviceEnv('X')` must name a
// service endpoint (service-endpoint-names.js); a non-endpoint literal or a computed / template name is a
// violation, so the seam can never become an invisible general per-tenant reader.
const SERVICE_ENV_RE = /\bserviceEnv\(\s*(?:(['"])([A-Z0-9_]+)\1)?/g

const isPerTenant = isPerTenantEnvName

// Allowlist segments are matched against paths RELATIVE to the scan root. The CLI roots the scan at
// gremion-ui/src, so the tenant-resolver module is `lib/server/tenant/...` (NOT `src/lib/server/tenant/...`):
// the resolver is the one place that legitimately reads the per-tenant env (registry.ts
// resolveTenantBySlug, control-db.ts). `lib/server/env/service-env.ts` is the serviceEnv seam itself
// (its definition is a computed-name call shape); it is named here so the exemption is visible, not implicit.
export const DEFAULT_ALLOWLIST = Object.freeze(['lib/server/tenant', 'lib/server/env/service-env.ts'])

export async function scanForEnvViolations(rootDir, opts = {}) {
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST
  const violations = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      // #256-7: an unreadable directory must FAIL the guard, not be silently
      // reported clean (fail-open). Matches build-migration-manifest.mjs's
      // failed-to-read handling — the CLI's catch turns this into exit 1.
      throw new Error(`[env-guard] failed to read directory ${dir}: ${err.message}`)
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.svelte-kit') continue
        await walk(full); continue
      }
      if (!SCANNABLE.test(e.name)) continue
      if (SKIP_FILE.test(e.name)) continue // D-GUARD-TESTS: tests don't ship
      const rel = path.relative(rootDir, full).split(path.sep).join('/')
      if (allowlist.some((seg) => rel.includes(seg))) continue
      const src = await readFile(full, 'utf-8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        READ_RE.lastIndex = 0
        let m
        while ((m = READ_RE.exec(lines[i])) !== null) {
          const name = m[1] ?? m[2]
          if (name && isPerTenant(name)) violations.push({ file: full, line: i + 1, varName: name, kind: 'env' })
        }
        SERVICE_ENV_RE.lastIndex = 0
        while ((m = SERVICE_ENV_RE.exec(lines[i])) !== null) {
          const name = m[2]
          if (!name) violations.push({ file: full, line: i + 1, varName: '<computed>', kind: 'serviceEnv' })
          else if (!isServiceEndpointName(name)) violations.push({ file: full, line: i + 1, varName: name, kind: 'serviceEnv' })
        }
      }
    }
  }
  await walk(rootDir)
  return violations
}

function describeViolation(v) {
  if (v.kind === 'serviceEnv') return v.varName === '<computed>' ? 'serviceEnv(<computed name>)' : `serviceEnv('${v.varName}')`
  return `env.${v.varName}`
}

async function main() {
  if (process.argv.includes('--list-allowlist')) {
    console.info(DEFAULT_ALLOWLIST.join('\n'))
    process.exit(0)
  }
  const enforce = process.argv.includes('--enforce')
  const rootArgIdx = process.argv.indexOf('--root')
  const root = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? path.resolve(process.argv[rootArgIdx + 1])
    : path.resolve(__dirname, '..', 'src')
  const violations = await scanForEnvViolations(root)
  if (violations.length === 0) {
    console.info('[env-guard] OK — no per-tenant env reads outside the resolver allowlist')
    process.exit(0)
  }
  console.error(`[env-guard] ${violations.length} per-tenant env read(s) outside the resolver allowlist:`)
  for (const v of violations) console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}  ${describeViolation(v)}`)
  if (enforce) {
    console.error('[env-guard] FAIL (--enforce): convert these to per-tenant resolver reads.')
    process.exit(1)
  }
  console.error('[env-guard] report-only (no --enforce): not failing the build yet.')
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[env-guard] unexpected error: ${err.stack || err.message}`); process.exit(1) })
}
