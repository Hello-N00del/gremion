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
// every expected service pinned, no unexpected service. The expected set comes
// from the app compose file (docker-compose.app.yml is spec B / B14 and absent
// on this base — TODO(TASK-040)) or from --services; with neither it FAILS.
//
// Run:  node scripts/release/check-pins.mjs <pins.yml> (--app-compose FILE | --services a,b,c)
// Test: node --test scripts/release/b35-adapts.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
    const g = greps.find(pred)
    if (!g) throw new Error(`gremion-deploy validate_release_tree: cannot find the ${what} pattern — check-pins refuses to guess`)
    return new RegExp(posix(g.pat))
  }
  return {
    imageLine: find('image-line', (g) => g.flag === '-E' && /image:'?$/.test(g.pat + "'") && !g.pat.includes('gremion/')),
    digest: find('digest', (g) => g.flag === '-v' && g.pat === '@sha256:'),
    thirdPartyNamespace: find('gremion/ namespace', (g) => g.flag === '-E' && g.pat.includes('gremion/')),
    buildLine: find('build-line', (g) => g.flag === '-E' && /build:$/.test(g.pat)),
    buildReset: find('build !reset', (g) => g.flag === '-vE' && g.pat.includes('!reset')),
  }
}

const DEPLOY = fileURLToPath(new URL('../../infra/host/bin/gremion-deploy', import.meta.url))
const FULL_DIGEST = /@sha256:[0-9a-f]{64}["']?\s*$/

/** service -> {image, build} from a compose-shaped pins file (two-space service indent). */
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
    add('no-service-list', 'no expected service set (docker-compose.app.yml absent — TODO(TASK-040) — and no --services)')
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
  if (!pins || pins.startsWith('--')) {
    console.error('usage: check-pins.mjs <pins.yml> (--app-compose FILE | --services a,b,c)')
    process.exit(2)
  }
  let services = arg('--services')?.split(',').filter(Boolean)
  if (arg('--app-compose')) services = [...servicesOf(readFileSync(arg('--app-compose'), 'utf8')).keys()]
  const ps = checkPins(readFileSync(pins, 'utf8'), { services })
  for (const p of ps) console.error(`check-pins: FAIL ${p.code}: ${p.message}`)
  console.log(`check-pins: ${ps.length} problem(s)`)
  process.exit(ps.length ? 1 : 0)
}
