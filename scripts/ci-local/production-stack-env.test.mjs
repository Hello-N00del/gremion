// TASK-028 intake round 3 (verify-r1/r2 HIGH 2). gremion-ui's integration and
// deselection configs give GREMION_PRODUCTION_STACK no default (D2) and refuse
// to load while it is unset, so the committed kernel suites that run them must
// declare it. Their DATABASE_URL comes from the operator's ambient stack env,
// so the command declares `none` only when the ambient env declares nothing:
// a host that declares its production stack keeps it, and the guard then
// refuses a loopback URL there (fail closed).
//
// The committed command is run VERBATIM through lib/run.mjs (the same shell
// path snapshot.mjs uses), with a fake `pnpm` first on PATH that reports the
// value it received -- no vitest, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from './lib/manifest.mjs'
import { run } from './lib/run.mjs'

const KEY = 'GREMION_PRODUCTION_STACK'
const manifest = loadManifest(fileURLToPath(new URL('./suites.json', import.meta.url)))
const SUITES = {
  'kernel-ui-vitest-integration': 'run test:integration',
  'kernel-ui-vitest-deselection': 'run test:deselection',
}

function withFakePnpm(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-prodstack-'))
  writeFileSync(
    join(dir, 'fake-pnpm.mjs'),
    "console.log(`GPS=[${process.env.GREMION_PRODUCTION_STACK ?? ''}] ARGS=[${process.argv.slice(2).join(' ')}]`)\n" +
      'process.exit(Number(process.env.FAKE_PNPM_EXIT ?? 0))\n',
  )
  writeFileSync(join(dir, 'pnpm.cmd'), '@node "%~dp0fake-pnpm.mjs" %*\r\n')
  writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-pnpm.mjs" "$@"\n')
  chmodSync(join(dir, 'pnpm'), 0o755)
  const saved = { PATH: process.env.PATH, [KEY]: process.env[KEY], FAKE_PNPM_EXIT: process.env.FAKE_PNPM_EXIT }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`
  try {
    return fn(dir)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function suiteCommand(id) {
  const suite = manifest.kernel.find((s) => s.id === id)
  assert.ok(suite, `suites.json has no kernel suite ${id}`)
  return suite.command
}

for (const [id, args] of Object.entries(SUITES)) {
  test(`${id}: declares ${KEY}=none when the ambient env declares nothing`, () => {
    withFakePnpm((dir) => {
      delete process.env[KEY]
      const r = run(suiteCommand(id), dir, { timeoutMs: 60_000 })
      assert.equal(r.exitCode, 0, r.output)
      assert.match(r.output, new RegExp(`GPS=\\[none\\] ARGS=\\[${args}\\]`), r.output)
    })
  })

  test(`${id}: treats a blank ambient ${KEY} as undeclared`, () => {
    withFakePnpm((dir) => {
      process.env[KEY] = '  '
      const r = run(suiteCommand(id), dir, { timeoutMs: 60_000 })
      assert.match(r.output, /GPS=\[none\]/, r.output)
    })
  })

  test(`${id}: keeps a production stack the ambient env declares (the guard then fails closed on loopback)`, () => {
    withFakePnpm((dir) => {
      process.env[KEY] = 'gremion'
      const r = run(suiteCommand(id), dir, { timeoutMs: 60_000 })
      assert.match(r.output, /GPS=\[gremion\]/, r.output)
    })
  })

  test(`${id}: a failing test run still fails the suite (the wrapper passes the exit code through)`, () => {
    withFakePnpm((dir) => {
      delete process.env[KEY]
      process.env.FAKE_PNPM_EXIT = '3'
      const r = run(suiteCommand(id), dir, { timeoutMs: 60_000 })
      assert.equal(r.exitCode, 3, r.output)
    })
  })
}
