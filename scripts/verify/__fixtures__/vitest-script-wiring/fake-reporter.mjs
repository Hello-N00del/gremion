// TASK-045: stands in for `vitest run --reporter=json --outputFile=<path>`.
// Proves vitestSubcheck actually invokes the package's OWN script (testScript)
// rather than a hard-coded `vitest run` -- this script is reachable ONLY
// through the "test:custom" script name, never "test:unit".
//
// It also mimics how real vitest (4.x, via cac) treats a literal `--`: every
// argument AFTER it is positional, never an option. pnpm 10 forwards a `--`
// given to `pnpm run <script> -- ...` verbatim, so a caller that inserts one
// hands vitest `-- --reporter=json --outputFile=...`, vitest ignores both
// flags, prints its default report and writes no JSON file at all.
// Reproduced against packages/ports on 2026-09-25: "vitest produced no
// parseable JSON report (exit 0)" with the default-reporter summary
// underneath. This fixture reproduces that: with a `--` before the flag it
// writes nothing.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const sep = args.indexOf('--')
const options = sep === -1 ? args : args.slice(0, sep)
const outArg = options.find((a) => a.startsWith('--outputFile='))
if (!outArg) {
  console.log('fake-reporter: no --outputFile option before any `--` -- writing no report, like vitest')
  process.exit(0)
}
const outFile = outArg.slice('--outputFile='.length)
writeFileSync(
  outFile,
  JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0 }),
)
