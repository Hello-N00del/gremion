// packages/generated-clients/src/oasdiff-gate.ts
//
// T3/T5: the OpenAPI compat gate — TRD-403/404/405, [D R19-D2]. PORTED from
// gremion-ui/scripts/contracts-gate.ts (`ab45a0e`), which is left untouched
// per the brief's ownership rule ("Port their logic; do not import it" —
// gremion-ui/** stays off limits). The oasdiff invocation (PATH binary, then
// `tufin/oasdiff` ONLY if the docker daemon answers, and only exit codes 0/1
// are a verdict — never a bare "docker run" exit code, which is 1 for both
// "breaking change found" and "daemon unreachable") is kept VERBATIM. Stale
// in the original and deliberately NOT ported: the staged-only git trigger
// (this runs over any two spec strings, not `git diff --cached`) and the
// `CONTRACTS_ALLOW_BREAKING` bypass (brief §5 "there is no environment
// bypass; the bump is the only way through").
//
// NEW here: the version-bump rule. oasdiff's `breaking` command only
// classifies ERR-level breaking changes; it says nothing about whether a
// non-breaking addition happened, or whether nothing but prose changed. That
// second axis is decided structurally (stripCompatNoise + deep-equal), not by
// oasdiff, because "did anything but a description change" has to be true
// independent of whether any tool is even installed — a description-only
// edit must pass even with oasdiff absent, which the T3 fixtures cover.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GateResult { breaking: boolean; output: string; tool: string }

const VERDICT_CODES = new Set([0, 1])

// LOW finding (round 1): the Docker fallback used the unpinned `tufin/oasdiff`
// (== `latest`), so which tool VERSION rendered a verdict was neither pinned
// nor recorded — brief §5 "Pin generator versions exactly" and §7 "record
// which tool gave the verdict". Pinned here to the newest tagged release as
// of TASK-030 (2026-09-25); bump deliberately (update both the tag and the
// digest together) rather than silently drifting with `latest`.
const OASDIFF_DOCKER_IMAGE = 'tufin/oasdiff:v1.32.1@sha256:3b14fe0112e5d1bf862f91ab234a4bcd161a3f399e98f8b0b665ce70857694ac'

/** Best-effort version string for whichever oasdiff actually ran. Never
 *  throws and never affects the verdict — a version probe that fails to
 *  start or to parse must not turn a real verdict into "no verdict". */
function probeVersion(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env })
  if (r.error) return 'unknown'
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  return out.length > 0 ? out.split('\n')[0] : 'unknown'
}

interface RunOpts { env?: NodeJS.ProcessEnv }

function tryRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string } | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env })
  if (r.error) return null
  const code = r.status ?? 1
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  if (!VERDICT_CODES.has(code)) return null
  return { code, out }
}

function dockerDaemonAvailable(env?: NodeJS.ProcessEnv): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', env })
  return !r.error && r.status === 0
}

/** Compare two spec JSON strings; breaking=true when oasdiff finds ERR-level
 *  breakings. Fails CLOSED (throws) when no tool reaches a verdict — T5: a
 *  missing/erroring tool is not silently treated as "clean". `opts.env`
 *  exists for T5's own test, which strips PATH to prove the throw without
 *  needing to actually disable this machine's real oasdiff/docker. */
export function runOasdiffBreaking(oldSpec: string, newSpec: string, opts: RunOpts = {}): GateResult {
  const env = opts.env
  const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'))
  try {
    writeFileSync(join(dir, 'old.json'), oldSpec)
    writeFileSync(join(dir, 'new.json'), newSpec)
    // `--fail-on WARN`, not `ERR`: verified empirically (acceptance demo,
    // seeding a removed OPTIONAL response field with no bump) that oasdiff
    // classifies "response-optional-property-removed" as WARN, not ERR — at
    // `--fail-on ERR` a real removed field silently passed with no bump,
    // which is exactly the acceptance criterion this gate exists to catch
    // (brief §1: "remove ... without a major bump fails"). WARN still lets
    // pure additions through as non-breaking (verified against the T3
    // added-param fixture: unchanged at WARN), so the "add without a minor
    // bump fails" branch below is unaffected.
    let r = tryRun('oasdiff', ['breaking', join(dir, 'old.json'), join(dir, 'new.json'), '--fail-on', 'WARN'], env)
    if (r) {
      const version = probeVersion('oasdiff', ['--version'], env)
      return { breaking: r.code !== 0, output: r.out, tool: `oasdiff (PATH, version ${version})` }
    }
    if (dockerDaemonAvailable(env)) {
      r = tryRun('docker', ['run', '--rm', '-v', `${dir}:/specs:ro`, OASDIFF_DOCKER_IMAGE,
        'breaking', '/specs/old.json', '/specs/new.json', '--fail-on', 'WARN'], env)
      if (r) {
        const version = probeVersion('docker', ['run', '--rm', OASDIFF_DOCKER_IMAGE, '--version'], env)
        return { breaking: r.code !== 0, output: r.out, tool: `${OASDIFF_DOCKER_IMAGE} (docker, version ${version})` }
      }
    }
    throw new Error(
      '[oasdiff-gate] no oasdiff verdict: neither an `oasdiff` binary nor a working docker ran the '
      + 'comparison. A tool that starts and then errors is NOT a verdict. Install oasdiff '
      + '(https://github.com/oasdiff/oasdiff) or start the docker daemon. There is no environment '
      + 'bypass — a bump is the only way through. Failing closed.',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type VersionBump = 'major' | 'minor' | 'patch' | 'none' | 'downgrade' | 'invalid'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function classifyVersionBump(oldVersion: string, newVersion: string): VersionBump {
  const o = SEMVER.exec(oldVersion)
  const n = SEMVER.exec(newVersion)
  if (!o || !n) return 'invalid'
  const [oMaj, oMin, oPat] = o.slice(1).map(Number)
  const [nMaj, nMin, nPat] = n.slice(1).map(Number)
  if (nMaj > oMaj) return 'major'
  if (nMaj < oMaj) return 'downgrade'
  if (nMin > oMin) return 'minor'
  if (nMin < oMin) return 'downgrade'
  if (nPat > oPat) return 'patch'
  if (nPat < oPat) return 'downgrade'
  return 'none'
}

/** Strip every NARRATIVE `description` key (recursively) so a prose-only
 *  edit compares equal to the unedited document — "description-only passes"
 *  regardless of version, per brief §1.
 *
 *  Guard-efficacy proof / acceptance demo caught a real bug here: a JSON
 *  Schema data field can itself be named "description" (verified against
 *  the real spec — `OrgUnit.properties.description`, a plain string
 *  response field, not documentation prose). The original version matched
 *  on key name alone, so removing that FIELD made the two documents compare
 *  structurally equal — `structuralChange: false` — and the compat gate
 *  never even ran, silently treating a real breaking removal as a no-op.
 *  OpenAPI/AsyncAPI's own `description` slots (info, operations, parameters,
 *  responses, schemas-as-documentation) are always a plain STRING value; a
 *  schema property definition named "description" is always an OBJECT (its
 *  own schema, e.g. `{"type":"string"}`). That type check is what
 *  disambiguates the two without needing to track JSON-pointer position. */
export function stripCompatNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripCompatNoise)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'description' && typeof v === 'string') continue
      out[k] = stripCompatNoise(v)
    }
    return out
  }
  return node
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripCompatNoise(a)) === JSON.stringify(stripCompatNoise(b))
}

export interface CompatResult {
  ok: boolean
  breaking: boolean
  structuralChange: boolean
  bump: VersionBump
  reason: string
}

/** The full OpenAPI compat rule (brief §1): remove/narrow without a MAJOR
 *  bump fails; add without a MINOR bump fails; description-only passes;
 *  the right bump passes. */
export function checkOpenApiCompat(oldRaw: string, newRaw: string, opts: RunOpts = {}): CompatResult {
  const oldDoc = JSON.parse(oldRaw) as { info?: { version?: string } }
  const newDoc = JSON.parse(newRaw) as { info?: { version?: string } }
  const oldVersion = oldDoc.info?.version ?? ''
  const newVersion = newDoc.info?.version ?? ''

  if (structurallyEqual(oldDoc, newDoc)) {
    return { ok: true, breaking: false, structuralChange: false, bump: classifyVersionBump(oldVersion, newVersion), reason: 'no structural change (description-only or identical)' }
  }

  const gate = runOasdiffBreaking(oldRaw, newRaw, opts)
  const bump = classifyVersionBump(oldVersion, newVersion)

  if (gate.breaking) {
    const ok = bump === 'major'
    return {
      ok,
      breaking: true,
      structuralChange: true,
      bump,
      reason: ok
        ? `breaking change, major bump ${oldVersion} -> ${newVersion}: OK`
        : `breaking change (${gate.tool}) requires a MAJOR bump; got ${oldVersion} -> ${newVersion} (${bump}).\n${gate.output}`,
    }
  }
  const ok = bump === 'major' || bump === 'minor'
  return {
    ok,
    breaking: false,
    structuralChange: true,
    bump,
    reason: ok
      ? `non-breaking addition, ${bump} bump ${oldVersion} -> ${newVersion}: OK`
      : `non-breaking structural change (an addition) requires at least a MINOR bump; got ${oldVersion} -> ${newVersion} (${bump}).`,
  }
}
