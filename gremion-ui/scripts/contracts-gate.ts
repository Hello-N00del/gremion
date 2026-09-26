// gremion-ui/scripts/contracts-gate.ts
// P0.4 oasdiff breaking-change gate (design §3.2 Contracts row). Resolution
// order: `oasdiff` on PATH, else the digest-pinned docker image below. This gate
// runs on the pre-commit hook and in `--gate-self-test`.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GateResult { breaking: boolean; output: string; tool: string }

// Pinned by tag AND digest (TASK-018-FU): the unpinned `tufin/oasdiff` meant
// `latest`, so which tool version rendered a verdict drifted silently. This is
// the SAME image packages/generated-clients/src/oasdiff-gate.ts pins (TASK-030).
// It is duplicated, not imported — gremion-ui does not depend on that package,
// and install-git-hooks.test.ts copies this file into a scratch repo on its own
// — so contracts-gate-staged.test.ts asserts the two are equal. Bump both
// together.
export const OASDIFF_DOCKER_IMAGE = 'tufin/oasdiff:v1.32.1@sha256:3b14fe0112e5d1bf862f91ab234a4bcd161a3f399e98f8b0b665ce70857694ac'

// oasdiff `breaking --fail-on ERR` answers with an EXIT CODE: 0 = clean,
// 1 = breaking change found. Any OTHER code means the tool did not reach a
// verdict — bad arguments, an unreadable spec, a container that never started.
const VERDICT_CODES = new Set([0, 1])

function tryRun(cmd: string, args: string[]): { code: number; out: string } | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.error) return null
  const code = r.status ?? 1
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  if (!VERDICT_CODES.has(code)) return null
  return { code, out }
}

// A TOOL THAT ERRORS IS NOT A VERDICT, and for the docker leg the exit code
// cannot tell the two apart: the docker CLI exits 1 when the daemon is
// unreachable, which is the SAME code oasdiff uses for "breaking change found".
// Observed live: with Docker Desktop stopped, `--gate-self-test` printed
// "failed to connect to the docker API …" and then "PASS: breaking fixture
// detected" — a green assertion produced by a tool that never ran, so assert 1
// could not fail honestly.
//
// So the docker fallback is preflighted against the DAEMON, not the CLI. If the
// daemon does not answer, docker is treated as absent and the caller reaches the
// fail-closed throw below, which is what the gate promises.
function dockerDaemonAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}

/** Compare two spec JSON strings; breaking=true when oasdiff finds ERR-level breakings. */
export function runOasdiffBreaking(oldSpec: string, newSpec: string): GateResult {
  const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'))
  try {
    writeFileSync(join(dir, 'old.json'), oldSpec)
    writeFileSync(join(dir, 'new.json'), newSpec)
    // 1) native binary
    let r = tryRun('oasdiff', ['breaking', join(dir, 'old.json'), join(dir, 'new.json'), '--fail-on', 'ERR'])
    if (r) return { breaking: r.code !== 0, output: r.out, tool: 'oasdiff (PATH)' }
    // 2) docker fallback — only when the DAEMON answers (see dockerDaemonAvailable)
    if (dockerDaemonAvailable()) {
      r = tryRun('docker', ['run', '--rm', '-v', `${dir}:/specs:ro`, OASDIFF_DOCKER_IMAGE,
        'breaking', '/specs/old.json', '/specs/new.json', '--fail-on', 'ERR'])
      if (r) return { breaking: r.code !== 0, output: r.out, tool: `${OASDIFF_DOCKER_IMAGE} (docker)` }
    }
    throw new Error(
      '[contracts-gate] no oasdiff verdict: neither an `oasdiff` binary nor a working '
      + 'docker ran the comparison (a tool that starts and then errors — e.g. `docker run` '
      + 'with the daemon stopped — is NOT a verdict and is deliberately not read as one). '
      + `Install: https://github.com/oasdiff/oasdiff (or \`docker pull ${OASDIFF_DOCKER_IMAGE}\`), `
      + 'or start the docker daemon. A staged contract change CANNOT be verified — failing closed.',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SEMVER_MAJOR = /^(\d+)\.\d+\.\d+$/

/** info.version's major, or null when the document or version is unparseable. */
function specMajor(raw: string): { version: string; major: number | null } {
  let version = ''
  try {
    const v = (JSON.parse(raw) as { info?: { version?: unknown } }).info?.version
    version = typeof v === 'string' ? v : ''
  } catch { /* unparseable document: no version */ }
  const m = SEMVER_MAJOR.exec(version)
  return { version: version || '(none)', major: m ? Number(m[1]) : null }
}

export interface GateStagedOpts {
  /** The breaking-change comparison; defaults to runOasdiffBreaking. Injected
   *  by contracts-gate-staged.test.ts so the bump rule is tested hermetically. */
  compare?: (oldSpec: string, newSpec: string) => GateResult
}

/** Gate staged spec files against their HEAD version. Returns failure messages. */
export function gateStagedSpecs(repoRoot: string, opts: GateStagedOpts = {}): string[] {
  const compare = opts.compare ?? runOasdiffBreaking
  // stderr piped: a new spec's failed `git show HEAD:<path>` is expected, and
  // stray `fatal:` lines on a passing commit train people to ignore them.
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // -M with -z: a staged rename is `R<score>\0<old>\0<new>`, so a renamed spec is
  // compared against HEAD under its OLD path. Before TASK-018-FU this listed
  // names only, `git show HEAD:<new path>` failed, and `git mv` + a break was
  // skipped as a "new file".
  // renameLimit=0: a big staged change set must not make git skip detection.
  const fields = git(['-c', 'diff.renameLimit=0', 'diff', '--cached', '--name-status', '-M', '-z', '--diff-filter=ACMR']).split('\0')
  const staged: Array<{ path: string; oldPath: string }> = []
  for (let i = 0; i < fields.length && fields[i]; ) {
    if (fields[i].startsWith('R') || fields[i].startsWith('C')) {
      // A copy (C) leaves its source in place: the copy itself is new.
      staged.push({ path: fields[i + 2], oldPath: fields[i].startsWith('R') ? fields[i + 1] : fields[i + 2] })
      i += 3
    } else {
      staged.push({ path: fields[i + 1], oldPath: fields[i + 1] })
      i += 2
    }
  }
  // `newsletter` was in this alternation until the module and its contract left
  // with the carve; that half matched nothing. contracts/kernel/ is the only
  // OpenAPI directory this repository has.
  const isSpec = (p: string) => /^contracts\/kernel\/openapi\..+\.json$/.test(p)
  const specs = staged.filter((s) => isSpec(s.path) || isSpec(s.oldPath))
  const problems: string[] = []
  // A rename that also rewrites most of the spec is below git's similarity
  // threshold and is staged as D + A (round-2 verifier HIGH). The registry
  // name is the stable identity: pair the staged path with the file HEAD's
  // registry listed under the same name.
  const registry = (rev: string): Array<{ name?: unknown; file?: unknown }> => {
    try { return (JSON.parse(git(['show', `${rev}contracts/registry.json`])) as { specs?: [] }).specs ?? [] } catch { return [] }
  }
  const headRegistry = registry('HEAD:')
  const stagedRegistry = registry(':')
  const headFileFor = (p: string): string | null => {
    const name = stagedRegistry.find((e) => e?.file === p)?.name
    if (typeof name !== 'string') return null
    const file = headRegistry.find((e) => e?.name === name)?.file
    return typeof file === 'string' && file !== p ? file : null
  }
  for (const { path: p, oldPath } of specs) {
    let oldSpec: string | null = null
    for (const candidate of [oldPath, headFileFor(p)]) {
      if (candidate === null || oldSpec !== null) continue
      try { oldSpec = git(['show', `HEAD:${candidate}`]) } catch { /* not at HEAD */ }
    }
    if (oldSpec === null) continue /* new file — nothing to break */
    const newSpec = git(['show', `:${p}`])
    const res = compare(oldSpec, newSpec)
    if (res.breaking) {
      if (process.env.CONTRACTS_ALLOW_BREAKING === '1') {
        // The bypass acknowledges an INTENTIONAL break; it does not waive the
        // major bump that break requires (TASK-018-FU). An unparseable version
        // on either side cannot prove a bump, so it fails closed.
        const before = specMajor(oldSpec)
        const after = specMajor(newSpec)
        if (before.major === null || after.major === null || after.major <= before.major) {
          problems.push(`${p}: breaking change detected by ${res.tool}; CONTRACTS_ALLOW_BREAKING=1 still requires a MAJOR bump of info.version (strict MAJOR.MINOR.PATCH on both sides), got ${before.version} -> ${after.version}.\n${res.output}`)
          continue
        }
        console.warn(`[contracts-gate] BREAKING change in ${p} ALLOWED via CONTRACTS_ALLOW_BREAKING=1 (major bump ${before.version} -> ${after.version}) — note it in the PR description.\n${res.output}`)
      } else {
        problems.push(`${p}: breaking change detected by ${res.tool}. Intentional? Re-commit with CONTRACTS_ALLOW_BREAKING=1, bump info.version's MAJOR, and record it in the PR description.\n${res.output}`)
      }
    }
  }
  return problems
}
