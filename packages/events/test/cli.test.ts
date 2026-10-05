// The CLI surface without a database or broker: usage, flag strictness, the subject-map file.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { loadSubjects, main, parseFlags, UsageError, type CliDeps } from '../src/cli.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'events-cli-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const deps = (): CliDeps & { out: ReturnType<typeof vi.fn>; openDb: ReturnType<typeof vi.fn>; openNats: ReturnType<typeof vi.fn> } =>
  ({ out: vi.fn(), openDb: vi.fn(), openNats: vi.fn() }) as never

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
    [['outbox-requeue', '--ctx', 'idt', '--tenant', 't']],
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

  test('metrics prints OpenMetrics text from the service database', async () => {
    const d = deps()
    const sql = { begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: async (q: string) => (q.includes('set_config') ? [{ c: 'x' }] : [{ o: '1', d: '0', s: '2' }]) }) }
    d.openDb.mockResolvedValue({ sql, close: async () => {} })
    expect(await main(['metrics', '--ctx', 'fin', '--tenant', 't', '--consumer', 'finance'], d)).toBe(0)
    const text = d.out.mock.calls.map((c) => c[0]).join('')
    expect(text).toContain('gremion_outbox_dead_lettered{ctx="fin"} 1')
    expect(text).toContain('gremion_inbox_stalled{ctx="fin",consumer="finance"} 2')
    expect(d.openDb).toHaveBeenCalledWith('t', 'fin')
  })
})
