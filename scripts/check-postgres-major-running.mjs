#!/usr/bin/env node
// Postgres major pin — the RUNNING half (TASK-019, CAP-PG18).
//
// check-postgres-major.mjs proves what is WRITTEN: every declaration names the
// pinned tag and digest. This proves what RUNS: it finds a compose project's
// Postgres containers by their org.gremion.postgres label and asks each one,
// over psql inside the container,
//
//   SELECT current_setting('server_version_num') || '|' || version()
//   SELECT uuid_extract_version(uuidv7())
//
// and requires major POSTGRES_MAJOR and UUID version 7 (RFC 9562) from every
// one. uuidv7() only exists from PostgreSQL 18 on, so the second probe is also
// a second, independent reading of the major.
//
// It FAILS on zero containers (a scan that found nothing proves nothing), on
// any expected service — every labelled service of the compose scan,
// profile-gated ones included — that has no running container, on a labelled
// container that is not running, on empty psql output and on a failing probe.
//
// Run:  node scripts/check-postgres-major-running.mjs --project <p>
//         [--compose <file>]...   (default: the kernel docker-compose.yml)
//         [--profile <id>]... | [--no-profiles]
//       With neither profile flag every labelled service is expected, the six
//       profile-gated module servers included. --profile narrows the expected
//       module servers to the profiles the run enabled; --no-profiles expects
//       the kernel server alone (what postgres-major-proof.sh starts).
// Test: node --test scripts/check-postgres-major-running.test.mjs

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { POSTGRES_MAJOR, POSTGRES_LABEL, MODULE_POSTGRES_IDS, composeServices } from './check-postgres-major.mjs'

export const UUID_VERSION = '7'

export const PS_FORMAT =
  `{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "${POSTGRES_LABEL}"}}\t{{.Names}}`

/**
 * The services the running stack must have: every service of the given
 * compose texts that carries the org.gremion.postgres label. Profiles are not
 * applied on purpose — a profile-gated module server is still expected, and
 * a run that forgot its `--profile` is exactly what this is meant to catch.
 */
export function expectedServices(composeTexts, profiles = null) {
  const out = new Map()
  for (const text of composeTexts) {
    for (const s of composeServices(text)) {
      if (s.label == null) continue
      // `profiles` narrows the set to what a run actually enabled (the kernel
      // server, which has none, is always expected); null means all of them.
      if (profiles && s.profiles.length && !s.profiles.some((p) => profiles.includes(p))) continue
      out.set(s.name, { service: s.name, label: s.label })
    }
  }
  return [...out.values()]
}

/**
 * --profile <id>... | --no-profiles -> the profile list, or null for "all".
 * Refuses what would silently narrow the expected set: an unknown id (a typo),
 * a --profile with no value, and both flags at once.
 */
export function parseProfiles(args) {
  const ids = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--profile') continue
    const v = args[i + 1]
    if (!v || v.startsWith('--')) throw new Error('--profile needs a module id')
    if (!MODULE_POSTGRES_IDS.includes(v)) {
      throw new Error(`unknown module profile '${v}' (known: ${MODULE_POSTGRES_IDS.join(', ')})`)
    }
    ids.push(v)
  }
  if (args.includes('--no-profiles')) {
    if (ids.length) throw new Error('use either --profile or --no-profiles, not both')
    return []
  }
  return ids.length ? ids : null
}

/** Every container of the project that carries the label, running or not. */
export function listContainers(project, docker) {
  const r = docker(['ps', '-a',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=${POSTGRES_LABEL}`,
    '--format', PS_FORMAT])
  if (r.status !== 0) throw new Error(`docker ps failed (exit ${r.status}): ${(r.stderr || '').trim()}`)
  return r.stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const [id, state, service, label, name] = l.replace(/\r$/, '').split('\t')
    return { id, state, service, label, name }
  })
}

// The SQL is handed to psql as "$1" of the sh -c program, never spliced into
// it: the program text is fixed and no quoting of the query can break it.
// POSTGRES_USER is read INSIDE the container, because every module server
// runs under its own superuser name. Local socket connections are trusted by
// the official image, so no password crosses the command line.
const PSQL = 'psql -X -v ON_ERROR_STOP=1 -At -U "${POSTGRES_USER:-postgres}" -d postgres -c "$1"'

function psql(docker, id, sql) {
  const r = docker(['exec', id, 'sh', '-c', PSQL, 'sh', sql])
  return { ...r, out: (r.stdout || '').replace(/\r/g, '').trim() }
}

/**
 * @param {{project: string, expected: {service: string, label: string}[],
 *          docker: (args: string[]) => {status: number, stdout: string, stderr: string}}} o
 * @returns {{problems: string[], rows: object[]}}
 */
export function checkRunning({ project, expected, docker }) {
  const problems = []
  const rows = []
  const containers = listContainers(project, docker)
  if (containers.length === 0) {
    problems.push(`found zero Postgres containers labelled ${POSTGRES_LABEL} in project ${project} — the check would pass vacuously`)
    return { problems, rows }
  }
  if (expected.length === 0) {
    problems.push('the compose scan expects zero Postgres services — nothing to hold the running containers to')
  }
  for (const e of expected) {
    const mine = containers.filter((c) => c.service === e.service)
    if (mine.length === 0) {
      problems.push(`expected service ${e.service} (${e.label}) has no container in project ${project}`)
    }
    for (const c of mine.filter((c) => c.label !== e.label)) {
      problems.push(`${e.service} is labelled ${c.label}, expected ${e.label} (${c.name})`)
    }
  }
  for (const c of containers) {
    const who = `${c.name} (${c.label})`
    if (c.state !== 'running') {
      problems.push(`${c.service ? `${c.service} ` : ''}${who} is ${c.state}, not running`)
      continue
    }
    const v = psql(docker, c.id, "SELECT current_setting('server_version_num') || '|' || version()")
    let major = null
    let version = null
    if (v.status !== 0) {
      problems.push(`${who}: version probe failed (exit ${v.status}): ${(v.stderr || '').trim()}`)
    } else if (!v.out) {
      problems.push(`${who}: version probe returned empty output`)
    } else {
      const m = v.out.match(/^(\d+)\|(.+)$/)
      if (!m) {
        problems.push(`${who}: version probe output is unparseable: '${v.out}'`)
      } else {
        const num = Number(m[1])
        major = Math.floor(num / 10000)
        version = m[2]
        if (major !== POSTGRES_MAJOR) {
          problems.push(`${who}: server_version_num ${num} is major ${major}, expected ${POSTGRES_MAJOR}`)
        } else if (!version.startsWith(`PostgreSQL ${POSTGRES_MAJOR}.`)) {
          problems.push(`${who}: version() reads '${version}', which disagrees with server_version_num ${num}`)
        }
      }
    }
    const u = psql(docker, c.id, 'SELECT uuid_extract_version(uuidv7())')
    let uuidVersion = null
    if (u.status !== 0) {
      problems.push(`${who}: uuid probe failed (exit ${u.status}): ${(u.stderr || '').trim()}`)
    } else if (!u.out) {
      problems.push(`${who}: uuid probe returned empty output`)
    } else {
      uuidVersion = u.out
      if (uuidVersion !== UUID_VERSION) {
        problems.push(`${who}: uuid_extract_version(uuidv7()) returned '${uuidVersion}', expected '${UUID_VERSION}'`)
      }
    }
    rows.push({ name: c.name, service: c.service, label: c.label, major, version, uuidVersion })
  }
  return { problems, rows }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const project = args[args.indexOf('--project') + 1]
  if (!args.includes('--project') || !project || project.startsWith('--')) {
    console.error('[postgres-major-running] usage: --project <compose project> [--compose <file>]...')
    process.exit(2)
  }
  const composeFiles = args.flatMap((a, i) => (a === '--compose' ? [args[i + 1]] : []))
  const files = composeFiles.length ? composeFiles : [join(ROOT, 'docker-compose.yml')]
  let profiles
  try {
    profiles = parseProfiles(args)
  } catch (err) {
    console.error(`[postgres-major-running] ${err.message}`)
    process.exit(2)
  }
  const expected = expectedServices(files.map((f) => readFileSync(f, 'utf8')), profiles)
  const docker = (a) => {
    const r = spawnSync('docker', a, { encoding: 'utf8' })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') }
  }
  let result
  try {
    result = checkRunning({ project, expected, docker })
  } catch (err) {
    console.error(`[postgres-major-running] ${err.message}`)
    process.exit(1)
  }
  for (const r of result.rows) {
    console.log(`  ${r.name} [${r.label}] major=${r.major} uuid_version=${r.uuidVersion} :: ${r.version}`)
  }
  if (result.problems.length > 0) {
    console.error(`[postgres-major-running] ${result.problems.length} problem(s) in project ${project}:`)
    for (const p of result.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[postgres-major-running] OK — ${result.rows.length} running Postgres container(s) in ${project}, ` +
    `${expected.length} expected service(s) present; every one is major ${POSTGRES_MAJOR} and mints version-${UUID_VERSION} UUIDs`)
}
