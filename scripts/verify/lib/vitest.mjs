// TASK-045: one vitest run, judged from its JSON report AND its exit code.
// Shared by every suite that runs vitest (unit, integration, contracts,
// f1-defect) so they cannot drift apart in how much of vitest they trust.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectedFileNamesFromVitestJson, parseVitestJsonFile, skipsByFileFromVitestJson, summarizeVitestFailures } from './parsers.mjs'
import { run, spawnMissing, tail } from './proc.mjs'

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')

/**
 * Runs `cmd args --reporter=json --outputFile=<tmp>` in `cwd` and returns a
 * combineParts part:
 *   - the command cannot start -> `toolMissing: cmd`;
 *   - no parseable report -> unparseable (never a pass);
 *   - a non-zero exit that the report does not explain with a failure ->
 *     unparseable ("untrusted"): the report can be complete and green while
 *     vitest still failed for a reason it does not write there (round-1
 *     review: the exit code was only ever printed, never judged);
 *   - otherwise the report's counts, the failing tests by name, and skips
 *     per repo-relative file (Q3).
 * The flags are appended with NO `--` separator: pnpm 10 forwards a literal
 * `--`, after which vitest treats its own flags as positional and writes no
 * report at all.
 */
export function runVitestJson({ label, cwd, cmd = 'pnpm', args, env, root = REPO_ROOT }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-vitest-'))
  const outFile = path.join(dir, 'result.json')
  try {
    const res = run(cmd, [...args, '--reporter=json', `--outputFile=${outFile}`], { cwd, ...(env ? { env } : {}) })
    if (spawnMissing(res)) {
      return { label, toolMissing: cmd }
    }
    const parsed = parseVitestJsonFile(outFile)
    if (!parsed) {
      return { label, unparseable: true, detail: `vitest produced no parseable JSON report (exit ${res.code})\n${tail(res.stdout + res.stderr)}` }
    }
    if (res.code !== 0 && parsed.failed === 0) {
      return {
        label,
        unparseable: true,
        detail: `the test command exited ${res.code ?? `on signal ${res.signal}`} but its report shows no failure -- untrusted\n${tail(res.stdout + res.stderr)}`,
      }
    }
    const failures = parsed.failed > 0 ? summarizeVitestFailures(outFile) : []
    return {
      label,
      toolMissing: null,
      unparseable: false,
      ...parsed,
      skipsByFile: skipsByFileFromVitestJson(outFile, { root }),
      // Additive, ignored by combineParts/evaluateSuite (which only read the
      // named count/skip fields) -- lets a caller pin that ONE specific file
      // was collected at all, not just that the totals looked healthy (see
      // suites/isolation.mjs).
      collectedFiles: collectedFileNamesFromVitestJson(outFile, { root }),
      detail: failures.length > 0 ? failures.join('\n') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
