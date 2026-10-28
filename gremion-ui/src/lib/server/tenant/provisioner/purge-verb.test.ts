// TRD-144/145: the tenant-create `purge-run` verb. The engine (runPurge) is
// proven on a real Postgres in packages/tenant-store; this is the verb's contract:
// one JSON line on STDOUT, the exit code, and that it refuses stray arguments.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PURGE_USAGE, PURGE_VERBS, purgeVerb, type PurgeVerbContext } from '../../../../../scripts/tenant-provision-purge'

afterEach(() => {
  process.exitCode = 0
  vi.restoreAllMocks()
})

const result = (status: 'succeeded' | 'failed' | 'skipped') => ({
  status,
  categories: { 'RC-K1-PLUMB/event_consumption': 3 },
  errors: status === 'failed' ? [{ tenant: 'ab', rule: 'RC-K1-PLUMB/event_consumption', message: 'boom' }] : [],
  skipped: [],
  tenantsScanned: 2,
  jobRunId: '0198a1b2-0000-7000-8000-000000000001',
  startedAt: new Date('2026-10-27T02:30:00Z'),
  finishedAt: new Date('2026-10-27T02:30:02Z'),
})

function ctx(over: Partial<PurgeVerbContext> = {}, args: string[] = []): PurgeVerbContext & { ended: string[] } {
  const ended: string[] = []
  return {
    args,
    openPlatform: () => ({ end: async () => void ended.push('platform') }) as never,
    openKernelServer: () => ({ admin: {}, open: () => ({}), close: async () => void ended.push('kernel') }) as never,
    run: vi.fn(async () => result('succeeded')) as never,
    usage: (m) => new Error(m),
    log: vi.fn(),
    ended,
    ...over,
  }
}

describe('purge-run verb', () => {
  it('is the one verb of the file and is in the usage text', () => {
    expect([...PURGE_VERBS]).toEqual(['purge-run'])
    expect(PURGE_USAGE).toContain('purge-run')
  })

  it('prints exactly one JSON line with the counts, exits 0 on succeeded, and closes both connections', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const c = ctx()
    await purgeVerb('purge-run', c)
    expect(out).toHaveBeenCalledTimes(1)
    const line = String(out.mock.calls[0]![0])
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toMatchObject({ verb: 'purge-run', status: 'succeeded', categories: { 'RC-K1-PLUMB/event_consumption': 3 }, errors: 0 })
    expect(process.exitCode ?? 0).toBe(0)
    expect(c.ended.sort()).toEqual(['kernel', 'platform'])
  })

  it('exits 1 when the run failed (the timer unit then fails and the operator sees it)', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await purgeVerb('purge-run', ctx({ run: vi.fn(async () => result('failed')) as never }))
    expect(process.exitCode).toBe(1)
  })

  it('a skipped run (another one holds the lock) is not a failure', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await purgeVerb('purge-run', ctx({ run: vi.fn(async () => result('skipped')) as never }))
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('refuses a stray argument and runs nothing', async () => {
    const run = vi.fn()
    await expect(purgeVerb('purge-run', ctx({ run: run as never }, ['--all']))).rejects.toThrow(/purge-run takes no argument/)
    expect(run).not.toHaveBeenCalled()
  })

  it('closes both connections when the run throws', async () => {
    const c = ctx({ run: vi.fn(async () => Promise.reject(new Error('no purge_run definition'))) as never })
    await expect(purgeVerb('purge-run', c)).rejects.toThrow(/purge_run/)
    expect(c.ended.sort()).toEqual(['kernel', 'platform'])
  })
})
