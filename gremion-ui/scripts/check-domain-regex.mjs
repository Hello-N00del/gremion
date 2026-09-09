// No shebang: invoked via `node …` (package.json `check`) — matches the sibling
// check-app-port-binding.mjs / check-tenant-env-guard.mjs convention (a hashbang
// breaks the vitest inline .mjs transform if a unit test imports a helper here).
// @ts-nocheck — standalone node build script (CLI-invoked, not TS-typed).
/**
 * P2.1c (#202, FIX3-EDGE-REGEX): DOMAIN_REGEX deploy guard for the T2 tenant
 * wildcard edge routers in docker-compose.prod.yml.
 *
 * THE BUG THIS CATCHES. The prod-overlay wildcard routers carry a wildcard leg
 *   HostRegexp(`^[a-z0-9-]+\.${DOMAIN_REGEX:-}$`)
 * (gremion-ui, keycloak, keycloak-admin, fallback — the governance-only carve
 *  removed the `wellknown` matrix-legal router with the messages module).
 * `DOMAIN_REGEX`
 * is LOAD-BEARING but defaults EMPTY (`:-`). When it is unset/empty the leg
 * renders the DEAD pattern `^[a-z0-9-]+\.$`, which matches NO real tenant host
 * — so `<slug>.${DOMAIN}` 404s at Traefik after a by-the-book S4 deploy, while
 * the apex/default keeps working (masking the omission). DOMAIN_REGEX must be
 * the regexp-escaped DOMAIN (DOMAIN=council.example -> DOMAIN_REGEX=council\.example).
 *
 * WHAT THIS CHECK ASSERTS (read-only: `docker compose config` only, NEVER `up`):
 *   1. WIRING (deterministic, env-independent): rendering the prod overlay with
 *      a controlled non-empty DOMAIN_REGEX makes EVERY wildcard leg embed the
 *      escaped domain (no leg collapses to the dead pattern) — proves
 *      DOMAIN_REGEX flows into every wildcard leg and none was hard-coded away.
 *   2. CANARY (deterministic): rendering with DOMAIN_REGEX EMPTY makes every
 *      wildcard leg collapse to the dead pattern — pins the exact failure
 *      signature the runbook/troubleshooting describe, and would catch a leg
 *      silently switched off the `${DOMAIN_REGEX:-}` seam.
 *   3. DEPLOY GUARD (ambient .env): if the operator's ambient DOMAIN is a real
 *      production domain (non-empty, not localhost/127.x, >=2 labels) then the
 *      ambient render must NOT collapse — i.e. DOMAIN_REGEX is set. In dev /
 *      on this staging host (DOMAIN=localhost, DOMAIN_REGEX unset) this leg is
 *      a no-op, so `pnpm check` stays green; it only fires for a prod .env.
 *
 * Exit: 0 = OK (or docker unavailable -> loud SKIP); 1 = a wiring/canary/deploy
 * failure (or a broken compose render).
 *
 * Repo root: ../.. relative to this script (gremion-ui/scripts -> repo root).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const PROD_ARGS = [
  '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', '--profile', 'production',
]

// The wildcard edge routers (docker-compose.prod.yml). Each rule carries a
// `HostRegexp(\`^[a-z0-9-]+\.${DOMAIN_REGEX:-}$\`)` leg. The governance-only carve
// removed the `wellknown` (matrix legal) router with the messages module, so the
// kernel edge has four wildcard routers.
const WILDCARD_RULE_LABELS = [
  'traefik.http.routers.gremion-ui.rule',
  'traefik.http.routers.keycloak.rule',
  'traefik.http.routers.keycloak-admin.rule',
  'traefik.http.routers.fallback.rule',
]

// `docker compose config` re-escapes a single runtime `$` as `$$` on output, so
// the rendered DEAD pattern carries `$$`. Match either form (compose output vs a
// hand-built single-`$` rule string in unit tests). The dead pattern is the
// wildcard leg with an EMPTY escaped domain: `^[a-z0-9-]+\.` immediately closed
// by the regex end-anchor.
export const DEAD_WILDCARD_RE = /HostRegexp\(`\^\[a-z0-9-\]\+\\\.\${1,2}`\)/

/** True if a rendered router rule contains the dead/collapsed wildcard leg
 *  (DOMAIN_REGEX was empty when this rule was rendered). */
export function isCollapsedWildcard(rule) {
  return typeof rule === 'string' && DEAD_WILDCARD_RE.test(rule)
}

/** A production DOMAIN that needs DOMAIN_REGEX. Dev / loopback / single-label
 *  hosts (localhost, 127.x, bare hostnames) do NOT use wildcard tenant routing,
 *  so an unset DOMAIN_REGEX is fine there — keep `pnpm check` green in dev. */
export function isProductionDomain(domain) {
  if (!domain) return false
  const d = String(domain).trim().toLowerCase()
  if (d === '' || d === 'localhost') return false
  if (d.startsWith('127.') || d === '::1' || d === '[::1]') return false
  // A real public domain has at least two dot-separated labels (example.com).
  return d.includes('.') && d.split('.').filter(Boolean).length >= 2
}

/** Renders the prod overlay with the given extra env merged over process.env.
 *  Returns { skip } when docker is unavailable, { ok:false } on a render/parse
 *  error, else { labelsByService } mapping service -> {label: value}. */
function renderProd(extraEnv) {
  const res = spawnSync('docker', ['compose', ...PROD_ARGS, 'config', '--format', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  })
  if (res.error && res.error.code === 'ENOENT') {
    return { skip: true, reason: 'docker not found on PATH' }
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toString()
    if (/cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
      return { skip: true, reason: 'docker daemon not reachable' }
    }
    return { ok: false, reason: `docker compose config failed: ${stderr.trim()}` }
  }
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (err) {
    return { ok: false, reason: `could not parse config JSON: ${err.message}` }
  }
  const out = {}
  for (const [name, svc] of Object.entries(parsed?.services ?? {})) {
    if (svc?.labels && typeof svc.labels === 'object') out[name] = svc.labels
  }
  return { labelsByService: out }
}

/** Pulls every wildcard router rule out of a labelsByService map (a label may
 *  live on any service: gremion-ui/keycloak/legal/fallback). */
function collectWildcardRules(labelsByService) {
  const rules = []
  for (const labels of Object.values(labelsByService)) {
    for (const want of WILDCARD_RULE_LABELS) {
      if (typeof labels[want] === 'string') rules.push({ label: want, rule: labels[want] })
    }
  }
  return rules
}

function main() {
  // (1) WIRING probe: a real domain + non-empty DOMAIN_REGEX => no leg collapses.
  const wiring = renderProd({ DOMAIN: 'wildcard-probe.example', DOMAIN_REGEX: 'wildcard-probe\\.example' })
  if (wiring.skip) {
    console.warn(`[domain-regex] SKIP: ${wiring.reason} — cannot verify the wildcard router wiring.`)
    console.warn('[domain-regex] SKIPPED — docker unavailable; DOMAIN_REGEX wiring NOT verified (re-run with docker up).')
    process.exit(0)
  }
  if (wiring.ok === false) {
    console.error(`[domain-regex] ERROR (wiring render): ${wiring.reason}`)
    process.exit(1)
  }
  const wiringRules = collectWildcardRules(wiring.labelsByService)
  const failures = []
  if (wiringRules.length < WILDCARD_RULE_LABELS.length) {
    failures.push(
      `expected ${WILDCARD_RULE_LABELS.length} wildcard router rules, found ${wiringRules.length} ` +
        '(a wildcard edge leg may have been removed/renamed)',
    )
  }
  for (const { label, rule } of wiringRules) {
    if (isCollapsedWildcard(rule)) {
      failures.push(
        `${label} collapsed to the dead pattern WITH a non-empty DOMAIN_REGEX — the leg is no ` +
          `longer driven by \${DOMAIN_REGEX} (tenant subdomains would 404). rule=${rule}`,
      )
    }
  }

  // (2) CANARY probe: empty DOMAIN_REGEX => EVERY wildcard leg must collapse.
  // This pins the exact failure signature documented in the runbook.
  const canary = renderProd({ DOMAIN: 'wildcard-probe.example', DOMAIN_REGEX: '' })
  if (canary.ok === false) {
    failures.push(`canary render failed: ${canary.reason}`)
  } else if (canary.labelsByService) {
    for (const { label, rule } of collectWildcardRules(canary.labelsByService)) {
      if (!isCollapsedWildcard(rule)) {
        failures.push(
          `${label} did NOT collapse with an EMPTY DOMAIN_REGEX — the dead-pattern detector or ` +
            `the \${DOMAIN_REGEX:-} default no longer matches; the deploy guard would miss an omission. rule=${rule}`,
        )
      }
    }
  }

  // (3) DEPLOY GUARD on the ambient .env: a real prod DOMAIN demands DOMAIN_REGEX.
  const ambientDomain = process.env.DOMAIN
  if (isProductionDomain(ambientDomain)) {
    const ambient = renderProd({})
    if (ambient.ok === false) {
      failures.push(`ambient render failed: ${ambient.reason}`)
    } else if (ambient.labelsByService) {
      const collapsed = collectWildcardRules(ambient.labelsByService).filter((r) => isCollapsedWildcard(r.rule))
      if (collapsed.length > 0) {
        failures.push(
          `DOMAIN='${ambientDomain}' is a production domain but DOMAIN_REGEX is unset/empty in the ambient ` +
            `environment — ${collapsed.length} wildcard router(s) collapsed to the dead pattern, so tenant ` +
            "subdomains will 404 at Traefik. Set DOMAIN_REGEX in .env to the regexp-escaped DOMAIN " +
            `(e.g. DOMAIN=council.example -> DOMAIN_REGEX=council\\.example). See docs/runbooks/tenant-edge.md S4 step 0a.`,
        )
      }
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`[domain-regex] FAIL: ${f}`)
    console.error(
      `[domain-regex] FAIL: ${failures.length} wildcard-router DOMAIN_REGEX issue(s). ` +
        'The T2 tenant wildcard edge routers depend on a regexp-escaped DOMAIN_REGEX; ' +
        'see docs/runbooks/tenant-edge.md.',
    )
    process.exit(1)
  }
  console.info(
    `[domain-regex] OK — all ${WILDCARD_RULE_LABELS.length} wildcard routers embed DOMAIN_REGEX (wiring + canary verified)` +
      (isProductionDomain(ambientDomain) ? `; ambient DOMAIN='${ambientDomain}' has a non-empty DOMAIN_REGEX` : ''),
  )
  process.exit(0)
}

// Only run main() when invoked as a script (not when a unit test imports the
// exported helpers) — matches check-tenant-env-guard.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
