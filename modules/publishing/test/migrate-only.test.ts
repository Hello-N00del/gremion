/**
 * `node dist/index.js --migrate-only` - the CD leaf step - PG-free unit tests.
 *
 * Pins: the error classes behind the exit codes (3 retry later vs 1 defect of the commit), the usage
 * exits (2), and that the entry STARTS NOTHING: no HTTP server, no scheduler, no NATS client, no outbox
 * relay, and the process ends with the entry's own exit code. The database behaviour (catalogue read
 * without creating anything, skipped customers, advisory lock, retries, idempotence, the overlap with
 * the old runner) is in migrate-only.integration.test.ts against a throwaway Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({
  createServer: vi.fn(() => ({ listen: vi.fn(), close: vi.fn() })),
  startScheduler: vi.fn(() => ({ stop: vi.fn() })),
  natsConnect: vi.fn(),
  createRelaySupervisor: vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn() })),
  runMigrateOnlyCli: vi.fn(async (): Promise<number> => 0),
}))

vi.mock('../src/http/server.js', () => ({ createServer: spies.createServer }))
vi.mock('../src/scheduler.js', () => ({ startScheduler: spies.startScheduler }))
vi.mock('../src/nats-broker.js', () => ({ NatsBroker: { connect: spies.natsConnect } }))
vi.mock('../src/relay-supervisor.js', () => ({ createRelaySupervisor: spies.createRelaySupervisor }))
vi.mock('../src/migrate-only.js', () => ({ runMigrateOnlyCli: spies.runMigrateOnlyCli }))

// A store opener that must never be reached by these PG-free tests.
const deps = { openStore: async (): Promise<never> => { throw new Error('openStore is not reachable here') } }

class ExitSignal extends Error {
  constructor(readonly exitCode: number | undefined) {
    super('process.exit')
  }
}

const savedArgv = process.argv
const savedEnv = { ...process.env }
let sigtermBefore: unknown[] = []
let sigintBefore: unknown[] = []

beforeEach(() => {
  vi.resetModules()
  for (const spy of Object.values(spies)) spy.mockClear()
  spies.runMigrateOnlyCli.mockResolvedValue(0)
  delete process.env.NATS_URL
  sigtermBefore = process.listeners('SIGTERM')
  sigintBefore = process.listeners('SIGINT')
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    // A mocked exit that returned would let the rest of the module run, which is exactly what the
    // real exit prevents: stop the evaluation the way the real one does.
    throw new ExitSignal(code)
  }) as never)
})

afterEach(() => {
  process.argv = savedArgv
  process.env = { ...savedEnv }
  for (const l of process.listeners('SIGTERM')) if (!sigtermBefore.includes(l)) process.removeListener('SIGTERM', l)
  for (const l of process.listeners('SIGINT')) if (!sigintBefore.includes(l)) process.removeListener('SIGINT', l)
  vi.restoreAllMocks()
})

describe('index.ts --migrate-only starts nothing', () => {
  it('runs the entry, exits with its code, and builds no server, scheduler, NATS client or relay', async () => {
    process.argv = [process.argv[0]!, 'dist/index.js', '--migrate-only']
    process.env.NATS_URL = 'nats://127.0.0.1:1' // were the relay started, it would try this
    spies.runMigrateOnlyCli.mockResolvedValue(0)

    const err = await import('../src/index.ts').then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ExitSignal)
    expect((err as ExitSignal).exitCode).toBe(0)
    expect(spies.runMigrateOnlyCli).toHaveBeenCalledTimes(1)
    // The process wiring hands over the leaf's own store opener (the only storeFor call site).
    expect(spies.runMigrateOnlyCli).toHaveBeenCalledWith({ openStore: expect.any(Function) })
    expect(spies.createServer).not.toHaveBeenCalled()
    expect(spies.startScheduler).not.toHaveBeenCalled()
    expect(spies.natsConnect).not.toHaveBeenCalled()
    expect(spies.createRelaySupervisor).not.toHaveBeenCalled()
    // And no signal handler of the service was installed either.
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore)
  })

  it.each([1, 2, 3])('exits with the entry code %i', async (code) => {
    process.argv = [process.argv[0]!, 'dist/index.js', '--migrate-only']
    spies.runMigrateOnlyCli.mockResolvedValue(code)
    const err = await import('../src/index.ts').then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as ExitSignal).exitCode).toBe(code)
    expect(spies.createServer).not.toHaveBeenCalled()
  })

  it('the argument is absent: the service starts as before and the entry is not run (control for the spies above)', async () => {
    process.argv = [process.argv[0]!, 'dist/index.js']
    await import('../src/index.ts')
    await vi.waitFor(() => expect(spies.startScheduler).toHaveBeenCalledTimes(1))
    expect(spies.createServer).toHaveBeenCalledTimes(1)
    expect(spies.runMigrateOnlyCli).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
  })
})

describe('the entry itself (real module)', () => {
  it('takes no argument but its own flag: a slug argument is refused with exit 2 and nothing on stdout', async () => {
    const actual = await vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts')
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
    const code = await actual.runMigrateOnlyCli(deps, ['--migrate-only', 'some-customer'])
    expect(code).toBe(2)
    expect(out).not.toHaveBeenCalled()
    // The refusal text names no argument it was given.
    expect(errOut.mock.calls.map((c) => String(c[0])).join('')).not.toContain('some-customer')
  })

  it('a missing NEWSLETTER_PG_URL is exit 2, no localhost fallback, no counts line', async () => {
    const actual = await vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts')
    delete process.env.NEWSLETTER_PG_URL
    const result = await actual.runMigrateOnly(deps)
    expect(result.code).toBe(2)
    expect(result.counts).toEqual({ v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 })

    const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
    expect(await actual.runMigrateOnlyCli(deps, ['--migrate-only'])).toBe(2)
    expect(out).not.toHaveBeenCalled()
  })

  it('an unreachable server is exit 3 with a valid counts line (retry later, not a defect of the commit)', async () => {
    const actual = await vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts')
    const result = await actual.runMigrateOnly(deps, { pgUrl: 'postgres://postgres@127.0.0.1:1/postgres' })
    expect(result.code).toBe(3)
    expect(result.counts).toEqual({ v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 })
  })
})

describe('classifyFailure: the phase decides what a dropped connection is', () => {
  const lost = (code: string): Error => Object.assign(new Error('boom'), { code })
  it.each(['ECONNRESET', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', '57P01'])(
    '%s before any DDL is retry-later, inside a migration file it is a defect of the run',
    async (code) => {
      const m = await vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts')
      expect(m.classifyFailure(lost(code), 'before-ddl')).toBe('unreachable')
      expect(m.classifyFailure(lost(code), 'in-migration')).toBe('sql')
      expect(m.classifyFailure(lost(code))).toBe('sql')
    },
  )
})

describe('classifyFailure: which exit code an error earns', () => {
  const pgErr = (code: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error('boom'), { code, ...extra })

  it.each([
    ['23505 on a pg_ catalogue index', pgErr('23505', { constraint_name: 'pg_type_typname_nsp_index' }), 'race'],
    ['42710 duplicate_object', pgErr('42710'), 'race'],
    ['42P07 duplicate_table', pgErr('42P07'), 'race'],
    ['40P01 deadlock_detected', pgErr('40P01'), 'race'],
    ['40001 serialization_failure', pgErr('40001'), 'race'],
    ['a refused connection', pgErr('ECONNREFUSED'), 'unreachable'],
    ['a connect timeout', pgErr('CONNECT_TIMEOUT'), 'unreachable'],
    ['a database that is starting up', pgErr('57P03'), 'unreachable'],
    ['a refused connection reported as an AggregateError', Object.assign(new AggregateError([pgErr('ECONNREFUSED'), pgErr('ECONNREFUSED')]), {}), 'unreachable'],
    ['23505 on a user table index is a real defect', pgErr('23505', { constraint_name: 'events_pkey' }), 'sql'],
    ['42601 syntax error', pgErr('42601'), 'sql'],
    ['a connection LOST inside a file', pgErr('CONNECTION_CLOSED'), 'sql'],
    ['ECONNRESET inside a file', pgErr('ECONNRESET'), 'sql'],
    ['a hash mismatch (a plain Error)', new Error('manifest hash mismatch for 001_init.sql'), 'sql'],
    ['a thrown string', 'boom', 'sql'],
    ['XX000 tuple concurrently updated (two sessions replacing one function)', pgErr('XX000', { message: 'tuple concurrently updated' }), 'race'],
    ['XX000 with another message is a defect', pgErr('XX000', { message: 'something else' }), 'sql'],
    ['a refused login (28P01)', pgErr('28P01'), 'precondition'],
    ['a role that does not exist (28000)', pgErr('28000'), 'precondition'],
  ] as const)('%s', (_label, err, expected) => {
    // Imported for real: the module under mock above is only the index.ts view of it.
    return vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts').then((m) => {
      expect(m.classifyFailure(err)).toBe(expected)
    })
  })
})
