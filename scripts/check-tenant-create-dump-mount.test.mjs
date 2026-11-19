// CD stage 1, unit U6g: the tenant-create one-shot shares the pre-migration dump directory with the host. Switching
// a module on again inside its Karenz dumps that ONE blocked database before the pending files are applied, so the
// service carries the directory (mounted at the SAME path as the kernel-api-migrate one-shot and the host) and the
// two keys of the dump code: GREMION_MIGRATION_DUMP_DIR and GREMION_MIGRATION_DUMP_OWNER_UID.
//
// The service runs as root (the `builder` target has no USER line). The dump code accepts the 0700 directory of the
// deploy user (uid 1000) only for a root process that names exactly that owner, and hands every file it writes to
// it; that needs CAP_DAC_OVERRIDE (write into a 0700 directory of another uid) and CAP_CHOWN. The service has no
// cap_drop today, so root has the default set. A later hardening with `cap_drop: [ALL]` would silently break the
// catch-up dump, so this pins that the service keeps both, one way or the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const compose = parse(readFileSync(join(ROOT, 'docker-compose.app.yml'), 'utf8'))
const tenantCreate = compose.services['tenant-create']
const kernelApiMigrate = compose.services['kernel-api-migrate']

/** `${VAR:?msg}` and `${VAR:-default}` with the given environment, the way compose interpolates it. */
function interpolate(text, env) {
  return String(text).replace(/\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g, (_m, name) => {
    if (!(name in env)) throw new Error(`${name} is required and unset`)
    return env[name]
  })
}
const DIR = '/opt/gremion/data/migration-dumps'
const env = { GREMION_MIGRATION_DUMP_DIR: DIR, IMAGE_TAG: 'dist-v0.0.1', COLOUR: 'blue', STACK: 'unit', GREMION_ROOT: '/opt/gremion' }
const dumpMount = (svc) => (svc.volumes ?? []).find((v) => typeof v === 'object' && v.type === 'bind' && String(v.target).includes('GREMION_MIGRATION_DUMP_DIR'))

test('the guard sees both services of the app compose', () => {
  assert.ok(tenantCreate, 'tenant-create not found')
  assert.ok(kernelApiMigrate, 'kernel-api-migrate not found')
})

test('tenant-create carries GREMION_MIGRATION_DUMP_DIR and GREMION_MIGRATION_DUMP_OWNER_UID 1000, rendered', () => {
  assert.equal(interpolate(tenantCreate.environment.GREMION_MIGRATION_DUMP_DIR, env), DIR)
  assert.equal(String(tenantCreate.environment.GREMION_MIGRATION_DUMP_OWNER_UID), '1000')
  assert.equal(String(kernelApiMigrate.environment.GREMION_MIGRATION_DUMP_OWNER_UID ?? ''), '', 'the owner uid belongs to the root one-shot only')
  for (const [name, svc] of Object.entries(compose.services)) {
    if (name === 'tenant-create') continue
    assert.equal(svc.environment?.GREMION_MIGRATION_DUMP_OWNER_UID, undefined, `${name} must not carry GREMION_MIGRATION_DUMP_OWNER_UID`)
  }
})

test('tenant-create mounts the dump directory at the same path as kernel-api-migrate, writable, never created by compose', () => {
  const mine = dumpMount(tenantCreate)
  const theirs = dumpMount(kernelApiMigrate)
  assert.ok(mine, 'tenant-create has no bind mount of the dump directory')
  assert.ok(theirs, 'kernel-api-migrate has no bind mount of the dump directory')
  assert.equal(interpolate(mine.source, env), DIR)
  assert.equal(interpolate(mine.target, env), DIR, 'the path inside the container is the host path')
  assert.equal(interpolate(mine.target, env), interpolate(theirs.target, env))
  assert.equal(mine.bind?.create_host_path, false, 'a missing directory must fail the run, not be created root-owned')
  assert.notEqual(mine.read_only, true, 'the one-shot writes the dump and the ledger')
  assert.equal(interpolate(tenantCreate.environment.GREMION_MIGRATION_DUMP_DIR, env), interpolate(mine.target, env), 'the variable names the mounted path')
})

test('tenant-create keeps CAP_DAC_OVERRIDE and CAP_CHOWN: no cap_drop (the default set), or cap_add naming both; never read_only or a user', () => {
  const drop = (tenantCreate.cap_drop ?? []).map((c) => String(c).toUpperCase().replace(/^CAP_/, ''))
  const add = (tenantCreate.cap_add ?? []).map((c) => String(c).toUpperCase().replace(/^CAP_/, ''))
  const dropped = (cap) => drop.includes('ALL') || drop.includes(cap)
  for (const cap of ['DAC_OVERRIDE', 'CHOWN']) {
    assert.ok(!dropped(cap) || add.includes(cap), `tenant-create drops ${cap}: the catch-up dump (a root process in a 0700 directory of uid 1000, handing its files over) would fail`)
  }
  assert.notEqual(tenantCreate.read_only, true)
  assert.equal(tenantCreate.user, undefined, 'tenant-create runs as root (the dump code expects it); a user: would change the uid model')
})

test('the dump variable is a required one with a source, as for kernel-api-migrate (no new host-filled variable)', () => {
  assert.match(String(tenantCreate.environment.GREMION_MIGRATION_DUMP_DIR), /^\$\{GREMION_MIGRATION_DUMP_DIR:\?/)
  assert.match(String(dumpMount(tenantCreate).source), /^\$\{GREMION_MIGRATION_DUMP_DIR:\?/)
})
