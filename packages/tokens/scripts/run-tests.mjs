#!/usr/bin/env node
// Test runner for @gremion/tokens with a zero-collection guard.
//
// `node --test <file>` exits 0 on a file that registers no tests at all (it
// reports the file itself as one passing test), so neither the exit code nor
// a non-zero TAP plan tells a real run from a suite that stopped registering.
// This runner counts the top-level `test(` declarations in every test file,
// runs node's own runner with the TAP reporter, and refuses unless the number
// of executed top-level tests equals the declared count and is not zero
// (TASK-017/025 convention; TASK-082 brief section 6 item 9).

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join('test', f))

if (files.length === 0) {
  console.error('[tokens] no test files under test/ -- refusing to pass on an empty collection')
  process.exit(1)
}

let declared = 0
for (const f of files) {
  const n = (readFileSync(join(root, f), 'utf8').match(/^test\(/gm) ?? []).length
  if (n === 0) {
    console.error(`[tokens] ${f} declares no top-level test() -- a file that registers nothing still exits 0`)
    process.exit(1)
  }
  declared += n
}

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root,
  encoding: 'utf8',
})
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
process.stdout.write(out)
if (run.status !== 0) {
  console.error(`[tokens] node --test exited ${run.status}`)
  process.exit(run.status ?? 1)
}

// Top-level results are the unindented "ok N - name" / "not ok N - name" lines.
// node --test wraps each FILE in its own top-level result only when a file
// fails to load; a loaded file's tests are reported at column 0 themselves.
const lines = out.replace(/\r/g, '').split('\n')
const topLevel = lines.filter((l) => /^(not )?ok \d+ - /.test(l))
const failed = topLevel.filter((l) => l.startsWith('not ok')).length
if (topLevel.length !== declared) {
  console.error(`[tokens] the suite declares ${declared} top-level test(s) but node ran ${topLevel.length}`)
  process.exit(1)
}
if (failed > 0) {
  console.error(`[tokens] ${failed} failed`)
  process.exit(1)
}
console.log(`[tokens] suite: ${topLevel.length} of ${declared} declared test(s) ran, 0 failed (${files.length} files)`)
