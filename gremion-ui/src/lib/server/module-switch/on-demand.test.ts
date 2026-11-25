// @vitest-environment node
//
// on-demand.test.ts - the reconciler pass a REQUEST asks for (the module settings page, while a request is pending).
//
// It is the timer's work, so it meets the timer's guards: the worker gate and the per-(worker, tenant) single-flight,
// under the SAME worker label (a different label would be a different key, and the two could overlap). The seam
// itself (worker-fleet runTenantTickNow) is pinned in worker-fleet.test.ts; here the wiring is pinned, and, with the
// real seam, that a gated colour and a tick in flight both leave the reconciler untouched.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runPass: vi.fn(),
  gateOff: vi.fn(),
}))

vi.mock('./reconciler', () => ({ MODULE_SWITCH_INTERVAL_MS: 10_000, runModuleSwitchPass: h.runPass }))
vi.mock('$lib/server/tenant/worker-gate', () => ({ isWorkerGateOff: h.gateOff }))
// The registry and the readiness map are the fleet's own business; the on-demand seam touches neither.
vi.mock('$lib/server/tenant/registry', () => ({ listActiveTenants: vi.fn(), resolveTenantBySlug: vi.fn() }))

const { runModuleSwitchPassNow } = await import('./on-demand')
const { MODULE_SWITCH_WORKER } = await import('./worker-id')
const { forEachActiveTenant, _resetWorkerFleetForTests } = await import('$lib/server/tenant/worker-fleet')
const registry = await import('$lib/server/tenant/registry')
const { setTenantReadinessFromFleet, _resetReadinessForTests } = await import('$lib/server/tenant/readiness')

const TENANT = { id: 'tid-a', slug: 'rat-a' } as never

beforeEach(() => {
  vi.clearAllMocks()
  h.gateOff.mockResolvedValue(false)
  h.runPass.mockResolvedValue({ applied: 0, failed: 0, adopted: 0 })
  _resetWorkerFleetForTests()
  _resetReadinessForTests()
})

describe('runModuleSwitchPassNow', () => {
  it('runs the pass for the request tenant when nothing stops it', async () => {
    const out = await runModuleSwitchPassNow(TENANT)
    expect(h.runPass).toHaveBeenCalledTimes(1)
    expect(h.runPass).toHaveBeenCalledWith(TENANT)
    expect(out).toEqual({ ran: true, value: { applied: 0, failed: 0, adopted: 0 } })
  })

  it('a colour whose worker gate says off does not run the pass (it would write config.modules, run the replay hooks and the migrations)', async () => {
    h.gateOff.mockResolvedValue(true)
    const out = await runModuleSwitchPassNow(TENANT)
    expect(h.runPass).not.toHaveBeenCalled()
    expect(out).toEqual({ ran: false, reason: 'gate-off' })
  })

  it('does not overlap the timer tick of the same tenant (the key is the one register.server.ts ticks under)', async () => {
    setTenantReadinessFromFleet(new Map([['tid-a', { ok: true }]]))
    vi.mocked(registry.listActiveTenants).mockResolvedValue([{ id: 'tid-a', slug: 'rat-a', status: 'active' }] as never)
    vi.mocked(registry.resolveTenantBySlug).mockResolvedValue(TENANT)
    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })
    let entered!: () => void
    const inside = new Promise<void>((r) => {
      entered = r
    })
    h.runPass.mockImplementationOnce(async () => {
      entered()
      await hold
      return { applied: 0, failed: 0, adopted: 0 }
    })
    const tick = forEachActiveTenant(MODULE_SWITCH_WORKER, (ctx) => h.runPass(ctx))
    await inside
    const out = await runModuleSwitchPassNow(TENANT)
    expect(out).toEqual({ ran: false, reason: 'in-flight' })
    expect(h.runPass).toHaveBeenCalledTimes(1)
    release()
    await tick
  })
})

// Nothing may call the pass from a request without the seam above: the next caller that does is named here.
describe('who calls runModuleSwitchPass', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SRC = join(HERE, '..', '..', '..')

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|svelte)$/.test(name) && !/\.test\./.test(name)) out.push(p)
    }
    return out
  }

  it('only the reconciler itself, the timer (through forEachActiveTenant) and the guarded on-demand seam', () => {
    const allowed = new Set(['lib/server/module-switch/reconciler.ts', 'lib/server/module-switch/register.server.ts', 'lib/server/module-switch/on-demand.ts'])
    const offenders = walk(SRC)
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .filter((f) => !allowed.has(f))
      .filter((f) => {
        const text = readFileSync(join(SRC, f), 'utf8')
        // a call, or an import of the name (a mention in a comment is not a caller)
        return /\brunModuleSwitchPass\s*\(/.test(text) || /import\s*(?:type\s*)?\{[^}]*\brunModuleSwitchPass\b[^}]*\}/.test(text)
      })
    expect(offenders).toEqual([])
  })
})
