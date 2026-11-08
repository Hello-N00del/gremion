// TASK-084-a Task 1 Step 5: the one-container harness itself.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { admin, assertScratchUrl, state } from '../harness/t084.js'

describe('t084 harness', () => {
  it('admin() reaches PostgreSQL 18', async () => {
    const sql = admin(1)
    try {
      const [r] = await sql<{ v: string }[]>`SELECT version() AS v`
      expect(r?.v).toContain('PostgreSQL 18')
    } finally {
      await sql.end({ timeout: 5 })
    }
  })

  it('assertScratchUrl accepts only 127.0.0.1 on the harness port', () => {
    const port = state().port
    expect(() => assertScratchUrl(`postgresql://u@127.0.0.1:${port}/x`)).not.toThrow()
    expect(() => assertScratchUrl(`postgresql://u@127.0.0.1:${port + 1}/x`)).toThrow(/not this run's scratch server/)
    expect(() => assertScratchUrl(`postgresql://u@10.0.0.5:${port}/x`)).toThrow(/not this run's scratch server/)
  })

  it('the container carries POSTGRES_PASSWORD_FILE and never POSTGRES_PASSWORD', () => {
    const s = state()
    const r = spawnSync('docker', ['inspect', s.container, '--format', '{{json .Config.Env}}'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    const env = JSON.parse(r.stdout) as string[]
    expect(env.filter((e) => e.startsWith('POSTGRES_PASSWORD='))).toEqual([])
    expect(env.filter((e) => e.startsWith('POSTGRES_PASSWORD_FILE='))).toEqual(['POSTGRES_PASSWORD_FILE=/run/secrets/t084_pw'])
  })
})
