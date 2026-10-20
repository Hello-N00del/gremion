// The CLI surface without a database or broker: usage, flag strictness, the subject-map file.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { loadSubjects, main, parseFlags, UsageError, type CliDeps } from '../src/cli.ts'

// Scratch under the package (git-ignored .scratch/), never the system temp directory.
const dir = path.join(import.meta.dirname, '../.scratch', `cli-${process.pid}`)
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const deps = (): CliDeps & { out: ReturnType<typeof vi.fn>; openDb: ReturnType<typeof vi.fn>; openNats: ReturnType<typeof vi.fn>; streamPublisher: ReturnType<typeof vi.fn> } =>
  ({ out: vi.fn(), openDb: vi.fn(), openNats: vi.fn(), streamPublisher: vi.fn() }) as never

describe('parseFlags', () => {
  test('--key value pairs', () => {
    expect(parseFlags(['--ctx', 'idt', '--tenant', 't'], ['ctx', 'tenant'])).toEqual({ ctx: 'idt', tenant: 't' })
  })
  test.each([
    [['--ctx']],
    [['--ctx', '--tenant', 't']],
    [['--ctx', 'a', '--ctx', 'b']],
    [['--nope', 'x']],
    [['stray']],
  ])('refuses %j', (args) => {
    expect(() => parseFlags(args, ['ctx', 'tenant'])).toThrow(UsageError)
  })
})

describe('loadSubjects', () => {
  test('substitutes {tenant}', () => {
    const f = path.join(dir, 's.json')
    writeFileSync(f, JSON.stringify({ 'de.gremion.idt.orgunit.created.v1': 'gremion.{tenant}.org-unit.created' }))
    expect(loadSubjects(f, 'acme')).toEqual({ 'de.gremion.idt.orgunit.created.v1': 'gremion.acme.org-unit.created' })
  })
  test('a non-string value is refused', () => {
    const f = path.join(dir, 'bad.json')
    writeFileSync(f, JSON.stringify({ x: 3 }))
    expect(() => loadSubjects(f, 'acme')).toThrow(UsageError)
  })
})

describe('main', () => {
  test('no command and an unknown command print the usage and return 2, touching nothing', async () => {
    const d = deps()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main([], d)).toBe(2)
    expect(await main(['bogus'], d)).toBe(2)
    expect(err.mock.calls.join('\n')).toContain('usage: events outbox-replay')
    expect(d.openDb).not.toHaveBeenCalled()
    expect(d.openNats).not.toHaveBeenCalled()
    err.mockRestore()
  })

  test.each([
    [['outbox-replay', '--ctx', 'idt']],
    [['outbox-requeue', '--ctx', 'idt', '--customer', 'c']],
    [['outbox-requeue', '--ctx', 'idt', '--tenant', 't', '--event-id', 'e']],
    [['dlq-replay', '--tenant', 't', '--seq', 'x']],
    [['dlq-list']],
    [['metrics']],
  ])('%j is a usage error (2), before any connection', async (argv) => {
    const d = deps()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main(argv, d)).toBe(2)
    expect(d.openDb).not.toHaveBeenCalled()
    expect(d.openNats).not.toHaveBeenCalled()
    err.mockRestore()
  })

  test('dlq-replay reads as the admin and republishes as the target stream publisher (the admin may not publish stream subjects)', async () => {
    const d = deps()
    const entry = {
      seq: 7,
      subject: 'gremion.t1.dlq.finance.c',
      header: { get: (k: string) => ({ 'Gremion-Dlq-Orig-Subject': 'gremion.t1.org-unit.created', 'Gremion-Dlq-Stream': 'ORGUNIT', 'Gremion-Event-Id': 'e1' })[k] ?? '', keys: () => ['Gremion-Dlq-Orig-Subject', 'Gremion-Dlq-Stream', 'Gremion-Event-Id'] },
      data: new Uint8Array(),
      time: new Date(),
    }
    const published: string[] = []
    const closed: string[] = []
    d.streamPublisher.mockImplementation((s: string) => (s === 'ORGUNIT' ? 'kernel' : undefined))
    d.openNats.mockImplementation(async (_t: string, identity: string) => ({
      js: { publish: async () => (published.push(identity), { stream: 'ORGUNIT', seq: 1, duplicate: false }) },
      jsm: { streams: { getMessage: async () => entry, deleteMessage: async () => true } },
      close: async () => void closed.push(identity),
    }))
    expect(await main(['dlq-replay', '--tenant', 't1', '--seq', '7'], d)).toBe(0)
    expect(d.openNats.mock.calls.map((c) => c[1])).toEqual(['admin', 'kernel'])
    expect(published).toEqual(['kernel'])
    expect(closed.sort()).toEqual(['admin', 'kernel'])
  })

  test('metrics prints OpenMetrics text from the service database', async () => {
    const d = deps()
    const sql = { begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: async (q: string) => (q.includes('set_config') ? [{ c: 'x' }] : [{ o: '1', d: '0', s: '2' }]) }) }
    d.openDb.mockResolvedValue({ sql, close: async () => {} })
    expect(await main(['metrics', '--ctx', 'fin', '--customer', 't', '--consumer', 'finance'], d)).toBe(0)
    const text = d.out.mock.calls.map((c) => c[0]).join('')
    expect(text).toContain('gremion_outbox_dead_lettered{ctx="fin"} 1')
    expect(text).toContain('gremion_inbox_stalled{ctx="fin",consumer="finance"} 2')
    expect(d.openDb).toHaveBeenCalledWith('t', 'fin')
  })

  describe('outbox-replay refuses a --customer whose database belongs to another tenant', () => {
    const file = () => {
      const f = path.join(dir, 'replay-subjects.json')
      writeFileSync(f, JSON.stringify({ 'de.gremion.idt.orgunit.created.v1': 'gremion.{tenant}.org-unit.created' }))
      return f
    }
    const bound = (token: string) => ({ unsafe: async () => [{ tenant_token: token }], begin: async () => { throw new Error('must not replay') } })
    const argv = () => ['outbox-replay', '--ctx', 'idt', '--customer', 'c1', '--tenant', 'acme', '--subjects', file()]

    test('a mismatch is a usage error (2) naming both tenants, before NATS is opened and the database closed', async () => {
      const d = deps()
      const closed = vi.fn()
      d.openDb.mockResolvedValue({ sql: bound('other'), close: async () => void closed() })
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await main(argv(), d)).toBe(2)
      const msg = err.mock.calls.join(' ')
      expect(msg).toContain('other')
      expect(msg).toContain('acme')
      expect(d.openNats).not.toHaveBeenCalled()
      expect(closed).toHaveBeenCalledTimes(1)
      err.mockRestore()
    })

    test('a match proceeds to NATS', async () => {
      const d = deps()
      d.openDb.mockResolvedValue({ sql: bound('acme'), close: async () => {} })
      d.openNats.mockRejectedValue(new Error('reached nats'))
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(main(argv(), d)).rejects.toThrow(/reached nats/)
      expect(d.openNats).toHaveBeenCalledTimes(1)
      err.mockRestore()
    })
  })
})
