// TASK-041 (L3-08; PRD-PLAT-012, TRD-074/075/076): the edge host-model guard.
//
//   node scripts/check-edge-host-model.mjs          # scan the tracked tree
//   node --test scripts/check-edge-host-model.test.mjs
//   make lint-edge-host                              # the suite, count-checked
//
// Under Tenancy D1 a request is resolved by its WHOLE host (tenant_domain.host,
// a PRIMARY KEY). The wildcard edge that fed the leftmost-label resolver is
// gone, and this guard keeps every piece of it from coming back:
//
//   R1   a HostRegexp leg in a router rule (compose labels, file-provider
//        `rule:` keys). A wildcard router hands the app hosts no tenant
//        registered; the only survivors are the two loopback test routers on
//        `internaltest`, pinned BY VALUE below.
//   R2a  `${DOMAIN_REGEX` or `DOMAIN_REGEX=` anywhere tracked: the env key that
//        drove the wildcard leg.
//   R2b  a bare DOMAIN_REGEX mention in the operator-facing surfaces (env
//        templates, compose, the edge config, KNOWN_ISSUES.md, docs).
//   R3   the apex host-injection middleware (`apexhost`, or an injected
//        `X-Forwarded-Host=default.`): it delivered the default tenant on the
//        apex, which TRD-075 forbids.
//   R4   the leftmost-label extractor's name in live code, config and docs.
//
// Every exemption carries its reason, and an exemption that matches no tracked
// file FAILS: a stale carve-out is a hole with a comment on it. Every rule must
// scan at least one file and parse at least one thing, and the rule table must
// not be empty: a guard that looked at nothing reports RED, never GREEN.
//
// PURE apart from `listTrackedFiles` / `readRel`, so the test drives the same
// code against the RED fixtures in test/host/fixtures/edge-host-model/.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The guard's own files may quote what they forbid. */
export const GUARD_OWN_FILES = ['scripts/check-edge-host-model.mjs', 'scripts/check-edge-host-model.test.mjs']
/** The RED fixtures: each one exists to violate a rule. */
export const FIXTURE_GLOB = 'test/host/fixtures/edge-host-model/**'

const COMPOSE_GLOBS = ['**/docker-compose*.yml', '**/docker-compose*.yaml']
const EDGE_CONFIG_GLOBS = ['docker/traefik/**', 'infra/host/templates/edge/**']
const ENV_GLOBS = ['**/.env*']

const REASON = {
  fixtures: 'RED fixtures of this guard: each file exists to violate a rule',
  guard: 'the guard quotes the patterns it forbids',
  k8s: 'k8s trees are frozen for deletion (decision-log D16); residual #431 (TASK-041 Q5)',
  superpowers: 'spec history under docs/superpowers is a record, not an instruction',
  migrations: 'migrations are hash-pinned (scripts/verify/suites/migration-hash.mjs) and describe history',
}

// The concatenations keep this file's own source from carrying the literal
// tokens it hunts, so a grep over the tree finds the rule table only by name.
const KEY = 'DOMAIN' + '_REGEX'
const EXTRACTOR = 'extract' + 'LeftmostLabel'

/**
 * The rule table. `scope` globs select tracked files; `exempt` globs carve them
 * out again, each with its reason. R1 additionally pins individual routers.
 */
export const RULES = Object.freeze([
  {
    id: 'R1',
    what: 'HostRegexp leg in an edge router rule',
    kind: 'router',
    scope: [...COMPOSE_GLOBS, ...EDGE_CONFIG_GLOBS],
    exempt: [{ glob: FIXTURE_GLOB, reason: REASON.fixtures }],
    routerExempt: [
      {
        file: 'infra/host/templates/edge/active.yml.tmpl',
        router: 'test-app',
        entryPoints: ['internaltest'],
        rule: 'HostRegexp(`.+`)',
        reason:
          'loopback-only verification router for the INACTIVE colour; internaltest is published on 127.0.0.1 only (TASK-022 guard 1, spec A F.4.10; TASK-041 Q4)',
      },
      {
        file: 'infra/host/templates/edge/active.yml.tmpl',
        router: 'test-public',
        entryPoints: ['internaltest'],
        rule: 'HostRegexp(`.+`) && PathPrefix(`/portal`)',
        reason:
          'loopback-only verification router for the INACTIVE public colour; internaltest is published on 127.0.0.1 only (TASK-022 guard 1, spec A F.4.10; TASK-041 Q4)',
      },
    ],
  },
  {
    id: 'R2a',
    what: `\${${KEY} or ${KEY}= (the wildcard-leg env key)`,
    kind: 'text',
    pattern: new RegExp(`\\$\\{${KEY}|${KEY}=`),
    scope: ['**'],
    exempt: [
      { glob: 'k8s/**', reason: REASON.k8s },
      { glob: 'docs/superpowers/**', reason: REASON.superpowers },
      { glob: '**/migrations*/**', reason: REASON.migrations },
      ...GUARD_OWN_FILES.map((glob) => ({ glob, reason: REASON.guard })),
      { glob: FIXTURE_GLOB, reason: REASON.fixtures },
    ],
  },
  {
    id: 'R2b',
    what: `bare ${KEY} in an operator-facing surface`,
    kind: 'text',
    pattern: new RegExp(KEY),
    scope: [
      ...ENV_GLOBS,
      ...COMPOSE_GLOBS,
      'docker/traefik/**',
      'infra/host/templates/**',
      'KNOWN_ISSUES.md',
      'docs/**',
    ],
    exempt: [
      { glob: 'docs/superpowers/**', reason: REASON.superpowers },
      { glob: FIXTURE_GLOB, reason: REASON.fixtures },
    ],
  },
  {
    id: 'R3',
    what: 'apex host injection (apexhost middleware / X-Forwarded-Host=default.)',
    kind: 'text',
    pattern: /X-Forwarded-Host=default\.|apexhost/i,
    scope: [...COMPOSE_GLOBS, ...EDGE_CONFIG_GLOBS, ...ENV_GLOBS],
    exempt: [{ glob: FIXTURE_GLOB, reason: REASON.fixtures }],
  },
  {
    id: 'R4',
    what: `${EXTRACTOR} (the leftmost-label resolver)`,
    kind: 'text',
    pattern: new RegExp(EXTRACTOR),
    scope: [
      'gremion-ui/src/**',
      'gremion-public/src/**',
      'packages/**',
      'scripts/**',
      '.github/**',
      'gremion-ui/playwright.config.ts',
      ...COMPOSE_GLOBS,
      'docs/**',
    ],
    exempt: [
      { glob: 'docs/superpowers/**', reason: REASON.superpowers },
      { glob: '**/migrations*/**', reason: REASON.migrations + ' (004_tenant_domain.sql:4)' },
      { glob: 'k8s/**', reason: REASON.k8s },
      ...GUARD_OWN_FILES.map((glob) => ({ glob, reason: REASON.guard })),
    ],
  },
])

// ── globs ──────────────────────────────────────────────────────────────────

const globCache = new Map()
/** `**` spans directories (and may be empty), `*` stays inside one segment. */
export function globToRegExp(glob) {
  let re = globCache.get(glob)
  if (re) return re
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  re = new RegExp(`^${out}$`)
  globCache.set(glob, re)
  return re
}

export const matchesAny = (rel, globs) => globs.some((g) => globToRegExp(g).test(rel))

// ── the tree ─────────────────────────────────────────────────────────────────

/** Tracked files of the repository at `root`, repo-relative, forward slashes. */
export function listTrackedFiles(root = REPO_ROOT) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
}

/** Every file under `dir`, relative to it — how a fixture tree is listed. */
export function listDirFiles(dir) {
  const out = []
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = path.join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(a).isDirectory()) walk(a, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

// ── R1: router rules ─────────────────────────────────────────────────────────

const ROUTER_RULE_LABEL = /^traefik\.http\.routers\.([^.]+)\.rule$/i
const ROUTER_EP_LABEL = /^traefik\.http\.routers\.([^.]+)\.entrypoints$/i
const HOSTREGEXP = /hostregexp\s*\(/i

function labelPairs(labels) {
  if (Array.isArray(labels)) {
    return labels
      .filter((l) => typeof l === 'string')
      .map((l) => {
        const eq = l.indexOf('=')
        return eq === -1 ? [l.trim(), ''] : [l.slice(0, eq).trim(), l.slice(eq + 1)]
      })
  }
  if (labels && typeof labels === 'object') return Object.entries(labels).map(([k, v]) => [k, String(v ?? '')])
  return []
}

/**
 * Every router rule a file declares: compose labels on services (and their
 * deploy block), and file-provider `http.routers.<name>.rule` keys.
 * Returns `{ routers, error }`; a file in scope that cannot be parsed is an
 * error, never a silent zero.
 */
export function routersIn(text, rel) {
  const routers = []
  const isYaml = /\.(ya?ml|tmpl)$/i.test(rel)
  if (!isYaml) {
    // Not YAML: fall back to a line scan of anything shaped like a rule, so an
    // unexpected format is looked at rather than skipped.
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return
      if (/\brule\b/i.test(line)) routers.push({ router: `line ${i + 1}`, rule: line.trim(), entryPoints: [] })
    })
    return { routers, error: null }
  }
  let doc
  try {
    doc = parseYaml(text, { merge: true, uniqueKeys: false })
  } catch (err) {
    return { routers, error: `unparseable YAML: ${err.message.split('\n')[0]}` }
  }
  if (!doc || typeof doc !== 'object') return { routers, error: null }
  if (doc.services && typeof doc.services === 'object') {
    for (const svc of Object.values(doc.services)) {
      if (!svc || typeof svc !== 'object') continue
      const pairs = [...labelPairs(svc.labels), ...labelPairs(svc.deploy?.labels)]
      const eps = new Map()
      for (const [k, v] of pairs) {
        const m = ROUTER_EP_LABEL.exec(k)
        if (m) eps.set(m[1], v.split(',').map((s) => s.trim()).filter(Boolean))
      }
      for (const [k, v] of pairs) {
        const m = ROUTER_RULE_LABEL.exec(k)
        if (m) routers.push({ router: m[1], rule: v, entryPoints: eps.get(m[1]) ?? [] })
      }
    }
  }
  for (const proto of ['http', 'tcp', 'udp']) {
    const block = doc[proto]?.routers
    if (!block || typeof block !== 'object') continue
    for (const [name, r] of Object.entries(block)) {
      if (!r || typeof r !== 'object') continue
      if (typeof r.rule === 'string') {
        const eps = Array.isArray(r.entryPoints) ? r.entryPoints.map(String) : []
        routers.push({ router: name, rule: r.rule, entryPoints: eps })
      }
    }
  }
  return { routers, error: null }
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

function routerExemptionFor(rule, rel, r) {
  return (rule.routerExempt ?? []).find(
    (e) => e.file === rel && e.router === r.router && sameList(e.entryPoints, r.entryPoints) && e.rule === r.rule,
  )
}

// ── the scan ─────────────────────────────────────────────────────────────────

/**
 * Scan `files` (repo-relative) under `root` with `rules`.
 *
 * @returns {{ findings: {rule:string,file:string,line?:number,detail:string}[],
 *             stats: Record<string,{files:number,parsed:number}>,
 *             stale: {rule:string,exemption:string}[],
 *             vacuous: string[] }}
 */
export function scan({ root = REPO_ROOT, files, rules = RULES, read } = {}) {
  const readRel = read ?? ((rel) => readFileSync(path.join(root, rel), 'utf8'))
  const findings = []
  const stats = {}
  const stale = []
  const vacuous = []

  if (!Array.isArray(rules) || rules.length === 0) vacuous.push('the rule table is empty: nothing would be checked')
  if (!Array.isArray(files) || files.length === 0) vacuous.push('the scan root lists no files')
  const all = Array.isArray(files) ? files : []

  const textCache = new Map()
  const textOf = (rel) => {
    if (!textCache.has(rel)) {
      let t
      try {
        t = readRel(rel)
      } catch {
        t = null // a tracked file deleted in the working tree
      }
      textCache.set(rel, t)
    }
    return textCache.get(rel)
  }

  for (const rule of rules ?? []) {
    const exemptGlobs = (rule.exempt ?? []).map((e) => e.glob)
    // An exemption that matches no tracked file is stale.
    for (const e of rule.exempt ?? []) {
      if (!all.some((f) => globToRegExp(e.glob).test(f))) stale.push({ rule: rule.id, exemption: e.glob })
    }
    for (const e of rule.routerExempt ?? []) {
      if (!all.includes(e.file)) stale.push({ rule: rule.id, exemption: `${e.file}#${e.router}` })
    }

    const inScope = all.filter((f) => matchesAny(f, rule.scope) && !matchesAny(f, exemptGlobs))
    const st = { files: 0, parsed: 0 }
    const usedRouterExemptions = new Set()

    for (const rel of inScope) {
      const text = textOf(rel)
      if (text === null) continue
      st.files++
      if (rule.kind === 'router') {
        const { routers, error } = routersIn(text, rel)
        if (error) {
          findings.push({ rule: rule.id, file: rel, detail: `could not look: ${error}` })
          continue
        }
        st.parsed += routers.length
        for (const r of routers) {
          if (!HOSTREGEXP.test(r.rule)) continue
          const ex = routerExemptionFor(rule, rel, r)
          if (ex) {
            usedRouterExemptions.add(`${ex.file}#${ex.router}`)
            continue
          }
          findings.push({
            rule: rule.id,
            file: rel,
            detail: `router '${r.router}' on [${r.entryPoints.join(',')}] has a HostRegexp leg: ${r.rule}`,
          })
        }
      } else {
        const lines = text.split('\n')
        st.parsed += lines.length
        lines.forEach((line, i) => {
          if (rule.pattern.test(line)) {
            findings.push({ rule: rule.id, file: rel, line: i + 1, detail: line.trim().slice(0, 200) })
          }
        })
      }
    }

    // A pinned router that no longer exists (or no longer matches its pinned
    // value) is a stale exemption too — only when its file was in scope, so the
    // missing-file case above is not reported twice.
    for (const e of rule.routerExempt ?? []) {
      const key = `${e.file}#${e.router}`
      if (all.includes(e.file) && !usedRouterExemptions.has(key)) stale.push({ rule: rule.id, exemption: key })
    }

    if (st.files === 0) vacuous.push(`${rule.id}: no file in scope`)
    else if (st.parsed === 0) vacuous.push(`${rule.id}: ${rule.kind === 'router' ? 'no router rule' : 'no line'} parsed`)
    stats[rule.id] = st
  }

  return { findings, stats, stale, vacuous }
}

export const isClean = (res) => res.findings.length === 0 && res.stale.length === 0 && res.vacuous.length === 0

export function formatReport(res) {
  const out = []
  for (const f of res.findings) out.push(`  ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}`)
  for (const s of res.stale) out.push(`  ${s.rule} stale exemption (matches nothing tracked): ${s.exemption}`)
  for (const v of res.vacuous) out.push(`  vacuous: ${v}`)
  return out.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = scan({ files: listTrackedFiles() })
  const counts = Object.entries(res.stats)
    .map(([id, s]) => `${id} ${s.files} files/${s.parsed} parsed`)
    .join(', ')
  if (isClean(res)) {
    console.log(`[edge-host-model] OK — ${counts}`)
  } else {
    console.error(`[edge-host-model] FAIL — ${counts}\n${formatReport(res)}`)
    process.exit(1)
  }
}
