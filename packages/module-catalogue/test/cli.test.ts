// The CLI (bin/check.mjs): --check <root> and --emit-ops <file>, run under
// plain node exactly as the scoped gate runs it. Asserted on its output and on
// the file it writes; the exit status alone proves nothing.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../', import.meta.url))
const FIX = join(PKG, 'test/fixtures')
const TMP = join(PKG, 'test/.tmp')
afterAll(() => rmSync(join(TMP, `cli-${process.pid}`), { recursive: true, force: true }))

const run = (...args: string[]) => spawnSync(process.execPath, [join(PKG, 'bin/check.mjs'), ...args], { encoding: 'utf8', cwd: PKG })
const BASE = ['--compose', join(FIX, 'compose/base.yml')]

describe('bin/check.mjs', () => {
  it('--check on the three-module fixture root reports 3 of 3 and exits 0', () => {
    const r = run('--check', join(FIX, 'roots/three'), ...BASE)
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/\[module-catalogue\] OK — 3 of 3 module directories under .* carry a valid module\.json/)
    expect(r.status).toBe(0)
  })

  it('--check on an empty root fails and says why', () => {
    const empty = join(TMP, `cli-${process.pid}`, 'empty')
    mkdirSync(empty, { recursive: true })
    const r = run('--check', empty, ...BASE)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no module directory under .* the check would pass vacuously/)
    expect(r.stdout).not.toMatch(/OK/)
  })

  it('--check against a compose file where a module:* server is unclaimed fails', () => {
    const r = run('--check', join(FIX, 'roots/three'), '--compose', join(FIX, 'compose/with-messaging.yml'))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/messaging-postgres is labelled org\.gremion\.postgres=module:messaging but no module\.json claims it/)
  })

  it('--emit-ops writes the derived backup list, colour jobs and platform databases', () => {
    const out = join(TMP, `cli-${process.pid}`, 'ops.json')
    const r = run('--check', join(FIX, 'roots/three'), ...BASE, '--emit-ops', out)
    expect(r.status, r.stderr).toBe(0)
    const ops = JSON.parse(readFileSync(out, 'utf8'))
    expect(ops.backupPostgresServices).toEqual(['postgres', 'alpha-postgres', 'beta-postgres', 'gamma-postgres'])
    expect(ops.colourGatedJobs).toEqual(['alpha-sync', 'gamma-tick'])
    expect(ops.platformDatabases['gamma-postgres']).toEqual(['gamma', 'postgres', 'synapse', 'template0', 'template1'])
  })

  it('--emit-ops refuses to write anything for a catalogue with problems', () => {
    const out = join(TMP, `cli-${process.pid}`, 'refused.json')
    const r = run('--check', join(FIX, 'roots/three'), '--compose', join(FIX, 'compose/with-messaging.yml'), '--emit-ops', out)
    expect(r.status).toBe(1)
    expect(() => readFileSync(out)).toThrow()
  })

  it('arguments are parsed strictly: no --check, an unknown flag, a dropped value', () => {
    for (const args of [[], ['--chek', 'modules'], ['--check']]) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stderr).toMatch(/usage:/)
    }
  })
})
