// TASK-045 round 2: a "test script" that writes an all-green vitest-shaped
// report and then exits 1 -- the shape of vitest failing for a reason its
// JSON report does not carry (a crash after the reporter flushed, a
// coverage threshold, an unhandled error). vitestSubcheck used to read only
// the report and ignore the exit code, so this passed.
import { writeFileSync } from 'node:fs'

const outArg = process.argv.slice(2).find((a) => a.startsWith('--outputFile='))
writeFileSync(
  outArg.slice('--outputFile='.length),
  JSON.stringify({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0 }),
)
process.exit(1)
