// `nats-auth ensure` as an operator types it (kernel issue #88 review note): ensure is declarative, so a hand-typed
// module set used to delete the kernel API's seed -- the reconcile verb keeps it (withPlatformIdentities), and the CLI
// path must too. Run against a fake broker and a real seed store in a scratch dir (main takes the EnsureOptions).
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { initAccounts, type BrokerOps, type EnsureOptions } from '../src/ensure.ts'

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch/t024/unit')
let root: string
let secretsDir: string
let accountsDir: string
let opts: EnsureOptions

class FakeBroker implements BrokerOps {
  async reload(): Promise<void> {}
  async ensureStreams(): Promise<void> {}
  async assertRevoked(): Promise<void> {}
}

let n = 0
beforeEach(async () => {
  root = path.join(SCRATCH, `cli-ensure-${process.pid}-${n++}`)
  rmSync(root, { recursive: true, force: true })
  secretsDir = path.join(root, 'secrets/nats')
  accountsDir = path.join(root, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
  opts = { secretsDir, accountsDir, broker: new FakeBroker() }
  await initAccounts({ secretsDir, accountsDir })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const seed = (module: string, tenant = 'ta') => path.join(secretsDir, module, `tenant_${tenant}.nk`)

/** main() with stdout captured: the exit code and the printed result. */
async function run(argv: string[]) {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const code = await main(argv, opts)
  return { code, result: lines.length ? (JSON.parse(lines[lines.length - 1]!) as { createdUsers: string[]; removedUsers: string[] }) : undefined }
}

describe('nats-auth ensure keeps the platform identities (kernel-api)', () => {
  test('--modules without kernel-api creates the seed on a first run', async () => {
    const r = await run(['ensure', 'ta', '--modules', 'publishing'])
    expect(r.code).toBe(0)
    expect(existsSync(seed('kernel-api'))).toBe(true)
    expect(r.result?.createdUsers).toContain('kernel-api')
  })
  test('--modules without kernel-api does not delete the seed an earlier run made', async () => {
    expect((await run(['ensure', 'ta', '--modules', 'publishing,kernel-api'])).code).toBe(0)
    expect(existsSync(seed('kernel-api'))).toBe(true)
    const r = await run(['ensure', 'ta', '--modules', 'publishing'])
    expect(r.code).toBe(0)
    expect(existsSync(seed('kernel-api'))).toBe(true)
    expect(r.result?.removedUsers).not.toContain('kernel-api')
  })
  test('--suspend removes the modules but keeps kernel-api, like a suspended customer under reconcile', async () => {
    expect((await run(['ensure', 'ta', '--modules', 'publishing,kernel-api'])).code).toBe(0)
    const r = await run(['ensure', 'ta', '--suspend'])
    expect(r.code).toBe(0)
    expect(existsSync(seed('publishing'))).toBe(false)
    expect(existsSync(seed('kernel-api'))).toBe(true)
    expect(r.result?.removedUsers).toEqual(['publishing'])
  })
  test('naming kernel-api by hand is the same set (no duplicate, no error)', async () => {
    const r = await run(['ensure', 'ta', '--modules', 'kernel-api,publishing'])
    expect(r.code).toBe(0)
    expect(existsSync(seed('kernel-api'))).toBe(true)
  })
})
