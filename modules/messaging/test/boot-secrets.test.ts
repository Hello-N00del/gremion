// The messages leaf defaulted LIVEKIT_API_SECRET and SYNAPSE_ADMIN_TOKEN to ''
// and booted anyway, so it would mint LiveKit tokens signed with an empty secret
// and call the Synapse admin API with an empty bearer. It must refuse to boot
// instead.
//
// Child-process harness: the REAL entrypoint (src/index.ts via tsx) is started
// with the secrets empty and must exit non-zero, naming the missing variables,
// instead of listening. With both secrets set it must come up and listen.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const LEAF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface BootResult {
  exitCode: number | null
  listening: boolean
  output: string
}

function boot(env: Record<string, string>, waitMs = 15_000): Promise<BootResult> {
  return new Promise((resolveBoot) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: LEAF_DIR,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (r: BootResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveBoot(r)
    }
    const onData = (d: Buffer) => {
      output += d.toString()
      if (output.includes('listening on')) {
        child.kill()
        finish({ exitCode: null, listening: true, output })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => finish({ exitCode: code, listening: false, output }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: null, listening: false, output })
    }, waitMs)
  })
}

const BASE = { INTERNAL_MESSAGES_SECRET: 'test-internal', MATRIX_URL: 'http://matrix.invalid:8008' }

describe('messages leaf boot refuses empty LiveKit / Synapse secrets', () => {
  it('exits non-zero, naming both variables, when both secrets are empty', async () => {
    const r = await boot({ ...BASE, LIVEKIT_API_SECRET: '', SYNAPSE_ADMIN_TOKEN: '' })
    expect(r.listening, r.output).toBe(false)
    expect(r.exitCode, r.output).not.toBe(0)
    expect(r.exitCode, r.output).not.toBeNull()
    expect(r.output).toContain('LIVEKIT_API_SECRET')
    expect(r.output).toContain('SYNAPSE_ADMIN_TOKEN')
  }, 30_000)

  it('exits non-zero when only LIVEKIT_API_SECRET is empty', async () => {
    const r = await boot({ ...BASE, LIVEKIT_API_SECRET: '', SYNAPSE_ADMIN_TOKEN: 'set' })
    expect(r.listening, r.output).toBe(false)
    expect(r.exitCode, r.output).not.toBeNull()
    expect(r.exitCode, r.output).not.toBe(0)
  }, 30_000)

  it('boots and listens when both secrets are set', async () => {
    const r = await boot({ ...BASE, LIVEKIT_API_SECRET: 'set', SYNAPSE_ADMIN_TOKEN: 'set' })
    expect(r.listening, r.output).toBe(true)
  }, 30_000)
})
