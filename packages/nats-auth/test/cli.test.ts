// The nats-auth bin, as `pnpm exec nats-auth` runs it: init is idempotent and
// needs no network; a bad command exits 2; ensure without NATS_URL fails loudly.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { NO_POSIX_MODES } from './portable.ts'

const BIN = path.resolve(import.meta.dirname, '../bin/nats-auth.mjs')
const D = path.resolve(import.meta.dirname, `../../../.scratch/t024/unit/cli-${process.pid}`)
const env = { ...process.env, NATS_SECRETS_DIR: `${D}/secrets`, NATS_ACCOUNTS_DIR: `${D}/accounts`, NATS_URL: '' }
afterAll(() => rmSync(D, { recursive: true, force: true }))

describe('nats-auth bin', () => {
  test('init twice: SYS-only accounts.conf, second run unchanged', () => {
    expect(execFileSync(process.execPath, [BIN, 'init'], { env }).toString()).toMatch(/seed created; .* written/)
    const bytes = readFileSync(`${D}/accounts/accounts.conf`, 'utf8')
    expect(bytes).not.toMatch(/T_/)
    expect(execFileSync(process.execPath, [BIN, 'init'], { env }).toString()).toMatch(/seed present; .* unchanged/)
    expect(readFileSync(`${D}/accounts/accounts.conf`, 'utf8')).toBe(bytes)
  })
  test.skipIf(NO_POSIX_MODES)('init leaves the reload seed 0600 (skipped on Windows: NO_POSIX_MODES)', () => {
    execFileSync(process.execPath, [BIN, 'init'], { env })
    expect(statSync(`${D}/secrets/_sys/reload.nk`).mode & 0o777).toBe(0o600)
  })
  test('render prints public keys only', () => {
    const out = execFileSync(process.execPath, [BIN, 'render'], { env }).toString()
    const seed = readFileSync(`${D}/secrets/_sys/reload.nk`, 'utf8').trim()
    expect(out).not.toContain(seed)
    expect(out).toMatch(/nkey: "U/)
  })
  test('an unknown command exits 2 with the usage', () => {
    const r = spawnSync(process.execPath, [BIN, 'bogus'], { env })
    expect(r.status).toBe(2)
    expect(r.stderr.toString()).toMatch(/usage: nats-auth/)
  })
  test('ensure without NATS_URL exits 1 naming it', () => {
    const r = spawnSync(process.execPath, [BIN, 'ensure', 'ta', '--modules', 'publishing'], { env })
    expect(r.status).toBe(1)
    expect(r.stderr.toString()).toMatch(/NATS_URL is unset/)
  })
  for (const args of [['ensure', 'ta'], ['ensure', 'ta', '--modules=publishing'], ['ensure', 'ta', '--module', 'x'], ['ensure', 'ta', '--modules'], ['ensure', 'ta', '--modules', 'a', '--suspend'], ['ensure', 'ta', '--modules', 'a', 'extra']]) {
    test(`ensure ${args.slice(1).join(' ')}: refused with the usage, exit 2`, () => {
      const r = spawnSync(process.execPath, [BIN, ...args], { env })
      expect(r.status, r.stderr.toString()).toBe(2)
      expect(r.stderr.toString()).toMatch(/usage: nats-auth/)
    })
  }
  test('ensure --suspend is the explicit empty set (reaches the NATS_URL check)', () => {
    const r = spawnSync(process.execPath, [BIN, 'ensure', 'ta', '--suspend'], { env })
    expect(r.status).toBe(1)
    expect(r.stderr.toString()).toMatch(/NATS_URL is unset/)
  })
})
