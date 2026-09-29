#!/usr/bin/env node
// emit-pins — write a release pins layer from the digests a release pushed
// (TASK-048, Q3; TRD-350's "deployment manifest" is the rendered release:
// compose + the pins layers). TASK-048b splits the layer per project:
//   --project app   -> docker-compose.pins.yml        (app-<colour> projects)
//   --project state -> docker-compose.state-pins.yml  (the state project)
//
// Input: one `service=<repo>@sha256:<64 hex>` per line (blank lines and `#`
// comments ignored), on stdin or --in FILE: ONE record for the whole release.
// With --project, the expected set is check-pins' derived set for that
// project (every service with `build:` in the project's COMPOSE_FILE files);
// the record is partitioned by the two derived sets, and a line whose service
// is in neither project is refused. Every expected service must be pinned
// exactly once. Each service gets `build: !reset null` (no build in
// production) and its digest `image:`. --app-compose FILE (TASK-048) remains
// for the app layer: the expected set is that file's services: block.
//
// The layer is judged by check-pins.mjs (whose regexes come out of
// gremion-deploy) against the project's set before anything is written: a
// layer check-pins refuses — an app service in the state layer, a state
// service in the app layer, a missing one — is never written, and the exit
// code is 1.
//
// Run:  node scripts/release/emit-pins.mjs --project state|app \
//         [--in pins.txt] [--out docker-compose.state-pins.yml|docker-compose.pins.yml]
//       node scripts/release/emit-pins.mjs --app-compose docker-compose.app.yml [--in …] [--out …]
//       (no --out: the layer goes to stdout)
// Test: node --test scripts/release/emit-pins.test.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { checkPins, derivedServices, PINS_FILES, PROJECT_TEMPLATES } from './check-pins.mjs'

const PIN_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)=([a-z0-9][a-z0-9._/-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64})$/

/** The service names of a compose file's top-level `services:` block, in file order. */
export function appServices(composeText) {
  const lines = composeText.split(/\r?\n/)
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l))
  if (start < 0) throw new Error('the app compose file has no top-level services: block')
  const out = []
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !l.startsWith('#')) break
    if (!/^ {2}\S/.test(l) || /^\s*#/.test(l)) continue
    // A service line in any other spelling (anchor, quoted key, flow map)
    // would silently shrink the expected set, so it is refused.
    const m = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(#.*)?$/.exec(l)
    if (!m) throw new Error(`not a plain service line under services: ${l.trim()}`)
    out.push(m[1])
  }
  if (!out.length) throw new Error('the app compose services: block names no service')
  return out
}

/** Map service -> digest ref from `svc=repo@sha256:...` lines. Throws on anything else. */
export function parsePinLines(text) {
  const pins = new Map()
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = PIN_LINE_RE.exec(line)
    if (!m) throw new Error(`line ${i + 1} is not svc=<repo>@sha256:<64 hex>: ${line}`)
    if (pins.has(m[1])) throw new Error(`duplicate service ${m[1]} (line ${i + 1})`)
    pins.set(m[1], m[2])
  }
  if (!pins.size) throw new Error('no pin lines on the input')
  return pins
}

export const FIRST_PARTY_PREFIX = 'ghcr.io/hello-n00del/'

/**
 * The pins of one release project out of the release's single record: the
 * services derived for `project`. A service derived for neither project is
 * refused (it would be silently dropped otherwise).
 */
export function selectProject(pins, project, { derive = derivedServices } = {}) {
  const sets = Object.fromEntries(Object.keys(PROJECT_TEMPLATES).map((p) => [p, derive(p)]))
  if (!sets[project]) throw new Error(`unknown project ${project} (want ${Object.keys(sets).join('|')})`)
  for (const svc of pins.keys()) {
    if (!Object.values(sets).some((set) => set.includes(svc))) throw new Error(`${svc} is in no release project (${Object.keys(sets).join(', ')})`)
  }
  return new Map([...pins].filter(([svc]) => sets[project].includes(svc)))
}

/** The pins layer text, in the expected service order; throws unless check-pins passes it. */
export function emitPins(pins, services, { firstPartyPrefix = FIRST_PARTY_PREFIX, project = 'app' } = {}) {
  // The app layer is first-party only: a pin outside the prefix is not
  // signature-verified by gremion-deploy, it is looked up as third-party.
  for (const [svc, ref] of pins) {
    if (!ref.startsWith(firstPartyPrefix)) throw new Error(`${svc}: ${ref} is not first-party (${firstPartyPrefix}*)`)
  }
  const order = [...services.filter((s) => pins.has(s)), ...[...pins.keys()].filter((s) => !services.includes(s))]
  const body = order.map((s) => `  ${s}:\n    build: !reset null\n    image: ${pins.get(s)}\n`).join('')
  if (!PINS_FILES[project]) throw new Error(`unknown project ${project}`)
  const text =
    `# ${PINS_FILES[project]}: the release pins layer (${project} services), written by\n` +
    '# scripts/release/emit-pins.mjs and judged by scripts/release/check-pins.mjs.\n' +
    `services:\n${body}`
  const problems = checkPins(text, { services })
  if (problems.length) throw new Error(problems.map((p) => `${p.code}: ${p.message}`).join('\n'))
  return text
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--project', '--app-compose', '--in', '--out'].includes(argv[i]) || argv[i + 1] === undefined) {
      opts.bad = true
      break
    }
    opts[argv[i]] = argv[i + 1]
  }
  const project = opts['--project']
  const compose = opts['--app-compose']
  if (opts.bad || !project === !compose) {
    console.error('usage: emit-pins.mjs (--project state|app | --app-compose FILE) [--in FILE] [--out FILE]')
    process.exit(2)
  }
  const arg = (f) => opts[f]
  try {
    const input = arg('--in') ? readFileSync(arg('--in'), 'utf8') : readFileSync(0, 'utf8')
    let services, pins
    if (project) {
      pins = selectProject(parsePinLines(input), project)
      services = derivedServices(project)
    } else {
      pins = parsePinLines(input)
      services = appServices(readFileSync(compose, 'utf8'))
    }
    const text = emitPins(pins, services, { project: project ?? 'app' })
    const out = arg('--out')
    if (out) {
      writeFileSync(`${out}.tmp`, text)
      renameSync(`${out}.tmp`, out)
      console.error(`emit-pins: ${services.length} service(s) pinned -> ${out}`)
    } else {
      process.stdout.write(text)
    }
  } catch (err) {
    for (const l of String(err.message).split('\n')) console.error(`emit-pins: FAIL ${l}`)
    process.exit(1)
  }
}
