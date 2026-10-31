// Kernel issue #88: an upgrade leaves every customer created before the kernel-api event relay without a
// kernel-api/tenant_<slug>.nk seed, and nothing re-ensures it. tenantAccountProblems is the read-only half
// reconcile (verify) reports from; ensureTenantAccount over withPlatformIdentities(modules) is the repair
// (reconcile --apply), and the same wrapper keeps the seed through every later enable, disable, suspend and
// resume (a plain ensure of the module set would delete it: seeds of identities outside the set are removed).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ensureTenantAccount, initAccounts, tenantAccountProblems, withPlatformIdentities, type BrokerOps } from '../src/ensure.ts'
import { PLATFORM_IDENTITIES } from '../src/flows.ts'

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch/t088/nats-auth')
let root: string
let secretsDir: string
let accountsDir: string
let n = 0
beforeEach(async () => {
  root = path.join(SCRATCH, `case-${process.pid}-${n++}`)
  rmSync(root, { recursive: true, force: true })
  secretsDir = path.join(root, 'secrets/nats')
  accountsDir = path.join(root, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
  await initAccounts({ secretsDir, accountsDir })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function fakeBroker() {
  const calls = { reload: 0, ensureStreams: [] as string[][] }
  const broker: BrokerOps = {
    reload: async () => {
      calls.reload++
    },
    ensureStreams: async (_t, streams) => {
      calls.ensureStreams.push(streams)
    },
    assertRevoked: async () => {},
  }
  return { broker, calls }
}
const seedFile = (t: string, who = 'kernel-api') => path.join(secretsDir, who, `tenant_${t}.nk`)
const opts = (broker?: BrokerOps) => ({ secretsDir, accountsDir, ...(broker ? { broker } : {}) })

describe('platform identities (kernel-api) are part of every customer module set', () => {
  test('the table names kernel-api, and the wrapper adds it once, sorted, without touching the input', () => {
    expect([...PLATFORM_IDENTITIES]).toEqual(['kernel-api'])
    const input = ['finance', 'calendar']
    expect(withPlatformIdentities(input)).toEqual(['calendar', 'finance', 'kernel-api'])
    expect(withPlatformIdentities(['kernel-api', 'calendar'])).toEqual(['calendar', 'kernel-api'])
    expect(input).toEqual(['finance', 'calendar'])
    expect(withPlatformIdentities([])).toEqual(['kernel-api'])
  })
})

describe('a customer created before the relay (no kernel-api seed)', () => {
  test('verify names the missing seed; apply (ensure over the CURRENT set + kernel-api) writes it and reloads; a second apply is a no-op', async () => {
    const { broker, calls } = fakeBroker()
    const current = ['calendar'] // what the registry says today
    // the pre-change create: the registry set only
    await ensureTenantAccount({ tenant: 'alpha', modules: current }, opts(broker))
    expect(existsSync(seedFile('alpha'))).toBe(false)

    const before = tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(current) }, opts())
    expect(before.join('\n')).toContain('kernel-api/tenant_alpha.nk')

    const calendarBefore = readFileSync(seedFile('alpha', 'calendar'), 'utf8')
    const reloadsBefore = calls.reload
    const applied = await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(current) }, opts(broker))
    expect(applied.createdUsers).toEqual(['kernel-api'])
    expect(applied.reloaded).toBe(true)
    expect(calls.reload).toBe(reloadsBefore + 1)
    expect(existsSync(seedFile('alpha'))).toBe(true)
    // the customer's own modules were not touched: not a guessed set, not a rotation
    expect(readFileSync(seedFile('alpha', 'calendar'), 'utf8')).toBe(calendarBefore)
    expect(tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(current) }, opts())).toEqual([])

    const again = await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(current) }, opts(broker))
    expect(again.createdUsers).toEqual([])
    expect(again.removedUsers).toEqual([])
    expect(again.reloaded).toBe(false)
    expect(calls.reload).toBe(reloadsBefore + 1)
  })

  test('the seed written by the repair survives a later module change made through the same wrapper', async () => {
    const { broker } = fakeBroker()
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(['calendar', 'content']) }, opts(broker))
    const seed = readFileSync(seedFile('alpha'), 'utf8')
    // disable a module, suspend (empty set), resume
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts(broker))
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities([]) }, opts(broker))
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(['calendar', 'content']) }, opts(broker))
    expect(readFileSync(seedFile('alpha'), 'utf8')).toBe(seed)
  })

  test('why the wrapper exists: a plain ensure of the module set deletes the kernel-api seed again', async () => {
    const { broker } = fakeBroker()
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts(broker))
    expect(existsSync(seedFile('alpha'))).toBe(true)
    await ensureTenantAccount({ tenant: 'alpha', modules: ['calendar'] }, opts(broker))
    expect(existsSync(seedFile('alpha'))).toBe(false)
  })
})

describe('tenantAccountProblems', () => {
  test('a customer with no account at all, and a volume nats-auth init never ran on, are named', () => {
    expect(tenantAccountProblems({ tenant: 'ghost', modules: ['kernel-api'] }, opts()).join('\n')).toMatch(/admin/)
    const empty = path.join(root, 'empty-secrets')
    mkdirSync(empty, { recursive: true })
    expect(tenantAccountProblems({ tenant: 'ghost', modules: ['kernel-api'] }, { secretsDir: empty, accountsDir }).join('\n')).toMatch(/nats-auth init/)
  })

  test('seeds present but the accounts file stale or never confirmed loaded: reported (the broker has not reloaded)', async () => {
    const { broker } = fakeBroker()
    await ensureTenantAccount({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts(broker))
    expect(tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts())).toEqual([])
    rmSync(path.join(accountsDir, '.loaded.sha256'))
    expect(tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts()).join('\n')).toMatch(/not (known to be )?loaded/)
    writeFileSync(path.join(accountsDir, 'accounts.conf'), '# stale\n')
    expect(tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts()).join('\n')).toMatch(/not (known to be )?loaded/)
  })

  test('a module id outside FLOWS and NO_BROKER is a problem line, never a throw', () => {
    expect(tenantAccountProblems({ tenant: 'alpha', modules: ['no-such-module'] }, opts()).join('\n')).toContain('no-such-module')
  })

  test('is read-only: it writes no seed, no file, takes no lock', async () => {
    const before = existsSync(seedFile('alpha'))
    tenantAccountProblems({ tenant: 'alpha', modules: withPlatformIdentities(['calendar']) }, opts())
    expect(existsSync(seedFile('alpha'))).toBe(before)
    expect(existsSync(path.join(secretsDir, '_sys', '.lock'))).toBe(false)
  })
})
