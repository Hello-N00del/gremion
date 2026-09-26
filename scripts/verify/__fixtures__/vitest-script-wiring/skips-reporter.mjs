// TASK-045 round 2: writes a vitest-shaped report with one skipped test in
// a file under this fixture directory, named by ABSOLUTE path the way
// vitest itself names files, so vitestSubcheck's per-file skip attribution
// (repo-relative, posix) can be checked against a real subprocess.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const outArg = process.argv.slice(2).find((a) => a.startsWith('--outputFile='))
const file = path.join(process.cwd(), 'skipped.fixture.test.ts')
writeFileSync(
  outArg.slice('--outputFile='.length),
  JSON.stringify({
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults: [{ name: file, status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'pending' }] }],
  }),
)
