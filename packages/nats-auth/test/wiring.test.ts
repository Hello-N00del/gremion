// TDD 9 — the wiring outside the package, read as post-conditions: make's
// dry-run, the functions of the host scripts executed in isolation, the
// verify part's registration. NATS_AUTH_WIRING_ROOT points it at another
// checkout (how it was watched RED against the base commit).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { NO_POSIX_BASH, lf } from './portable.ts'

const ROOT = process.env.NATS_AUTH_WIRING_ROOT ?? path.resolve(import.meta.dirname, '../../..')
const read = (p: string) => lf(readFileSync(path.join(ROOT, p), 'utf8'))
const make = (target: string) => execFileSync('make', ['-n', '-C', ROOT, target], { env: { ...process.env, MAKEFLAGS: '' } }).toString()
/** Run one shell function of a script in isolation (its definition only). */
function fn(file: string, name: string, call: string, env: Record<string, string> = {}): string {
  const src = read(file)
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)
  if (!m) throw new Error(`${file}: no function ${name}()`)
  return execFileSync('bash', ['-c', `${m[0]}\n${call}`], { env: { ...process.env, ...env } }).toString()
}
const body = (file: string, name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(read(file))
  if (!m) throw new Error(`${file}: no function ${name}()`)
  return m[0]
}

describe('Makefile (E5)', () => {
  test('make -n test-all runs test-nats-auth: the unit suite, proof.sh --auth and the image check', () => {
    const out = make('test-all')
    expect(out).toContain('pnpm --filter @gremion/nats-auth test')
    expect(out).toContain('bash packages/nats-auth/scripts/proof.sh --auth')
    expect(out).toContain('bash packages/nats-auth/scripts/image-check.sh')
  })
  test('make -n up runs nats-auth init before the state project comes up', () => {
    const out = make('up')
    const init = out.indexOf('tenant-create exec nats-auth init')
    const stateUp = out.search(/-p dev-state up -d/)
    expect(init, 'no nats-auth init in make -n up').toBeGreaterThan(-1)
    expect(stateUp).toBeGreaterThan(init)
    expect(out).toMatch(/for v in [^;]*\bnats_accounts\b[^;]*\bnats_secrets\b/)
  })
  test('make -n rebuild runs nats-auth init before the state project is recreated', () => {
    const out = make('rebuild')
    const init = out.indexOf('tenant-create exec nats-auth init')
    expect(init, 'no nats-auth init in make -n rebuild').toBeGreaterThan(-1)
    expect(out.search(/-p dev-state up -d --force-recreate/)).toBeGreaterThan(init)
  })
  test('make -n lint-sh lints proof.sh and image-check.sh', () => {
    const out = make('lint-sh')
    expect(out).toContain('packages/nats-auth/scripts/proof.sh')
    expect(out).toContain('packages/nats-auth/scripts/image-check.sh')
  })
})

describe('pooled-stack proof (E4)', () => {
  const F = 'test/host/integration/pooled-stack-proof.sh'
  test.skipIf(NO_POSIX_BASH)('state_port knows nats: 4222 (executed; skipped on Windows: NO_POSIX_BASH)', () => {
    expect(fn(F, 'state_port', 'state_port nats').trim()).toBe('4222')
  })
  test('state_port reads nats -> 4222 (static; the executed case above runs on Linux)', () => {
    expect(body(F, 'state_port')).toMatch(/^\s*nats\) echo 4222 ;;$/m)
  })
  test('prepare creates both nats volumes; state-up inits before up; state-wait waits for nats', () => {
    expect(body(F, 'phase_prepare')).toMatch(/for vol in [^;]*\bnats_accounts nats_secrets\b/)
    const up = body(F, 'phase_state_up')
    expect(up.indexOf('exec nats-auth init')).toBeGreaterThan(-1)
    expect(up.indexOf('compose state up')).toBeGreaterThan(up.indexOf('exec nats-auth init'))
    expect(body(F, 'phase_state_wait')).toMatch(/for s in [^;]*\bnats\b/)
  })
})

describe('host scripts (E6, G7, G8)', () => {
  test('bootstrap stage_networks ensures both nats volumes and runs no container', () => {
    const b = body('infra/host/bootstrap.sh', 'stage_networks')
    expect(b).toContain('ensure_volume  "${STACK}_nats_secrets"')
    expect(b).toContain('ensure_volume  "${STACK}_nats_accounts"')
    expect(b).not.toMatch(/docker run/)
  })
  test.skipIf(NO_POSIX_BASH)('gremion-backup external_volumes includes both nats volumes (executed; skipped on Windows: NO_POSIX_BASH)', () => {
    const out = fn('infra/host/bin/gremion-backup', 'external_volumes', 'external_volumes', { STACK: 'x' }).trim().split('\n')
    expect(out).toContain('x_nats_secrets')
    expect(out).toContain('x_nats_accounts')
  })
  test('gremion-backup external_volumes names both nats volumes (static; the executed case above runs on Linux)', () => {
    const b = body('infra/host/bin/gremion-backup', 'external_volumes')
    expect(b).toContain('${STACK}_nats_secrets')
    expect(b).toContain('${STACK}_nats_accounts')
  })
  test('gremion-deploy step 4 ensures both external nats volumes before nats-auth init (a host bootstrapped before this release has neither)', () => {
    const s4 = body('infra/host/bin/gremion-deploy', 'step_4_render')
    const loop = s4.search(/for vol in "\$\{STACK\}_nats_secrets" "\$\{STACK\}_nats_accounts"; do/)
    expect(loop, 'no ensure loop over both nats volumes in step 4').toBeGreaterThan(-1)
    expect(s4).toMatch(/docker volume inspect "\$vol" >\/dev\/null 2>&1 \\\n\s+\|\| docker volume create "\$vol" >\/dev\/null \\\n\s+\|\| die /)
    expect(s4.indexOf('exec nats-auth init')).toBeGreaterThan(loop)
  })
  test('install.md runs nats-auth init before the state project first comes up', () => {
    const md = read('docs/ops/runbook/install.md')
    const init = md.indexOf('run --rm --no-deps --entrypoint pnpm tenant-create exec nats-auth init')
    expect(init, 'install.md has no nats-auth init').toBeGreaterThan(-1)
    expect(md.indexOf('state.env up -d')).toBeGreaterThan(init)
  })
  test('gremion-deploy runs nats-auth init at the end of step 4 -- after gremion-render made the files tenant-create binds -- and never in step 3', () => {
    const s3 = body('infra/host/bin/gremion-deploy', 'step_3_space_and_pull')
    const s4 = body('infra/host/bin/gremion-deploy', 'step_4_render')
    expect(s3).not.toContain('nats-auth init')
    const render = s4.indexOf('"$prog" --release "$RELEASE_DIR"')
    const init = s4.indexOf('run --rm --no-deps --entrypoint pnpm tenant-create exec nats-auth init')
    expect(render).toBeGreaterThan(-1)
    expect(init).toBeGreaterThan(render)
    expect(s4).toMatch(/exec nats-auth init \\\n\s+\|\| die /)
  })
})

describe('verify (E8)', () => {
  test('the integration suite registers a nats-auth part judged like nats', async () => {
    const mod = (await import(path.join(ROOT, 'scripts/verify/suites/integration.mjs'))) as { INTEGRATION_PARTS: Record<string, unknown>; judgeNatsAuthTest?: unknown }
    expect(typeof mod.INTEGRATION_PARTS['nats-auth']).toBe('function')
    expect(typeof mod.judgeNatsAuthTest).toBe('function')
  })
})
