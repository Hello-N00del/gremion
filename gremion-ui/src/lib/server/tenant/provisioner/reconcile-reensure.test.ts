// Kernel issues #88 and #89: create-time provisioning that a later release extends is never re-applied to
// customers created earlier. `reconcile` therefore carries two re-ensure checks, `purger-connect` (the purge run
// logs in as the customer's purger) and `kernel-api-nats-seed` (the kernel API relay needs its NATS seed), that
// a plain reconcile REPORTS and `--apply` REPAIRS, idempotently.
//
// The NATS half runs here over the real @gremion/nats-auth on a temporary seed store with a fake broker; the
// purger half over a stateful fake port (packages/tenant-store/test/integration/purger-connect.test.ts proves the
// real grant against a real server, and a purge run with errors 0 after it).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTenantAccount, initAccounts, tenantAccountProblems, type BrokerOps } from '@gremion/nats-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReconcileReport } from './reconcile'
import { REENSURE_CHECK_NAMES } from './reconcile'
import { reconcileKernelApiSeed, withReensureCheck, type KernelApiSeedDeps, type ReensurePort } from './reconcile-reensure'

const GREEN: ReconcileReport = { realm: 'musterstadt', ok: true, checks: [{ name: 'ssl-required', ok: true, detail: '' }], applied: [], repairHost: [] }
const TENANT = { id: '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6', slug: 'musterstadt', status: 'active' as const }

describe('withReensureCheck', () => {
  const port = (states: string[][]) => {
    const seq = [...states]
    return { problems: vi.fn(async () => (seq.length > 1 ? seq.shift()! : seq[0]!)), repair: vi.fn(async () => {}) } satisfies ReensurePort
  }

  it('the names are entries of their own, outside the realm contract list', async () => {
    expect([...REENSURE_CHECK_NAMES]).toEqual(['purger-connect', 'kernel-api-nats-seed'])
    const { RECONCILE_CHECK_NAMES } = await import('./reconcile')
    for (const n of REENSURE_CHECK_NAMES) expect((RECONCILE_CHECK_NAMES as readonly string[]).includes(n)).toBe(false)
  })

  it('a clean state adds a passing check and repairs nothing', async () => {
    const p = port([[]])
    const r = await withReensureCheck(GREEN, 'purger-connect', p, false)
    expect(r.ok).toBe(true)
    expect(r.checks.at(-1)).toEqual({ name: 'purger-connect', ok: true, detail: '' })
    expect(r.applied).toEqual([])
    expect(p.repair).not.toHaveBeenCalled()
  })

  it('verify reports the drift, turns the report red and repairs nothing', async () => {
    const p = port([['the purger role k_x_purger lacks CONNECT']])
    const r = await withReensureCheck(GREEN, 'purger-connect', p, true)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'purger-connect', ok: false })
    expect(r.checks.at(-1)!.detail).toContain('lacks CONNECT')
    expect(p.repair).not.toHaveBeenCalled()
    expect(r.applied).toEqual([])
  })

  it('apply repairs once, reads the post-condition back, lists the repair', async () => {
    const p = port([['lacks CONNECT'], []])
    const r = await withReensureCheck(GREEN, 'purger-connect', p, false)
    expect(p.repair).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual(['purger-connect'])
  })

  it('apply that leaves the drift in place stays RED and is not listed as applied', async () => {
    const p = port([['lacks CONNECT']])
    const r = await withReensureCheck(GREEN, 'purger-connect', p, false)
    expect(r.ok).toBe(false)
    expect(r.applied).toEqual([])
  })

  it('a port that throws fails the check with the reason; it never crashes the report', async () => {
    const p = { problems: vi.fn(async () => { throw new Error('connection refused') }), repair: vi.fn(async () => {}) }
    const r = await withReensureCheck(GREEN, 'kernel-api-nats-seed', p, true)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)!.detail).toContain('connection refused')
  })

  it('no port (not applicable): the report is returned as it was', async () => {
    expect(await withReensureCheck(GREEN, 'purger-connect', null, false)).toBe(GREEN)
  })

  it('an earlier red check stays red whatever this one says', async () => {
    const red: ReconcileReport = { ...GREEN, ok: false, checks: [{ name: 'ssl-required', ok: false, detail: 'x' }] }
    const r = await withReensureCheck(red, 'purger-connect', port([[]]), false)
    expect(r.ok).toBe(false)
  })
})

describe('a customer created before the relay and before the purger CONNECT grant (the pre-change shape)', () => {
  let root: string
  let secretsDir: string
  let accountsDir: string
  let reloads = 0
  let registry: string[]
  let registryRead: (id: string) => Promise<string[]>
  const broker: BrokerOps = {
    reload: async () => {
      reloads++
    },
    ensureStreams: async () => {},
    assertRevoked: async () => {},
  }
  const seed = (who: string) => join(secretsDir, who, `tenant_${TENANT.slug}.nk`)
  const nats = (): KernelApiSeedDeps => ({
    enabledModules: (id) => registryRead(id),
    problems: (i) => tenantAccountProblems(i, { secretsDir, accountsDir }),
    ensure: (i) => ensureTenantAccount(i, { secretsDir, accountsDir, broker }),
  })
  // a stateful stand-in for the purger's CONNECT (the real grant: tenant-store purger-connect integration test)
  let connect: boolean
  let grants: number
  const purger: ReensurePort = {
    problems: async () => (connect ? [] : ['the purger role k_x_purger lacks CONNECT on t_x__kernel']),
    repair: async () => {
      grants++
      connect = true
    },
  }
  async function reconcile(verifyOnly: boolean, tenant: { id: string; slug: string; status: string } = TENANT) {
    const withPurger = await withReensureCheck(GREEN, 'purger-connect', purger, verifyOnly)
    return reconcileKernelApiSeed(withPurger, tenant, nats(), verifyOnly)
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'reconcile-reensure-'))
    secretsDir = join(root, 'secrets')
    accountsDir = join(root, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    await initAccounts({ secretsDir, accountsDir })
    registry = ['calendar']
    registryRead = vi.fn(async () => registry)
    // the old release: the registry set only, no kernel-api, no purger CONNECT
    await ensureTenantAccount({ tenant: TENANT.slug, modules: registry }, { secretsDir, accountsDir, broker })
    reloads = 0
    connect = false
    grants = 0
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a plain reconcile (verify) reports BOTH drifts, by their names, and changes nothing', async () => {
    const r = await reconcile(true)
    expect(r.ok).toBe(false)
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['purger-connect', 'kernel-api-nats-seed'])
    expect(r.checks.find((c) => c.name === 'kernel-api-nats-seed')!.detail).toContain('kernel-api/tenant_musterstadt.nk')
    expect(r.applied).toEqual([])
    expect(existsSync(seed('kernel-api'))).toBe(false)
    expect(grants).toBe(0)
    expect(reloads).toBe(0)
  })

  it('--apply repairs both with the registry module set (the customer modules are untouched), reloads the account once, and the report is green', async () => {
    const calendar = readFileSync(seed('calendar'), 'utf8')
    const r = await reconcile(false)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual(['purger-connect', 'kernel-api-nats-seed'])
    expect(existsSync(seed('kernel-api'))).toBe(true)
    expect(readFileSync(seed('calendar'), 'utf8')).toBe(calendar)
    expect(reloads).toBe(1)
    expect(connect).toBe(true)
    expect(registryRead).toHaveBeenCalledWith(TENANT.id)
  })

  it('a second --apply is a no-op: nothing applied, no grant, no reload, no new seed', async () => {
    await reconcile(false)
    const kernelApi = readFileSync(seed('kernel-api'), 'utf8')
    const r = await reconcile(false)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual([])
    expect(grants).toBe(1)
    expect(reloads).toBe(1)
    expect(readFileSync(seed('kernel-api'), 'utf8')).toBe(kernelApi)
    expect((await reconcile(true)).ok).toBe(true)
  })

  it('the repair never invents a module set: it is read from the registry per customer id, and a registry that cannot be read fails the check without writing', async () => {
    registryRead = vi.fn(async () => {
      throw new Error('the platform database is unreachable')
    })
    const r = await reconcile(false)
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'kernel-api-nats-seed')).toMatchObject({ ok: false })
    expect(r.checks.find((c) => c.name === 'kernel-api-nats-seed')!.detail).toContain('platform database is unreachable')
    expect(existsSync(seed('kernel-api'))).toBe(false)
    expect(existsSync(seed('calendar'))).toBe(true)
  })

  it('a registry set with a module the customer has no seed for is created by the same ensure (the declared set is the truth)', async () => {
    registry = ['calendar', 'content']
    const r = await reconcile(false)
    expect(r.ok).toBe(true)
    expect(existsSync(seed('content'))).toBe(true)
    expect(existsSync(seed('kernel-api'))).toBe(true)
  })

  it('a suspended customer: the registry set is not restored (suspension evicts modules), only the kernel-api seed is ensured', async () => {
    await ensureTenantAccount({ tenant: TENANT.slug, modules: [] }, { secretsDir, accountsDir, broker }) // suspend: modules evicted
    expect(existsSync(seed('calendar'))).toBe(false)
    const r = await reconcile(false, { ...TENANT, status: 'suspended' })
    expect(r.checks.find((c) => c.name === 'kernel-api-nats-seed')).toMatchObject({ ok: true })
    expect(existsSync(seed('kernel-api'))).toBe(true)
    expect(existsSync(seed('calendar'))).toBe(false)
    expect(registryRead).not.toHaveBeenCalled()
  })

  it('a customer that is neither active nor suspended (provisioning, deleting) has no such check: create makes the seed, delete removes the account', async () => {
    for (const status of ['provisioning', 'deleting', 'deleted']) {
      const r = await reconcileKernelApiSeed(GREEN, { ...TENANT, status }, nats(), false)
      expect(r).toBe(GREEN)
    }
    expect(existsSync(seed('kernel-api'))).toBe(false)
  })
})
