#!/usr/bin/env node
// check-sbom — the SBOM half of `verify` (TASK-046, TRD-443, brief Q3/Q4).
//
// Always (Q4): a SOURCE SBOM of the committed root pnpm-lock.yaml, produced by
// the digest-pinned syft container (`dir:` over the lockfile alone).
// With --pins <docker-compose.pins.yml> --key <cosign.pub> (a release for
// HEAD): additionally, for every first-party pinned digest, the CycloneDX
// attestation must verify with THAT key (`cosign verify-attestation --type
// cyclonedx`), its subject must be the pinned digest, and its predicate is
// what gets checked.
//
// Every SBOM must be CycloneDX 1.6 with a non-empty components list, and FAILS
// on (Q3 — "the TRD-356 floor" is not a severity):
//   (a) any npm component below a floor in scripts/check-cve-floors.mjs
//       (the table is IMPORTED, never copied or edited), and
//   (b) any CRITICAL (TRD-102) grype match whose id (or a related id) is not
//       in scripts/verify/sbom/accepted.json (id, reason, date mandatory).
// A missing grype vulnerability DB is a FAIL (never "no findings").
//
// Run:  node scripts/verify/sbom/check-sbom.mjs [--pins FILE --key PUB] [--first-party PREFIX] [--grype-db-volume NAME] [--no-db-update]
// Test: node --test scripts/verify/sbom/

import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { FLOORS, compareVersions } from '../../check-cve-floors.mjs'
import { IMAGES } from '../../release/lib/tools.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
const p = (code, message) => ({ code, message })

// ── document checks ─────────────────────────────────────────────────────────

export function validateSbom(doc) {
  const out = []
  if (!doc || doc.bomFormat !== 'CycloneDX') out.push(p('bom-format', `bomFormat is ${JSON.stringify(doc?.bomFormat)}, want CycloneDX`))
  if (doc?.specVersion !== '1.6') out.push(p('spec-version', `specVersion is ${JSON.stringify(doc?.specVersion)}, want "1.6"`))
  if (!Array.isArray(doc?.components) || doc.components.length === 0) out.push(p('no-components', 'components is empty'))
  return out
}

/** npm name/version of a component, from its purl (authoritative) or name/version. */
function npmCoords(c) {
  const m = /^pkg:npm\/(.+)@([^@?#]+)/.exec(c?.purl ?? '')
  if (!m) return null
  return { name: decodeURIComponent(m[1]), version: m[2] }
}

export function floorProblems(doc, floors = FLOORS) {
  const out = []
  for (const c of doc?.components ?? []) {
    const co = npmCoords(c)
    if (!co) continue
    const f = floors.find((x) => x.name === co.name)
    if (!f) continue
    if (!/^\d+\.\d+\.\d+/.test(co.version)) {
      out.push(p('below-floor', `${co.name}@${co.version}: version not comparable to floor ${f.floor}`))
    } else if (compareVersions(co.version, f.floor) < 0) {
      out.push(p('below-floor', `${co.name}@${co.version} is below the cve floor ${f.floor} (${f.advisory})`))
    }
  }
  return out
}

export function loadAccepted(doc) {
  const entries = []
  const problems = []
  for (const e of doc?.accepted ?? []) {
    if (e && typeof e.id === 'string' && e.id && typeof e.reason === 'string' && e.reason.trim() && DATE_RE.test(e.date ?? '')) {
      entries.push(e)
    } else {
      problems.push(p('accepted-incomplete', `accepted.json entry needs id, reason and date (YYYY-MM-DD): ${JSON.stringify(e)}`))
    }
  }
  return { entries, problems }
}

export function criticalProblems(report, accepted) {
  const ok = new Set(accepted.map((a) => a.id))
  const out = []
  for (const m of report?.matches ?? []) {
    if (String(m?.vulnerability?.severity ?? '').toLowerCase() !== 'critical') continue
    const ids = [m.vulnerability.id, ...(m.relatedVulnerabilities ?? []).map((r) => r.id)].filter(Boolean)
    if (ids.some((id) => ok.has(id))) continue
    out.push(p('critical', `${m.artifact?.name}@${m.artifact?.version}: CRITICAL ${ids.join(' / ')} not in accepted.json`))
  }
  return out
}

// ── tools (digest-pinned containers, pinned cosign) ─────────────────────────

const defaultName = (role) => `gremion-sbom-${randomBytes(4).toString('hex')}-${role}`

export function sbomOfImage(ref, { name = defaultName('syft') } = {}) {
  const cfg = process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? '/root', '.docker')
  const r = run('docker', [
    'run', '--rm', '--name', name, '--network', 'host',
    '-v', `${cfg}:/config:ro`, '-e', 'DOCKER_CONFIG=/config', '-e', 'SYFT_CHECK_FOR_APP_UPDATE=false',
    IMAGES.syft, '-q', `registry:${ref}`, '-o', 'cyclonedx-json@1.6',
  ])
  if (r.status !== 0) throw new Error(`syft failed for ${ref}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** Q4: the source SBOM of the committed ROOT lockfile only. */
export function sourceSbom(root = REPO_ROOT, { name = defaultName('syft') } = {}) {
  const r = run('docker', [
    'run', '--rm', '--name', name, '--network', 'none',
    '-v', `${join(root, 'pnpm-lock.yaml')}:/src/pnpm-lock.yaml:ro`, '-e', 'SYFT_CHECK_FOR_APP_UPDATE=false',
    IMAGES.syft, '-q', 'dir:/src', '-o', 'cyclonedx-json@1.6',
  ])
  if (r.status !== 0) throw new Error(`syft failed on the lockfile: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** {problems, predicate}: the CycloneDX predicate of a key-verified attestation for `ref`. */
export function verifyAttestation(ref, pub) {
  const digest = /@sha256:([0-9a-f]{64})$/.exec(ref)?.[1]
  if (!digest) return { problems: [p('attestation', `not a digest reference: ${ref}`)], predicate: null }
  const r = run('cosign', ['verify-attestation', '--key', pub, '--type', 'cyclonedx', '--insecure-ignore-tlog=true', ref])
  if (r.status !== 0) {
    return { problems: [p('attestation', `no CycloneDX attestation on ${ref} verifies with ${pub}`)], predicate: null }
  }
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    let stmt
    try {
      stmt = JSON.parse(Buffer.from(JSON.parse(line).payload, 'base64').toString('utf8'))
    } catch {
      continue
    }
    const subjectOk = (stmt.subject ?? []).some((s) => s?.digest?.sha256 === digest)
    if (stmt.predicateType === 'https://cyclonedx.org/bom' && subjectOk && stmt.predicate) {
      return { problems: [], predicate: stmt.predicate }
    }
  }
  return { problems: [p('attestation', `attestation on ${ref} verified but none binds a CycloneDX predicate to ${digest}`)], predicate: null }
}

/**
 * {problems, report}: grype over an SBOM document. The DB lives in a named
 * volume; `update` refreshes it first. The DB's status is asserted before the
 * scan — a scan against no DB would report "no vulnerabilities".
 */
export function runGrype(doc, { name = defaultName('grype'), volume = 'gremion-grypedb', update = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gremion-sbom-'))
  try {
    writeFileSync(join(dir, 'sbom.json'), JSON.stringify(doc))
    const base = [
      'run', '--rm', '-v', `${volume}:/db`, '-e', 'GRYPE_DB_CACHE_DIR=/db',
      '-e', 'GRYPE_CHECK_FOR_APP_UPDATE=false', '-e', 'GRYPE_DB_AUTO_UPDATE=false',
    ]
    if (update) {
      const u = run('docker', [...base, '--name', `${name}-dbupdate`, IMAGES.grype, 'db', 'update'])
      if (u.status !== 0) return { problems: [p('grype-db', `grype db update failed: ${lastLine(u.stderr)}`)], report: null }
    }
    const s = run('docker', [...base, '--name', `${name}-dbstatus`, IMAGES.grype, 'db', 'status'])
    if (s.status !== 0 || !/Status:\s*valid/i.test(s.stdout + s.stderr)) {
      return { problems: [p('grype-db', `grype vulnerability DB missing or invalid (volume ${volume}): ${lastLine(s.stdout + s.stderr)}`)], report: null }
    }
    const g = run('docker', [...base, '--name', name, '-v', `${dir}:/in:ro`, IMAGES.grype, 'sbom:/in/sbom.json', '-o', 'json'])
    if (g.status !== 0) return { problems: [p('grype-db', `grype scan failed: ${lastLine(g.stderr)}`)], report: null }
    const report = JSON.parse(g.stdout)
    if (!Array.isArray(report.matches)) return { problems: [p('grype-db', 'grype output has no matches array')], report: null }
    return { problems: [], report }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const lastLine = (s) => String(s ?? '').trim().split('\n').pop()

/** All checks for one SBOM document. */
export function checkSbomDoc(doc, { grype = {}, accepted = [] } = {}) {
  const shape = validateSbom(doc)
  if (shape.length) return shape
  const out = [...floorProblems(doc)]
  const g = runGrype(doc, grype)
  out.push(...g.problems)
  if (g.report) out.push(...criticalProblems(g.report, accepted))
  return out
}

/**
 * {refs, unparsed}: first-party digest refs from the canonical
 * `<indent>image: <ref>` lines, and every non-comment line that mentions
 * `image` in any other form (flow mapping, quoted key, trailing comment) —
 * those are problems, never silently skipped.
 */
export function firstPartyDigests(pinsText, prefix) {
  const refs = []
  const unparsed = []
  for (const l of pinsText.split('\n')) {
    if (/^\s*#/.test(l) || !/image/.test(l)) continue
    const m = /^\s*image:\s*["']?([^\s"'{}#,]+)["']?\s*$/.exec(l)
    if (!m) unparsed.push(l.trim())
    else if (m[1].toLowerCase().startsWith(prefix.toLowerCase())) refs.push(m[1])
  }
  return { refs, unparsed }
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (f) => {
    const i = process.argv.indexOf(f)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const pins = arg('--pins')
  const key = arg('--key')
  const prefix = arg('--first-party') ?? 'ghcr.io/hello-n00del/'
  const grype = { volume: arg('--grype-db-volume') ?? 'gremion-grypedb', update: !process.argv.includes('--no-db-update') }
  const problems = []
  const acc = loadAccepted(JSON.parse(readFileSync(join(HERE, 'accepted.json'), 'utf8')))
  problems.push(...acc.problems.map((x) => ({ ...x, where: 'accepted.json' })))

  const src = sourceSbom(REPO_ROOT)
  problems.push(...checkSbomDoc(src, { grype, accepted: acc.entries }).map((x) => ({ ...x, where: 'pnpm-lock.yaml' })))

  if (pins || key) {
    if (!pins || !key) problems.push({ code: 'usage', message: '--pins and --key go together', where: 'cli' })
    else {
      const { refs, unparsed } = firstPartyDigests(readFileSync(pins, 'utf8'), prefix)
      for (const u of unparsed) problems.push({ code: 'unparsed-pin', message: `unrecognised image declaration: ${u}`, where: pins })
      if (!refs.length) problems.push({ code: 'no-first-party', message: `no ${prefix}* image in ${pins}`, where: pins })
      for (const ref of refs) {
        const a = verifyAttestation(ref, key)
        problems.push(...a.problems.map((x) => ({ ...x, where: ref })))
        if (a.predicate) problems.push(...checkSbomDoc(a.predicate, { grype, accepted: acc.entries }).map((x) => ({ ...x, where: ref })))
      }
    }
  }
  for (const x of problems) console.error(`check-sbom: FAIL ${x.code} ${x.where}: ${x.message}`)
  console.log(`check-sbom: ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
