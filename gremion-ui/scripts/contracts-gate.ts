// gremion-ui/scripts/contracts-gate.ts
// P0.4 oasdiff breaking-change gate (design §3.2 Contracts row). Resolution
// order: `oasdiff` on PATH, else docker image tufin/oasdiff. This gate runs on
// the pre-commit hook and in `--gate-self-test`.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GateResult { breaking: boolean; output: string; tool: string }

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
      r = tryRun('docker', ['run', '--rm', '-v', `${dir}:/specs:ro`, 'tufin/oasdiff',
        'breaking', '/specs/old.json', '/specs/new.json', '--fail-on', 'ERR'])
      if (r) return { breaking: r.code !== 0, output: r.out, tool: 'tufin/oasdiff (docker)' }
    }
    throw new Error(
      '[contracts-gate] no oasdiff verdict: neither an `oasdiff` binary nor a working '
      + 'docker ran the comparison (a tool that starts and then errors — e.g. `docker run` '
      + 'with the daemon stopped — is NOT a verdict and is deliberately not read as one). '
      + 'Install: https://github.com/oasdiff/oasdiff (or `docker pull tufin/oasdiff`), '
      + 'or start the docker daemon. A staged contract change CANNOT be verified — failing closed.',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Gate staged spec files against their HEAD version. Returns failure messages. */
export function gateStagedSpecs(repoRoot: string): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').map((s) => s.trim()).filter(Boolean)
  // `newsletter` was in this alternation until the module and its contract left
  // with the carve; that half matched nothing. contracts/kernel/ is the only
  // OpenAPI directory this repository has.
  const specs = staged.filter((p) => /^contracts\/kernel\/openapi\..+\.json$/.test(p))
  const problems: string[] = []
  for (const p of specs) {
    let oldSpec: string
    try { oldSpec = git(['show', `HEAD:${p}`]) } catch { continue /* new file — nothing to break */ }
    const newSpec = git(['show', `:${p}`])
    const res = runOasdiffBreaking(oldSpec, newSpec)
    if (res.breaking) {
      if (process.env.CONTRACTS_ALLOW_BREAKING === '1') {
        console.warn(`[contracts-gate] BREAKING change in ${p} ALLOWED via CONTRACTS_ALLOW_BREAKING=1 — bump info.version + note it in the PR description.\n${res.output}`)
      } else {
        problems.push(`${p}: breaking change detected by ${res.tool}. Intentional? Re-commit with CONTRACTS_ALLOW_BREAKING=1, bump info.version, and record it in the PR description.\n${res.output}`)
      }
    }
  }
  return problems
}
