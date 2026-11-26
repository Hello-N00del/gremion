/**
 * `node dist/index.js --migrate-only` - the CD leaf step - PG-free unit tests.
 *
 * The customer databases are the lifecycle's (t_<tenant>__calendar, migrated by the module step), so the
 * entry opens no database. Pins: it answers the host's counts contract (one JSON line of zero counts,
 * exit 0), refuses any argument (exit 2), imports no database driver and names no DDL, and that the
 * process STARTS NOTHING: no HTTP server, no scheduler, no NATS client, no outbox relay, and ends with
 * the entry's own exit code.
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
    // The entry takes nothing from the process wiring: no store opener, no url.
    expect(spies.runMigrateOnlyCli).toHaveBeenCalledWith()
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
    const code = await actual.runMigrateOnlyCli(['--migrate-only', 'some-customer'])
    expect(code).toBe(2)
    expect(out).not.toHaveBeenCalled()
    // The refusal text names no argument it was given.
    expect(errOut.mock.calls.map((c) => String(c[0])).join('')).not.toContain('some-customer')
  })

  it('answers the counts contract with exactly one JSON line of zero counts and exit 0, without any database url', async () => {
    const actual = await vi.importActual<typeof import('../src/migrate-only.ts')>('../src/migrate-only.ts')
    delete process.env.CALENDAR_PG_URL
    delete process.env.GREMION_CALENDAR_PG_URL
    const lines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, cb?: unknown) => {
      lines.push(String(chunk))
      if (typeof cb === 'function') (cb as () => void)()
      return true
    }) as never)
    const code = await actual.runMigrateOnlyCli(['--migrate-only'])
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    const counts = JSON.parse(lines[0]!) as Record<string, number>
    expect(counts).toEqual({ v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 })
    // the host reads exit 0 as ok only when failed = 0 and migrated + skipped + failed = total
    expect(counts.failed).toBe(0)
    expect(counts.migrated! + counts.skipped! + counts.failed!).toBe(counts.total)
  })

  it('the source opens no database: no driver import, no connection url, no DDL or migration call', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/migrate-only.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/from ['"]postgres['"]/)
    expect(src).not.toMatch(/CREATE\s+DATABASE|runMigrations|storeFor|_PG_URL/)
  })
})
