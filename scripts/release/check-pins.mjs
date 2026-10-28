#!/usr/bin/env node
// check-pins — a release pins layer (docker-compose.pins.yml) is complete and
// digest-only, judged by the SAME assertions gremion-deploy makes at step 2
// (Release-1 B35 check-pins, adapted by TASK-046).
//
// The regexes are not restated here: deployPinRegexes() re-reads them out of
// infra/host/bin/gremion-deploy's validate_release_tree and converts the POSIX
// classes, so the workstation check and the host check cannot drift. A pattern
// that can no longer be found fails loudly — there is no fallback copy.
//
// On top of what the host asserts, this check requires the full
// `@sha256:<64 hex>` form and completeness against the expected service set:
// every expected service pinned, no unexpected service. The expected set is
// DERIVED, never listed (TASK-048b, Q1): --project state|app reads COMPOSE_FILE
// out of the project's env template and takes every service that declares
// `build:` at its own indent in any of those files (the pins slot, basename
// docker-compose*pins.yml, excluded). A service line in any non-plain spelling
// is refused, a merge key contributes its anchor's build:, a later file's
// `build: !reset null` removes the service, and zero derived services FAILS.
// --services a,b,c states the set by hand (tests, rehearsals); with neither it
// FAILS. The render arm (check-image-digests.mjs --render) cross-checks this
// derivation against docker's own render.
//
// Run:  node scripts/release/check-pins.mjs <pins.yml> (--project state|app | --services a,b,c)
// Test: node --test scripts/release/b35-adapts.test.mjs

import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEnvKey } from '../verify/census/render.mjs'

const posix = (s) => s.replace(/\[:space:\]/g, '\\s').replace(/\[\[:space:\]\]/g, '\\s')

function bodyOf(src, fn) {
  const start = src.indexOf(`\n${fn}() {`)
  if (start < 0) throw new Error(`gremion-deploy: function ${fn} not found`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}

/** The pin assertions gremion-deploy makes, as JS RegExps, read from its source. */
export function deployPinRegexes(deployPath) {
  const body = bodyOf(readFileSync(deployPath, 'utf8'), 'validate_release_tree').replace(/'\\''/g, "'")
  const greps = [...body.matchAll(/grep (-v?E|-v) '([^\n]*?)'(?= |\)|$)/gm)].map((m) => ({ flag: m[1], pat: m[2] }))
  const find = (what, pred) => {
    const hits = greps.filter(pred)
    if (!hits.length) throw new Error(`gremion-deploy validate_release_tree: cannot find the ${what} pattern — check-pins refuses to guess`)
    // TASK-048b: both pins layers are judged by ONE grep set inside a loop. A
    // second copy of a pattern means a layer judged by its own copy, which is
    // how the two files drift apart: refused, whatever the copies say.
    if (hits.length > 1) throw new Error(`gremion-deploy validate_release_tree: the ${what} pattern occurs ${hits.length} times — one grep set must judge both pins layers`)
    return new RegExp(posix(hits[0].pat))
  }
  return {
    imageLine: find('image-line', (g) => g.flag === '-E' && /image:'?$/.test(g.pat + "'") && !g.pat.includes('gremion/')),
    digest: find('digest', (g) => g.flag === '-v' && g.pat === '@sha256:'),
    thirdPartyNamespace: find('gremion/ namespace', (g) => g.flag === '-E' && g.pat.includes('gremion/')),
    buildLine: find('build-line', (g) => g.flag === '-E' && g.pat.endsWith('build:')),
    buildReset: find('build !reset', (g) => g.flag === '-vE' && g.pat.includes('!reset')),
  }
}

const DEPLOY = fileURLToPath(new URL('../../infra/host/bin/gremion-deploy', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FULL_DIGEST = /@sha256:[0-9a-f]{64}["']?\s*$/

/** service -> {image, build} from a PINS file (two-space service indent); never used on a
 * compose file, whose networks:/volumes: keys it would count as services. */
export function servicesOf(text) {
  const out = new Map()
  let cur = null
  for (const line of text.split('\n')) {
    const s = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (s) {
      cur = { image: null, imageLine: null, buildLine: null }
      out.set(s[1], cur)
      continue
    }
    if (!cur || !/^ {4}\S/.test(line)) continue
    if (/^\s*image:/.test(line)) {
      cur.imageLine = line
      cur.image = line.replace(/^\s*image:\s*/, '').replace(/^["']|["']$/g, '')
    }
    if (/^\s*build:/.test(line)) cur.buildLine = line
  }
  return out
}

// ── the expected set, derived from `build:` (TASK-048b, Q1) ────────────────

/** The env template whose COMPOSE_FILE defines each release project's files. */
export const PROJECT_TEMPLATES = Object.freeze({
  state: 'infra/host/templates/env/state.env.tmpl',
  app: 'infra/host/templates/env/app.env.tmpl',
})
/** The pins layer each project reads (the pins slot of its COMPOSE_FILE). */
export const PINS_FILES = Object.freeze({ state: 'docker-compose.state-pins.yml', app: 'docker-compose.pins.yml' })
/** A COMPOSE_FILE entry whose basename is docker-compose*pins.yml is the pins slot. */
export const isPinsSlot = (entry) => /^docker-compose.*pins\.yml$/.test(basename(entry))

// An explicit reset only: an empty value opens a nested build: block.
const NOT_A_BUILD = /^(?:!reset(?:\s+null)?|null|~)\s*(#.*)?$/
const PLAIN_SERVICE = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(#.*)?$/

/**
 * service -> true (declares a real build:) | false (resets it) for every
 * service of one compose file that touches build:, in file order. Strict: a
 * service line under services: in any other spelling (anchor, quoted key,
 * flow map) and a quoted build key throw, since either would silently shrink
 * the set. `<<: *anchor` contributes the anchor's top-level build:.
 */
export function buildServicesOf(text, label) {
  const lines = text.split(/\r?\n/)
  // anchors of top-level blocks (x-foo: &name) and whether they carry build:
  // Shapes a line reader cannot follow are refused outright: a second YAML
  // document, a services: key in any spelling but the plain block, tabs.
  for (const [i, l] of lines.entries()) {
    if (l.startsWith('---') && i > 0) throw new Error(`${label}:${i + 1}: a second YAML document -- this check cannot follow it`)
    if (/^["']services["']\s*:|^services\s*:\s*[^\s#]/.test(l)) throw new Error(`${label}:${i + 1}: services: is not a plain block: ${l.trim()}`)
    if (/^\s*\t/.test(l)) throw new Error(`${label}:${i + 1}: tab indentation`)
  }
  const anchors = new Map()
  let anchor = null
  for (const [i, l] of lines.entries()) {
    const top = /^[A-Za-z0-9_.-]+:\s*&([A-Za-z0-9_-]+)\s*(#.*)?$/.exec(l)
    if (top) {
      anchor = top[1]
      anchors.set(anchor, false)
      continue
    }
    if (/^\S/.test(l) && !l.startsWith('#')) anchor = null
    else if (anchor && /^ {2}<</.test(l)) throw new Error(`${label}:${i + 1}: merge key inside anchor &${anchor} -- this check does not follow chained merges`)
    else if (anchor && /^ {2}build\s*:/.test(l)) anchors.set(anchor, !NOT_A_BUILD.test(l.replace(/^ {2}build\s*:\s*/, '')))
  }
  const out = new Map()
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l))
  if (start < 0) return out
  let cur = null
  for (const [i, l] of lines.slice(start + 1).entries()) {
    const where = `${label}:${start + i + 2}`
    if (/^\S/.test(l) && !l.startsWith('#')) break
    if (!l.trim() || /^\s*#/.test(l)) continue
    if (/^ {2}\S/.test(l)) {
      const m = PLAIN_SERVICE.exec(l)
      if (!m) throw new Error(`${where}: not a plain service line under services: ${l.trim()}`)
      cur = m[1]
      continue
    }
    // a service must sit at exactly two spaces: anything deeper before the
    // first service, or at one or three spaces, is a layout this reader
    // would otherwise skip
    if (!cur || /^ (?: {2})?\S/.test(l)) throw new Error(`${where}: not a two-space service layout: ${l.trimEnd()}`)
    if (!/^ {4}\S/.test(l)) continue
    if (/^ {4}["']build["']\s*:/.test(l)) throw new Error(`${where}: quoted build key: ${l.trim()}`)
    if (/^ {4}extends\s*:/.test(l)) throw new Error(`${where}: extends: -- this check cannot follow it`)
    const b = /^ {4}build\s*:\s*(.*)$/.exec(l)
    if (b) out.set(cur, !NOT_A_BUILD.test(b[1]))
    const merge = /^ {4}<<\s*:\s*\*([A-Za-z0-9_-]+)\s*(#.*)?$/.exec(l)
    if (merge) {
      if (!anchors.has(merge[1])) throw new Error(`${where}: merge key names an unknown anchor *${merge[1]}`)
      if (anchors.get(merge[1]) && !out.has(cur)) out.set(cur, true)
    } else if (/^ {4}<</.test(l)) {
      throw new Error(`${where}: merge key in a form this check cannot follow: ${l.trim()}`)
    }
  }
  return out
}

/**
 * The expected pins set of a release project: every service that builds, over
 * the project's template COMPOSE_FILE entries (the pins slot excluded), a
 * later file's build: winning. Zero services, an unreadable file or a template
 * without COMPOSE_FILE throw.
 */
export function derivedServices(project, { root = REPO_ROOT, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  // own keys only: `constructor`, `toString`, ... are truthy prototype members
  if (!Object.hasOwn(PROJECT_TEMPLATES, project)) throw new Error(`unknown project ${project} (want ${Object.keys(PROJECT_TEMPLATES).join('|')})`)
  const tmpl = PROJECT_TEMPLATES[project]
  const composeFile = readEnvKey(readText(join(root, tmpl)), 'COMPOSE_FILE')
  if (!composeFile) throw new Error(`${tmpl} declares no COMPOSE_FILE`)
  const builds = new Map()
  const order = [] // file order of first appearance, not of the last override
  for (const entry of composeFile.split(':').map((e) => e.trim()).filter(Boolean)) {
    if (isPinsSlot(entry)) {
      // only the two release layers are skipped: any other *pins.yml name
      // would silently leave a compose file out of the derivation
      if (!Object.values(PINS_FILES).includes(basename(entry))) throw new Error(`${tmpl}: ${entry} is not a release pins layer (${Object.values(PINS_FILES).join(', ')})`)
      continue
    }
    let text
    try {
      text = readText(join(root, entry))
    } catch (err) {
      throw new Error(`${tmpl} lists ${entry}, which cannot be read: ${err.message}`)
    }
    for (const [svc, b] of buildServicesOf(text, entry)) {
      builds.set(svc, b)
      if (!order.includes(svc)) order.push(svc)
    }
  }
  const out = order.filter((s) => builds.get(s))
  if (!out.length) throw new Error(`${tmpl}: COMPOSE_FILE ${composeFile} derives no build: service (refusing a vacuous set)`)
  return out
}

export function checkPins(text, { services, deployPath = DEPLOY } = {}) {
  const re = deployPinRegexes(deployPath)
  const problems = []
  const add = (code, message) => problems.push({ code, message })
  const lines = text.split('\n')
  const imageLines = lines.filter((l) => re.imageLine.test(l))
  if (!imageLines.length) add('no-images', 'the pins layer pins no images')
  for (const l of imageLines) {
    if (!re.digest.test(l) || !FULL_DIGEST.test(l)) add('unpinned', `not @sha256:<64 hex>: ${l.trim()}`)
    if (re.thirdPartyNamespace.test(l)) add('third-party-namespace', `third-party gremion/ namespace: ${l.trim()}`)
  }
  for (const l of lines.filter((x) => re.buildLine.test(x))) {
    if (!re.buildReset.test(l)) add('real-build', `a real build: key (no build in production): ${l.trim()}`)
  }
  if (!Array.isArray(services) || !services.length) {
    add('no-service-list', 'no expected service set (neither --project nor --services)')
    return problems
  }
  const got = servicesOf(text)
  for (const s of services) if (!got.get(s)?.image) add('incomplete', `service ${s} has no pinned image`)
  for (const s of got.keys()) if (!services.includes(s)) add('unexpected-service', `service ${s} is pinned but not expected`)
  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (f) => {
    const i = process.argv.indexOf(f)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const pins = process.argv[2]
  // --project and --services are alternatives: both given is a usage error
  // (exit 2), never one silently dropped (emit-pins refuses its mix the same way)
  if (!pins || pins.startsWith('--') || (process.argv.includes('--project') && process.argv.includes('--services'))) {
    console.error('usage: check-pins.mjs <pins.yml> (--project state|app | --services a,b,c)')
    process.exit(2)
  }
  let services
  try {
    services = process.argv.includes('--project') ? derivedServices(arg('--project')) : arg('--services')?.split(',').filter(Boolean)
  } catch (err) {
    console.error(`check-pins: FAIL derive: ${err.message}`)
    process.exit(1)
  }
  const ps = checkPins(readFileSync(pins, 'utf8'), { services })
  for (const p of ps) console.error(`check-pins: FAIL ${p.code}: ${p.message}`)
  console.log(`check-pins: ${ps.length} problem(s)`)
  process.exit(ps.length ? 1 : 0)
}
