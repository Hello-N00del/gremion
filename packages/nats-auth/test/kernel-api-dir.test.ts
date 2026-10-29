// TASK-080-a round 3 (HIGH): the kernel API container mounts the volume's kernel-api/ SUBPATH read-only
// and runs as `node` (uid 1000). Two things must hold on every stack:
//   1. the subpath EXISTS before the kernel-api container is created (Docker refuses a missing subpath, and
//      then the whole kernel API is down, not just the relay) -- `init` and `ensure` always create it;
//   2. its owner directory and seed files belong to uid 1000 (tenant-create runs as root and used to leave
//      them root-owned 0700/0600: the relay could not read its own seed) -- and to nobody else's identity.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ensureTenantAccount, initAccounts, type BrokerOps } from '../src/ensure.ts'
import { IMAGE_OWNERS, SeedStore } from '../src/store.ts'
import { NO_POSIX_MODES } from './portable.ts'

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch/t080/nats-auth')
let root: string
let secretsDir: string
let accountsDir: string
let n = 0
beforeEach(() => {
  root = path.join(SCRATCH, `case-${process.pid}-${n++}`)
  rmSync(root, { recursive: true, force: true })
  secretsDir = path.join(root, 'secrets/nats')
  accountsDir = path.join(root, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const broker: BrokerOps = { reload: async () => {}, ensureStreams: async () => {}, assertRevoked: async () => {} }
const mode = (p: string) => statSync(p).mode & 0o777

describe('the kernel-api/ subpath exists on every stack', () => {
  test('nats-auth init creates kernel-api/ (a fresh volume, no customer yet)', async () => {
    await initAccounts({ secretsDir, accountsDir })
    expect(existsSync(path.join(secretsDir, 'kernel-api'))).toBe(true)
    expect(statSync(path.join(secretsDir, 'kernel-api')).isDirectory()).toBe(true)
  })

  test.skipIf(NO_POSIX_MODES)('the directory is 0700 (no module reads another identity seeds)', async () => {
    await initAccounts({ secretsDir, accountsDir })
    expect(mode(path.join(secretsDir, 'kernel-api'))).toBe(0o700)
  })

  test('nats-auth ensure creates it even when the module set does not list kernel-api (a volume init ran on before this change)', async () => {
    await initAccounts({ secretsDir, accountsDir })
    rmSync(path.join(secretsDir, 'kernel-api'), { recursive: true, force: true })
    await ensureTenantAccount({ tenant: 'alpha', modules: ['calendar'] }, { secretsDir, accountsDir, broker })
    expect(existsSync(path.join(secretsDir, 'kernel-api'))).toBe(true)
    expect(existsSync(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'))).toBe(false) // a directory, not an identity: no seed unless listed
  })

  test('init twice changes nothing and does not touch a seed already in kernel-api/', async () => {
    await initAccounts({ secretsDir, accountsDir })
    await ensureTenantAccount({ tenant: 'alpha', modules: ['kernel-api'] }, { secretsDir, accountsDir, broker })
    const before = readFileSync(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'), 'utf8')
    await initAccounts({ secretsDir, accountsDir })
    expect(readFileSync(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'), 'utf8')).toBe(before)
  })
})

describe('the kernel-api identity belongs to the image uid, no other identity does', () => {
  test('the owner table names kernel-api only, with the uid/gid of the image `node` user', () => {
    expect(IMAGE_OWNERS).toEqual({ 'kernel-api': { uid: 1000, gid: 1000 } })
  })

  test('services/kernel-api/Dockerfile runs the runner stage as `node` (the user IMAGE_OWNERS stands for)', () => {
    const df = readFileSync(path.resolve(import.meta.dirname, '../../../services/kernel-api/Dockerfile'), 'utf8')
    const runner = df.slice(df.indexOf('AS runner'))
    expect(runner).toMatch(/^USER node\s*$/m)
    expect(runner).not.toMatch(/^USER (?!node\s*$)/m)
    expect(df).toMatch(/^FROM node:\S+ AS runner/m) // the official node image: `node` is uid/gid 1000
  })

  test('as root: the directory and every seed in it are chowned to 1000:1000; another module is not', async () => {
    const calls: [string, number, number][] = []
    const store = new SeedStore(secretsDir, { isRoot: () => true, chown: (p, uid, gid) => void calls.push([path.relative(secretsDir, p).split(path.sep).join('/'), uid, gid]) })
    await store.ensureSeed('kernel-api', 'alpha')
    await store.ensureSeed('calendar', 'alpha')
    const mine = calls.filter(([p]) => p === 'kernel-api' || p.startsWith('kernel-api/'))
    expect(mine.map(([p]) => p)).toEqual(expect.arrayContaining(['kernel-api', 'kernel-api/tenant_alpha.nk']))
    for (const [, uid, gid] of mine) expect([uid, gid]).toEqual([1000, 1000])
    expect(calls.filter(([p]) => p.startsWith('calendar'))).toEqual([])
    // a seed written earlier by root (the field state before this fix) is handed over on the next run, not left behind
    calls.length = 0
    await store.ensureSeed('kernel-api', 'alpha')
    expect(calls.some(([p, uid]) => p === 'kernel-api/tenant_alpha.nk' && uid === 1000)).toBe(true)
  })

  test.skipIf(NO_POSIX_MODES)('mode stays 0700 / 0600 under the hand-over (only the OWNER changes, never the mode)', async () => {
    const store = new SeedStore(secretsDir, { isRoot: () => true, chown: () => {} })
    await store.ensureSeed('kernel-api', 'alpha')
    expect(mode(path.join(secretsDir, 'kernel-api'))).toBe(0o700)
    expect(mode(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'))).toBe(0o600)
    chmodSync(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'), 0o644)
    await store.ensureSeed('kernel-api', 'alpha')
    expect(mode(path.join(secretsDir, 'kernel-api', 'tenant_alpha.nk'))).toBe(0o600)
  })

  test('not root: no chown is attempted (only root can hand a file over; dev and unit runs have no other uid to give it to)', async () => {
    const calls: string[] = []
    const store = new SeedStore(secretsDir, { isRoot: () => false, chown: (p) => void calls.push(p) })
    await store.ensureSeed('kernel-api', 'alpha')
    expect(calls).toEqual([])
  })

  test('a chown that fails as root fails the run loudly, naming the identity (never a silent root-owned seed)', async () => {
    const store = new SeedStore(secretsDir, {
      isRoot: () => true,
      chown: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
    })
    await expect(store.ensureSeed('kernel-api', 'alpha')).rejects.toThrow(/kernel-api.*1000/s)
  })

  test.runIf(process.getuid?.() === 0)('REAL root run (the image): uid 1000 owns kernel-api/ and its seed; root owns the rest', async () => {
    await initAccounts({ secretsDir, accountsDir })
    await ensureTenantAccount({ tenant: 'alpha', modules: ['kernel-api', 'calendar'] }, { secretsDir, accountsDir, broker })
    for (const p of ['kernel-api', 'kernel-api/tenant_alpha.nk']) {
      const st = statSync(path.join(secretsDir, p))
      expect([st.uid, st.gid], p).toEqual([1000, 1000])
    }
    expect(statSync(path.join(secretsDir, 'calendar/tenant_alpha.nk')).uid).toBe(0)
    expect(statSync(path.join(secretsDir, '_sys/reload.nk')).uid).toBe(0)
  })
})
