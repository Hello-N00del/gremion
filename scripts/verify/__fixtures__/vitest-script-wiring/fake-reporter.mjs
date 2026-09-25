// TASK-045: stands in for `vitest run --reporter=json --outputFile=<path>`.
// Proves vitestSubcheck actually invokes the package's OWN script (testScript)
// rather than a hard-coded `vitest run` -- this script is reachable ONLY
// through the "test:custom" script name, never "test:unit".
import { writeFileSync } from 'node:fs'

const outArg = process.argv.find((a) => a.startsWith('--outputFile='))
const outFile = outArg.slice('--outputFile='.length)
writeFileSync(
  outFile,
  JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0 }),
)
