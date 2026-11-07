// register.server.test.ts - the governance module's org-unit RELAY boot hook.
//
// The relay is env-gated on NATS_URL (read through platformEnv, never the process
// env directly). Unset -> the worker is reported OFF and nothing connects. Set ->
// the hook hands a supervised worker named 'org-unit-relay' to superviseWorker,
// whose start() connects to the ORGUNIT stream, ensures it, and starts the drain
// cadence. A failed ensureStream closes the broker so retries do not stack
// connections.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAMS } from '@gremion/ports/broker'

const h = vi.hoisted(() => ({
  hooks: [] as Array<() => unknown>,
  natsUrl: undefined as string | undefined,
  superviseWorker: vi.fn(),
  markWorkerOff: vi.fn(),
  forEachActiveTenant: vi.fn(),
  connect: vi.fn(),
  runPass: vi.fn(),
  drain: vi.fn(),
  kcClient: { tag: 'kc-for-current-tenant' },
}))

vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerServerInitHook: vi.fn((fn: () => unknown) => {
    h.hooks.push(fn)
  }),
}))
vi.mock('$lib/server/env/platform-env', () => ({ platformEnv: vi.fn(() => h.natsUrl) }))
vi.mock('$lib/server/events/consumer-state', () => ({
  superviseWorker: h.superviseWorker,
  markWorkerOff: h.markWorkerOff,
}))
vi.mock('$lib/server/tenant/worker-fleet', () => ({ forEachActiveTenant: h.forEachActiveTenant }))
vi.mock('@gremion/ports/nats', () => ({ NatsBroker: { connect: h.connect } }))
vi.mock('./org-unit-event-relay', () => ({ runOrgUnitRelayPass: h.runPass }))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClientForCurrentTenant: () => h.kcClient }))
vi.mock('./vorstand-backfill', () => ({ drainRoleBackfill: h.drain, ROLE_BACKFILL_INTERVAL_MS: 60_000 }))

const { ORG_UNIT_RELAY_WORKER, VORSTAND_BACKFILL_WORKER } = await import('./register.server')

/** Run the registered org-unit relay boot hook (the first of two hooks) once. */
async function runHook(): Promise<void> {
  expect(h.hooks).toHaveLength(2)
  await h.hooks[0]!()
}

beforeEach(() => {
  h.natsUrl = undefined
  h.superviseWorker.mockReset()
  h.markWorkerOff.mockReset()
  h.forEachActiveTenant.mockReset()
  h.connect.mockReset()
  h.runPass.mockReset()
  h.drain.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('org-unit relay boot hook', () => {
  it('reports the worker OFF and starts nothing when NATS_URL is unset', async () => {
    await runHook()
    expect(h.markWorkerOff).toHaveBeenCalledWith('org-unit-relay', 'NATS_URL not set')
    expect(h.superviseWorker).not.toHaveBeenCalled()
    expect(h.connect).not.toHaveBeenCalled()
  })

  it('hands a worker named org-unit-relay to superviseWorker when NATS_URL is set', async () => {
    h.natsUrl = 'nats://nats.example.org:4222'
    await runHook()
    expect(ORG_UNIT_RELAY_WORKER).toBe('org-unit-relay')
    expect(h.markWorkerOff).not.toHaveBeenCalled()
    expect(h.superviseWorker).toHaveBeenCalledTimes(1)
    expect(h.superviseWorker.mock.calls[0]![0]).toMatchObject({ name: 'org-unit-relay' })
    // The hook only registers the supervised worker; nothing connects until start().
    expect(h.connect).not.toHaveBeenCalled()
  })

  it('start() connects to the ORGUNIT stream, ensures it and drains every active tenant on the cadence', async () => {
    vi.useFakeTimers()
    h.natsUrl = 'nats://nats.example.org:4222'
    const broker = { ensureStream: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
    h.connect.mockResolvedValue(broker)
    await runHook()
    const { start } = h.superviseWorker.mock.calls[0]![0] as { start: () => Promise<void> }

    await start()

    expect(h.connect).toHaveBeenCalledWith('nats://nats.example.org:4222', STREAMS.ORGUNIT.name)
    expect(broker.ensureStream).toHaveBeenCalledWith(STREAMS.ORGUNIT.name, STREAMS.ORGUNIT.subjects)
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(1)
    expect(h.forEachActiveTenant.mock.calls[0]![0]).toBe('org-unit-relay')
    expect(broker.close).not.toHaveBeenCalled()
  })

  it('the per-tenant callback drains the pool and id of the tenant it is given, through the connected broker', async () => {
    vi.useFakeTimers()
    h.natsUrl = 'nats://nats.example.org:4222'
    const broker = { ensureStream: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
    h.connect.mockResolvedValue(broker)
    h.runPass.mockResolvedValue({ ok: 0, failed: 0 })
    await runHook()
    const { start } = h.superviseWorker.mock.calls[0]![0] as { start: () => Promise<void> }
    await start()
    await vi.advanceTimersByTimeAsync(5_000)

    const perTenant = h.forEachActiveTenant.mock.calls[0]![1] as (ctx: { id: string; db: unknown }) => unknown
    const db = { tag: 'tenant-a-pool' }
    await perTenant({ id: 'tenant-a', db })

    expect(h.runPass).toHaveBeenCalledTimes(1)
    expect(h.runPass).toHaveBeenCalledWith(db, 'tenant-a', broker)
  })

  it('start() closes the broker and rethrows when ensureStream fails, so retries do not stack connections', async () => {
    vi.useFakeTimers()
    h.natsUrl = 'nats://nats.example.org:4222'
    const boom = new Error('refusing to repoint stream ORGUNIT')
    const broker = { ensureStream: vi.fn().mockRejectedValue(boom), close: vi.fn().mockResolvedValue(undefined) }
    h.connect.mockResolvedValue(broker)
    await runHook()
    const { start } = h.superviseWorker.mock.calls[0]![0] as { start: () => Promise<void> }

    await expect(start()).rejects.toBe(boom)

    expect(broker.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
  })
})

describe('vorstand role backfill boot hook', () => {
  it('drains every active tenant every 60 s through the worker fleet, with the pool and Keycloak client of the tenant it is given', async () => {
    vi.useFakeTimers()
    h.drain.mockResolvedValue({ applied: 0, failed: 0, gone: 0 })
    expect(h.hooks).toHaveLength(2)
    await h.hooks[1]!()

    expect(VORSTAND_BACKFILL_WORKER).toBe('vorstand-backfill')
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.forEachActiveTenant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(1)
    expect(h.forEachActiveTenant.mock.calls[0]![0]).toBe('vorstand-backfill')

    const perTenant = h.forEachActiveTenant.mock.calls[0]![1] as (ctx: { id: string; db: unknown }) => unknown
    const db = { tag: 'tenant-a-pool' }
    await perTenant({ id: 'tenant-a', db })
    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.drain).toHaveBeenCalledWith(db, h.kcClient, console)
  })

  it('does not depend on NATS_URL (the queue is tenant-local)', async () => {
    vi.useFakeTimers()
    h.natsUrl = undefined
    await h.hooks[1]!()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.forEachActiveTenant).toHaveBeenCalledTimes(1)
    expect(h.markWorkerOff).not.toHaveBeenCalled()
  })
})
