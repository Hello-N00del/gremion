// services/vault/test/boot.test.ts
//
// Boot contract for the vault leaf entrypoint (src/index.ts).
//
// The leaf encrypts secrets at rest with AES-256-GCM using VAULT_ENCRYPTION_KEY.
// A missing or malformed key MUST fail closed: the process has to refuse to boot
// (non-zero exit) rather than start listening with encryption unavailable — a
// leaf that boots keyless would accept secret writes it cannot protect and only
// surface the misconfiguration as per-request 503s much later.
//
// This spawns the REAL entrypoint as a child process (via tsx) with a clean,
// minimal env so the host's own VAULT_ENCRYPTION_KEY can never leak in and mask
// the failure. PG-free: the key check runs before any store/PG contact, so this
// lives in the unit suite (vitest.config.ts includes test/**/*.test.ts and
// excludes only *.integration.test.ts).
import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = path.join(PKG_ROOT, 'src', 'index.ts')
const BOOT_TIMEOUT_MS = 20_000

// Launch the entrypoint under tsx with a deliberately minimal env: inherit PATH
// only (so node/tsx resolve) plus PORT=0. PORT=0 makes the *unfixed* code bind a
// free ephemeral port and stay alive, so a regression manifests as the intended
// "never exits" (killed by the timeout → null status) rather than a flaky
// EADDRINUSE crash. A fixed entrypoint throws at resolveKey BEFORE server.listen,
// so PORT is never consulted.
function runBoot(extraEnv: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: PKG_ROOT,
    env: { PATH: process.env.PATH ?? '', PORT: '0', ...extraEnv },
    encoding: 'utf-8',
    timeout: BOOT_TIMEOUT_MS,
  })
}

describe('vault boot — fail-closed on missing/invalid VAULT_ENCRYPTION_KEY', () => {
  it('refuses to boot (exits non-zero) when VAULT_ENCRYPTION_KEY is unset', () => {
    const res = runBoot({}) // key intentionally absent from the child env
    // Exited on its own — NOT killed by the timeout for staying alive listening.
    expect(res.signal).toBeNull()
    // Non-zero exit (process.exit(1) from the fatal boot handler); null == killed.
    expect(res.status).toBeGreaterThan(0)
    // Single actionable diagnostic naming the var and its required format.
    expect(res.stderr).toContain('VAULT_ENCRYPTION_KEY')
    expect(res.stderr).toMatch(/64 hex chars|32 bytes/)
  }, BOOT_TIMEOUT_MS + 10_000)

  it('refuses to boot when VAULT_ENCRYPTION_KEY is the wrong length', () => {
    const res = runBoot({ VAULT_ENCRYPTION_KEY: 'abcd' }) // valid hex, but 2 bytes
    expect(res.signal).toBeNull()
    expect(res.status).toBeGreaterThan(0)
    expect(res.stderr).toContain('VAULT_ENCRYPTION_KEY')
    expect(res.stderr).toMatch(/32 bytes/)
  }, BOOT_TIMEOUT_MS + 10_000)

  it('refuses to boot when VAULT_ENCRYPTION_KEY is non-hex', () => {
    const res = runBoot({ VAULT_ENCRYPTION_KEY: 'z'.repeat(64) }) // 64 chars, not hex
    expect(res.signal).toBeNull()
    expect(res.status).toBeGreaterThan(0)
    expect(res.stderr).toContain('VAULT_ENCRYPTION_KEY')
    expect(res.stderr).toMatch(/32 bytes/)
  }, BOOT_TIMEOUT_MS + 10_000)
})
