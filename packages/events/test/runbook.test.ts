// The runbook is the spec: its fenced commands are parsed (host form) and checked against the CLI's
// own flag table, so a doc that drifts from the CLI (or a CLI that drifts from the doc) is RED.
// The live half runs each command against the scratch stack (test/live/deadletter.live.test.ts).
import { describe, expect, test } from 'vitest'
import { COMMANDS, parseCommand, type Verb } from '../src/cli.ts'
import { extractCommands, fill, RUNBOOK } from './runbook-lib.ts'
import { readFileSync } from 'node:fs'

const VALUES = {
  slug: 'acme',
  n: '7',
  ctx: 'idt',
  customer: '019f2f0a-0000-7000-8000-0000000000aa',
  service: 'kernel-api',
  'event-id': '019f2f0a-0000-7000-8000-000000000001',
  modules: 'finance',
  identity: 'kernel',
  'subjects-file': 'subjects.json',
}

describe('docs/runbooks/dead-letter.md', () => {
  const cmds = extractCommands()
  const events = cmds.filter((c) => c.tool === 'events')

  test('holds the replay, requeue and rebuild steps as fenced host-form commands', () => {
    const verbs = events.map((c) => c.args[0])
    expect(verbs).toEqual(expect.arrayContaining(['dlq-list', 'dlq-replay', 'outbox-requeue', 'outbox-replay']))
    const ensures = cmds.filter((c) => c.tool === 'nats-auth')
    expect(ensures).toHaveLength(1)
    expect(ensures[0]!.args.slice(0, 1)).toEqual(['ensure'])
    // `ensure` comes BEFORE the replay (streams are recreated first), and it never says --suspend.
    const order = cmds.map((c) => `${c.tool}:${c.args[0]}`)
    expect(order.indexOf('nats-auth:ensure')).toBeLessThan(order.indexOf('events:outbox-replay'))
    expect(ensures[0]!.args).toContain('--modules')
    expect(ensures[0]!.args).not.toContain('--suspend')
  })

  test.each(events.map((c) => [c.args[0]!, c] as const))('the documented `events %s` command is accepted by the CLI flag table', (_verb, c) => {
    const argv = fill(c.args, VALUES)
    expect(() => parseCommand(argv)).not.toThrow()
  })

  test('a flag the CLI does not know is a usage error (the guard that makes doc drift RED)', () => {
    const c = events.find((e) => e.args[0] === 'dlq-replay')!
    expect(() => parseCommand([...fill(c.args, VALUES), '--bogus', 'x'])).toThrow(/unknown or misplaced/)
    expect(() => parseCommand(['dlq-replay', '--tenant', 'acme'])).toThrow(/--seq is required/)
  })

  test('every CLI verb a human runs is documented (metrics is the host collector\'s)', () => {
    const documented = new Set(events.map((c) => c.args[0] as Verb))
    for (const verb of Object.keys(COMMANDS) as Verb[]) {
      if (verb === 'metrics') continue
      expect(documented.has(verb), `${verb} is not in dead-letter.md`).toBe(true)
    }
  })

  test('an unknown placeholder or a non-host-form command is reported by name', () => {
    expect(() => fill(['--tenant', '<tenant-slug>'], VALUES)).toThrow(/placeholder <tenant-slug> has no value/)
    expect(() => extractCommands('```bash\ndocker compose ps\n```\n')).toThrow(/neither host form A nor B/)
  })

  test('states the 7-day DLQ retention and the fallback to the outbox replay', () => {
    const text = readFileSync(RUNBOOK, 'utf8')
    expect(text).toMatch(/keeps an entry for 7 days/)
    expect(text).toMatch(/past 7 days the recovery is the outbox replay/)
  })
})
