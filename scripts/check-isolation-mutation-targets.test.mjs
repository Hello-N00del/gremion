// Guard: the tenant-isolation mutation proof (test/isolation/tenant/mutation-proof.sh) can
// still APPLY every mutation it lists.
//
// The proof breaks the isolation code one exact line at a time and requires the producer to
// go red. Each mutation names its target line literally, so a refactor that rewrites that
// line makes the full pass die half way ("could not apply a mutation"), and every mutation
// listed after it is never reached. The full pass needs a throwaway Postgres and ~30 s per
// mutation, so nothing would notice until someone ran it. `--check-targets` is the offline
// form: no Postgres, no clone, it only requires each target to occur exactly once.
//
// Run: node --test scripts/check-isolation-mutation-targets.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROOF = join(ROOT, 'test', 'isolation', 'tenant', 'mutation-proof.sh')

function checkTargets(script) {
  const r = spawnSync('bash', [script, '--check-targets'], { encoding: 'utf8', env: { ...process.env, ISOLATION_TENANT_PG_URL: '' } })
  assert.equal(r.error, undefined, `bash could not be spawned: ${r.error}`)
  return r
}

test('every mutation target of the isolation proof occurs exactly once in this tree', () => {
  const r = checkTargets(PROOF)
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  // vacuity: the mode must have walked the whole list, not nothing
  const listed = spawnSync('bash', [PROOF, '--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  assert.ok(listed.length >= 15, `only ${listed.length} mutations are listed`)
  assert.match(r.stdout, new RegExp(`all ${listed.length} mutation targets occur exactly once`))
})

test('the path-guard mutations cover the bare dot-dot check AND the hidden-suffix helper', () => {
  const listed = spawnSync('bash', [PROOF, '--list'], { encoding: 'utf8' }).stdout.split('\n')
  assert.ok(listed.includes('e-dotdot'))
  assert.ok(listed.includes('e-dothidden'), 'isDotSegment (`..?x`, `..#x`, `.. `) has no mutation')
})

test('a target line that no longer exists makes the check fail loudly (negative control)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mut-targets-'))
  try {
    cpSync(join(ROOT, 'modules'), join(tmp, 'modules'), { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) })
    // the board mutation targets the kernel's own getDb(), outside modules/
    cpSync(join(ROOT, 'gremion-ui', 'src', 'lib', 'server', 'db.ts'), join(tmp, 'gremion-ui', 'src', 'lib', 'server', 'db.ts'))
    cpSync(join(ROOT, 'test', 'isolation', 'tenant', 'mutation-proof.sh'), join(tmp, 'test', 'isolation', 'tenant', 'mutation-proof.sh'))
    const ok =checkTargets(join(tmp, 'test', 'isolation', 'tenant', 'mutation-proof.sh'))
    assert.equal(ok.status, 0, `the copied tree must pass first: ${ok.stdout}\n${ok.stderr}`)

    const guard = join(tmp, 'modules', 'files', 'app', 'lib', 'server', 'files', 'webdav-path.ts')
    const src = readFileSync(guard, 'utf8')
    assert.ok(src.includes('.some(isDotSegment)'))
    writeFileSync(guard, src.replace('.some(isDotSegment)', ".some((seg) => seg === '..')"))
    const bad = checkTargets(join(tmp, 'test', 'isolation', 'tenant', 'mutation-proof.sh'))
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr, /occurs 0 time\(s\)/)
    assert.match(bad.stderr, /could not apply a mutation/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
