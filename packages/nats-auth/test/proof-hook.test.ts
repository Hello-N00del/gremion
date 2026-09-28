// proof.sh's own post-condition (NATS_AUTH_CHECK_LOG hook), driven with
// synthetic logs: it must pass only a complete green log, and fail -- never
// report OK -- on a failing, skipped, short, empty or missing log.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const PROOF = path.resolve(import.meta.dirname, '../scripts/proof.sh')
const D = path.resolve(import.meta.dirname, `../../../.scratch/t024/unit/hook-${process.pid}`)
mkdirSync(D, { recursive: true })
afterAll(() => rmSync(D, { recursive: true, force: true }))

const F = 'test/live/nats-auth.live.test.ts'
const line = (mark: string, name: string) => ` ${mark} ${F} > group > ${name} 12ms`
const A = Array.from({ length: 14 }, (_, i) => `A${1 + (i % 3)} case ${i}`)
const Fs = ['F1 x', 'F2 x', 'F3 x', 'F4 x']
const others = Array.from({ length: 7 }, (_, i) => `I or SYS case ${i}`)
const green = [...A, ...Fs, ...others].map((n) => line('✓', n)).join('\n') + '\n      Tests  25 passed (25)\n'

function hook(mode: 'auth' | 'open', content: string | null) {
  const log = path.join(D, `${mode}-${Math.random().toString(16).slice(2)}.log`)
  if (content !== null) writeFileSync(log, content)
  return spawnSync('bash', [PROOF, `--${mode}`], { env: { ...process.env, NATS_AUTH_CHECK_LOG: log } })
}
const out = (r: ReturnType<typeof hook>) => `${r.stdout}${r.stderr}`

// F cases are "... > F the current flows ... > F1 ..." in the real file; the
// open check matches "> F " -- build those lines accordingly.
const fLines = (mark: string) => Fs.map((n) => ` ${mark} ${F} > F the current flows > ${n} 9ms`)
const aLines = (mark: string) => A.map((n) => ` ${mark} ${F} > ${n.slice(0, 2)} group > ${n} 9ms`)

describe('proof.sh --auth post-condition', () => {
  test('a complete green log passes', () => {
    const r = hook('auth', green)
    expect(r.status, out(r)).toBe(0)
    expect(out(r)).toMatch(/25 passing \(minimum 25\)/)
  })
  test('a failed case fails', () => {
    const r = hook('auth', green.replace('✓', '×'))
    expect(r.status).toBe(1)
  })
  test('a skipped case fails', () => {
    const r = hook('auth', green.replace('✓', '↓'))
    expect(r.status).toBe(1)
  })
  test('too few passing cases fail', () => {
    const r = hook('auth', green.split('\n').slice(3).join('\n'))
    expect(r.status).toBe(1)
    expect(out(r)).toMatch(/only 22 passing/)
  })
  test('an empty log fails', () => {
    const r = hook('auth', '')
    expect(r.status).toBe(1)
    expect(out(r)).not.toMatch(/OK/)
  })
  test('a missing log fails', () => {
    const r = hook('auth', null)
    expect(r.status).toBe(1)
    expect(out(r)).toMatch(/no readable log/)
    expect(out(r)).not.toMatch(/OK/)
  })
})

describe('proof.sh --open record', () => {
  const record = [...aLines('×'), ...fLines('✓')].join('\n') + '\n'
  test('every A RED and every F GREEN: exit 1 (the record holds)', () => {
    const r = hook('open', record)
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toMatch(/A cases RED 14\/14, F cases GREEN 4\/4/)
  })
  test('an A case passing against the open broker: exit 2', () => {
    expect(hook('open', record.replace('×', '✓')).status).toBe(2)
  })
  test('an A case skipped: exit 2', () => {
    expect(hook('open', record.replace('×', '↓')).status).toBe(2)
  })
  test('an F case failing: exit 2', () => {
    expect(hook('open', record.replace(/✓/, '×')).status).toBe(2)
  })
  test('a missing log: exit 2, never "record holds"', () => {
    const r = hook('open', null)
    expect(r.status).toBe(2)
    expect(out(r)).not.toMatch(/record holds/)
  })
})
