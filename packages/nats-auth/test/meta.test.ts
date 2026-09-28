// Meta: every refusal case in the live suite runs a positive control first.
// A refusal proved without one would pass against a broker that refuses
// EVERYTHING (or a connection that is simply dead).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const LIVE = readFileSync(path.resolve(import.meta.dirname, 'live/nats-auth.live.test.ts'), 'utf8')

/** [title, body] of every `test('...', ...)` in a source text. */
export function testBlocks(src: string): [string, string][] {
  const out: [string, string][] = []
  const re = /^\s*test\((['"`])(.+?)\1/gm
  const starts = [...src.matchAll(re)].map((m) => ({ i: m.index!, title: m[2]! }))
  // template-built titles: test(`SYS ... ${label}...`
  starts.forEach((s, k) => out.push([s.title, src.slice(s.i, starts[k + 1]?.i ?? src.length)]))
  return out
}

export function controlViolations(src: string): string[] {
  const out: string[] = []
  const blocks = testBlocks(src).filter(([t]) => /Violation/.test(t))
  if (blocks.length === 0) out.push('no refusal case found -- the meta-test would pass vacuously')
  for (const [title, body] of blocks) {
    const refusals = (body.match(/\brefused\(/g) ?? []).length
    const controls = (body.match(/^\s*control: (?:async|infoControl\()/gm) ?? []).length
    const connects = (body.match(/\bconnectRefused\(/g) ?? []).length
    if (refusals + connects === 0) out.push(`${title}: asserts no refusal through refused()/connectRefused()`)
    if (refusals !== controls) out.push(`${title}: ${refusals} refused() call(s) but ${controls} positive control(s)`)
    if (connects > 0 && !/await as\(|await sub\.ready|\.toContain\('PONG'\)/.test(body)) {
      out.push(`${title}: connectRefused() without a positive control (an admitted connection first)`)
    }
  }
  return out
}

describe('positive controls (meta)', () => {
  test('every refusal case in the live suite has a positive control', () => {
    expect(controlViolations(LIVE)).toEqual([])
    expect(testBlocks(LIVE).filter(([t]) => /Violation/.test(t)).length).toBeGreaterThanOrEqual(14)
  })
  test('break: a refusal whose control was removed fails', () => {
    const broken = LIVE.replace(/control: async \(\) => c\.nc\.subscribe\('_INBOX_publishing_ta\.control'\),\n/, '')
    expect(broken).not.toBe(LIVE)
    expect(controlViolations(broken).join('\n')).toMatch(/positive control/)
  })
  test('break: a connect refusal without an admitted connection first fails', () => {
    const broken = LIVE.replace("const control = await as(A, 'kernel') // a known key IS admitted\n    expect(control.nc.isClosed()).toBe(false)\n", '')
    expect(broken).not.toBe(LIVE)
    expect(controlViolations(broken).join('\n')).toMatch(/A1 no credentials.*without a positive control/)
  })
})
