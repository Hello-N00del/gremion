// TDD 4 — ensureTenantAccount() and nats-auth init, against a fake broker
// (reload / stream calls recorded) and a real seed store in a scratch dir.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fromSeed } from '@nats-io/nkeys'
import { ensureTenantAccount, initAccounts, type BrokerOps } from '../src/ensure.ts'
import { natsConnectOptionsFor } from '../src/connect.ts'
import { natsBrokerOps } from '../src/broker-ops.ts'
import { SeedStore } from '../src/store.ts'

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch/t024/unit')
let root: string
let secretsDir: string
let accountsDir: string

class FakeBroker implements BrokerOps {
  reloads = 0
  streams: { tenant: string; streams: string[] }[] = []
  revoked: string[][] = []
  failReload: Error | undefined
  failStreams: Error | undefined
  failRevoked: Error | undefined
  async reload(): Promise<void> {
    if (this.failReload) throw this.failReload
    this.reloads++
  }
  async ensureStreams(tenant: string, streams: string[]): Promise<void> {
    if (this.failStreams) throw this.failStreams
    this.streams.push({ tenant, streams })
  }
  async assertRevoked(_tenant: string, seeds: { module: string; seed: Uint8Array }[]): Promise<void> {
    if (this.failRevoked) throw this.failRevoked
    this.revoked.push(seeds.map((s) => s.module))
  }
}

let n = 0
beforeEach(() => {
  root = path.join(SCRATCH, `case-${process.pid}-${n++}`)
  rmSync(root, { recursive: true, force: true })
  secretsDir = path.join(root, 'secrets/nats')
  accountsDir = path.join(root, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const conf = () => readFileSync(path.join(accountsDir, 'accounts.conf'), 'utf8')
const mode = (p: string) => statSync(p).mode & 0o777
const seedFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else out.push(path.relative(secretsDir, path.join(d, e.name)))
    }
  }
  if (existsSync(secretsDir)) walk(secretsDir)
  return out.sort()
}

async function init() {
  return initAccounts({ secretsDir, accountsDir })
}

describe('nats-auth init (TDD 4)', () => {
  test('creates _sys/reload.nk 0600 and a SYS-only accounts.conf; idempotent', async () => {
    const r1 = await init()
    expect(r1.createdSysReload).toBe(true)
    const seedPath = path.join(secretsDir, '_sys/reload.nk')
    expect(mode(seedPath)).toBe(0o600)
    expect(mode(path.join(secretsDir, '_sys'))).toBe(0o700)
    expect(conf()).toMatch(/^\s*SYS \{/m)
    expect(conf()).not.toMatch(/T_/)
    const bytes = conf()
    const seed = readFileSync(seedPath, 'utf8')
    const r2 = await init()
    expect(r2.createdSysReload).toBe(false)
    expect(r2.wrote).toBe(false)
    expect(conf()).toBe(bytes)
    expect(readFileSync(seedPath, 'utf8')).toBe(seed)
  })
})

describe('ensureTenantAccount (TDD 4)', () => {
  test('first call creates admin + kernel + flow modules, reloads, ensures the streams', async () => {
    await init()
    const b = new FakeBroker()
    const r = await ensureTenantAccount({ tenant: 'ta', modules: ['publishing', 'finance', 'board'] }, { secretsDir, accountsDir, broker: b })
    expect(r).toEqual({ accountRef: 'T_ta', createdUsers: ['admin', 'finance', 'kernel', 'publishing'], removedUsers: [], reloaded: true })
    expect(b.reloads).toBe(1)
    expect(b.streams).toEqual([{ tenant: 'ta', streams: ['CALENDAR', 'CONTENT', 'NEWSLETTER', 'ORGUNIT'] }])
    expect(seedFiles()).toEqual(['_admin/tenant_ta.nk', '_sys/reload.nk', 'finance/tenant_ta.nk', 'kernel/tenant_ta.nk', 'publishing/tenant_ta.nk'])
    for (const f of seedFiles()) expect(mode(path.join(secretsDir, f)), f).toBe(0o600)
    expect(conf()).toMatch(/T_ta \{/)
    expect(conf()).not.toMatch(/# board@ta/)
  })

  test('I1: a second identical call creates no key, writes identical bytes, returns reloaded:false', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })
    const bytes = conf()
    const seeds = seedFiles().map((f) => readFileSync(path.join(secretsDir, f), 'utf8'))
    const r = await ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })
    expect(r).toEqual({ accountRef: 'T_ta', createdUsers: [], removedUsers: [], reloaded: false })
    expect(b.reloads).toBe(1)
    expect(conf()).toBe(bytes)
    expect(seedFiles().map((f) => readFileSync(path.join(secretsDir, f), 'utf8'))).toEqual(seeds)
  })

  test('I2: adding a module adds exactly one user and reloads', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })
    const r = await ensureTenantAccount({ tenant: 'ta', modules: ['publishing', 'calendar'] }, { secretsDir, accountsDir, broker: b })
    expect(r).toEqual({ accountRef: 'T_ta', createdUsers: ['calendar'], removedUsers: [], reloaded: true })
    expect(b.reloads).toBe(2)
  })

  test('drop deletes the user and its seed; _admin and _sys untouched', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['publishing', 'finance'] }, { secretsDir, accountsDir, broker: b })
    await ensureTenantAccount({ tenant: 'tb', modules: ['finance'] }, { secretsDir, accountsDir, broker: b })
    const admin = readFileSync(path.join(secretsDir, '_admin/tenant_ta.nk'), 'utf8')
    const sys = readFileSync(path.join(secretsDir, '_sys/reload.nk'), 'utf8')
    const financePub = fromSeed(new TextEncoder().encode(readFileSync(path.join(secretsDir, 'finance/tenant_ta.nk'), 'utf8').trim())).getPublicKey()
    const r = await ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })
    expect(r.removedUsers).toEqual(['finance'])
    expect(existsSync(path.join(secretsDir, 'finance/tenant_ta.nk'))).toBe(false)
    expect(existsSync(path.join(secretsDir, 'finance/tenant_tb.nk')), 'another tenant\'s seed').toBe(true)
    expect(readFileSync(path.join(secretsDir, '_admin/tenant_ta.nk'), 'utf8')).toBe(admin)
    expect(readFileSync(path.join(secretsDir, '_sys/reload.nk'), 'utf8')).toBe(sys)
    expect(conf()).not.toContain(financePub)
  })

  test('suspend (empty set) keeps only admin and kernel', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['publishing', 'content'] }, { secretsDir, accountsDir, broker: b })
    const r = await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })
    expect(r.removedUsers).toEqual(['content', 'publishing'])
    expect(seedFiles()).toEqual(['_admin/tenant_ta.nk', '_sys/reload.nk', 'kernel/tenant_ta.nk'])
  })

  test('a crash after the seed write converges: the seed is truth', async () => {
    await init()
    const b = new FakeBroker()
    // simulate: seeds written, then the process died before render/reload
    const store = new SeedStore(secretsDir)
    await store.ensureSeed('_admin', 'ta')
    const k = await store.ensureSeed('kernel', 'ta')
    writeFileSync(path.join(secretsDir, 'kernel/tenant_ta.nk.tmp-999-dead'), 'garbage')
    const r = await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })
    expect(r.createdUsers).toEqual([])
    expect(r.reloaded).toBe(true)
    expect(conf()).toContain(k.publicKey)
    expect(seedFiles()).not.toContain('kernel/tenant_ta.nk.tmp-999-dead')
  })

  test('a crash after the config write but before the reload converges: the rerun reloads', async () => {
    await init()
    const b = new FakeBroker()
    b.failReload = new Error('connection refused')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })).rejects.toThrow(/NOT loaded.*connection refused/s)
    b.failReload = undefined
    const r = await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })
    expect(r.reloaded).toBe(true)
    expect(b.reloads).toBe(1)
  })

  test('without nats-auth init it fails loudly', async () => {
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/_sys\/reload\.nk.*nats-auth init/)
  })

  test('an unknown module fails loudly before anything is written', async () => {
    await init()
    await expect(ensureTenantAccount({ tenant: 'ta', modules: ['nope'] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/nope .*neither FLOWS nor NO_BROKER/)
    expect(seedFiles()).toEqual(['_sys/reload.nk'])
  })

  test('an unwritable secrets dir fails loudly', async () => {
    mkdirSync(root, { recursive: true })
    const blocked = path.join(root, 'not-a-dir')
    writeFileSync(blocked, '')
    await expect(initAccounts({ secretsDir: path.join(blocked, 'nats'), accountsDir })).rejects.toThrow(/not-a-dir/)
  })

  test('a corrupt seed fails loudly instead of being replaced', async () => {
    await init()
    mkdirSync(path.join(secretsDir, 'kernel'), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(secretsDir, 'kernel/tenant_ta.nk'), 'not a seed', { mode: 0o600 })
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/kernel\/tenant_ta\.nk.*not a user seed/)
  })

  test('a module seed without its tenant admin seed fails loudly', async () => {
    await init()
    await new SeedStore(secretsDir).ensureSeed('finance', 'tz')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/without a tenant admin seed: finance\/tenant_tz\.nk/)
  })

  test('a drop whose reload fails keeps the seed; the rerun still reports the removal', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['publishing', 'finance'] }, { secretsDir, accountsDir, broker: b })
    b.failReload = new Error('connection refused')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })).rejects.toThrow(/NOT loaded/)
    expect(existsSync(path.join(secretsDir, 'finance/tenant_ta.nk')), 'seed deleted before the server dropped the key').toBe(true)
    b.failReload = undefined
    const r = await ensureTenantAccount({ tenant: 'ta', modules: ['publishing'] }, { secretsDir, accountsDir, broker: b })
    expect(r.removedUsers).toEqual(['finance'])
    expect(b.revoked).toEqual([['finance']])
    expect(existsSync(path.join(secretsDir, 'finance/tenant_ta.nk'))).toBe(false)
  })

  test('a dropped key the server still admits fails loudly and keeps the seed', async () => {
    await init()
    const b = new FakeBroker()
    await ensureTenantAccount({ tenant: 'ta', modules: ['finance'] }, { secretsDir, accountsDir, broker: b })
    b.failRevoked = new Error('finance@ta still admitted')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })).rejects.toThrow(/still admitted/)
    expect(existsSync(path.join(secretsDir, 'finance/tenant_ta.nk'))).toBe(true)
  })

  test('the loaded marker is written only after the streams are ensured', async () => {
    await init()
    const b = new FakeBroker()
    b.failStreams = new Error('admin not admitted')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })).rejects.toThrow(/admin not admitted/)
    b.failStreams = undefined
    const r = await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: b })
    expect(r.reloaded, 'the rerun trusted a marker written before the streams').toBe(true)
  })

  test('without NATS_URL (and no broker) nothing in the store changes', async () => {
    await init()
    await ensureTenantAccount({ tenant: 'ta', modules: ['finance'] }, { secretsDir, accountsDir, broker: new FakeBroker() })
    const before = seedFiles()
    const saved = process.env.NATS_URL
    delete process.env.NATS_URL
    try {
      await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir })).rejects.toThrow(/NATS_URL is unset/)
    } finally {
      if (saved !== undefined) process.env.NATS_URL = saved
    }
    expect(seedFiles()).toEqual(before)
  })

  test('a run holding the lock makes a second run fail loudly; a stale lock is taken over', async () => {
    await init()
    const store = new SeedStore(secretsDir)
    const release = store.lock()
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/another nats-auth run holds/)
    await expect(initAccounts({ secretsDir, accountsDir })).rejects.toThrow(/another nats-auth run holds/)
    release()
    const again = store.lock()
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(path.join(secretsDir, '_sys/.lock'), old, old)
    const r = await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })
    expect(r.reloaded).toBe(true)
    again() // releasing a lock someone took over is harmless
    expect(existsSync(path.join(secretsDir, '_sys/.lock')), 'the run left its lock behind').toBe(false)
  })

  test('a seed of a module that left FLOWS names the cleanup', async () => {
    await init()
    await ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })
    mkdirSync(path.join(secretsDir, 'votes'), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(secretsDir, 'votes/tenant_tb.nk'), readFileSync(path.join(secretsDir, 'kernel/tenant_ta.nk')), { mode: 0o600 })
    await new SeedStore(secretsDir).ensureSeed('_admin', 'tb')
    await expect(ensureTenantAccount({ tenant: 'ta', modules: [] }, { secretsDir, accountsDir, broker: new FakeBroker() })).rejects.toThrow(/votes\/tenant_tb\.nk.*re-ensure tenant tb/)
  })

  test('natsConnectOptionsFor reads the module seed and sets its inbox prefix and name', async () => {
    await init()
    await ensureTenantAccount({ tenant: 'ta', modules: ['finance'] }, { secretsDir, accountsDir, broker: new FakeBroker() })
    const o = natsConnectOptionsFor('ta', 'finance', { secretsDir })
    expect(o.inboxPrefix).toBe('_INBOX_finance_ta')
    expect(o.name).toBe('finance@ta')
    expect(typeof o.authenticator).toBe('function')
    expect(() => natsConnectOptionsFor('ta', 'content', { secretsDir })).toThrow(/content\/tenant_ta\.nk/)
  })
})

describe('the real broker ops (TDD 4)', () => {
  test('broker not up: retries, then fails loudly naming the url and attempts', async () => {
    await init()
    const ops = natsBrokerOps({ url: 'nats://127.0.0.1:1', secretsDir, attempts: 3, delayMs: 20 })
    const t0 = Date.now()
    await expect(ops.reload()).rejects.toThrow(/nats:\/\/127\.0\.0\.1:1 .*after 3 attempts/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
  })
})
