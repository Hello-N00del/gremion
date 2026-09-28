// Seed custody (Q4, TRD-408/442), read out of the renders the host uses:
// only tenant-create mounts the nats-secrets volume or carries NATS_URL;
// gremion-ui, gremion-public, migrate and nats mount no seed.
import path from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error -- untyped .mjs guard module shared with make lint-pooled-stack
import { PROJECTS, renderProject } from '../../../scripts/check-pooled-stack.mjs'

type Render = {
  services: Record<string, { environment?: Record<string, unknown>; volumes?: { type: string; source?: string; target: string }[] }>
  volumes?: Record<string, { name?: string; external?: boolean }>
}

const SECRETS_TARGET = '/run/secrets/nats'
/** The one service allowed to hold the seeds (and to reach the broker today). */
export const SEED_HOLDERS = ['tenant-create']

export function custodyViolations(r: Render, label: string): string[] {
  const out: string[] = []
  for (const [name, svc] of Object.entries(r.services ?? {})) {
    for (const v of svc.volumes ?? []) {
      const def = v.type === 'volume' && v.source ? r.volumes?.[v.source] : undefined
      const isSecrets =
        v.target === SECRETS_TARGET ||
        v.target.startsWith(`${SECRETS_TARGET}/`) ||
        String(def?.name ?? '').endsWith('_nats_secrets') ||
        (v.type === 'bind' && /(^|\/)secrets\/nats(\/|$)/.test(String(v.source ?? '')))
      if (isSecrets && !SEED_HOLDERS.includes(name)) out.push(`${label}/${name}: mounts the NATS seeds (${v.source ?? '?'} -> ${v.target})`)
    }
    if (svc.environment && 'NATS_URL' in svc.environment && !SEED_HOLDERS.includes(name)) {
      out.push(`${label}/${name}: carries NATS_URL (only ${SEED_HOLDERS.join(', ')} reaches the broker until TASK-079 wires the modules)`)
    }
  }
  return out
}

const render = (id: string): Render => renderProject(PROJECTS.find((p: { id: string }) => p.id === id)) as Render

describe('seed custody (compose renders)', () => {
  const state = render('state')
  const app = render('app-blue')

  test('the renders hold the services the rule reads', () => {
    expect(Object.keys(state.services)).toContain('nats')
    for (const s of ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create']) expect(Object.keys(app.services)).toContain(s)
  })

  test('only tenant-create mounts nats-secrets or carries NATS_URL', () => {
    expect(custodyViolations(state, 'state')).toEqual([])
    expect(custodyViolations(app, 'app-blue')).toEqual([])
  })

  test('tenant-create holds the seeds (rw), the accounts volume and NATS_URL', () => {
    const tc = app.services['tenant-create']!
    const vol = (target: string) => tc.volumes?.find((v) => v.target === target)
    expect(vol(SECRETS_TARGET)?.source).toBe('nats-secrets')
    expect(app.volumes?.['nats-secrets']).toMatchObject({ external: true, name: 'guardstack_nats_secrets' })
    expect(vol('/etc/nats/accounts')?.source).toBe('nats-accounts')
    expect(app.volumes?.['nats-accounts']).toMatchObject({ external: true, name: 'guardstack_nats_accounts' })
    expect(String(tc.environment?.NATS_URL)).toBe('nats://nats-guardstack:4222')
  })

  test('nats mounts the accounts read-only and no seed', () => {
    const n = state.services.nats!
    expect(n.volumes?.find((v) => v.target === '/etc/nats/accounts')).toMatchObject({ source: 'nats-accounts', read_only: true })
    expect(state.volumes?.['nats-accounts']).toMatchObject({ external: true, name: 'guardstack_nats_accounts' })
  })

  test('break: the seed mount added to gremion-ui fails', () => {
    const broken = structuredClone(app)
    broken.services['gremion-ui']!.volumes = [...(broken.services['gremion-ui']!.volumes ?? []), { type: 'volume', source: 'nats-secrets', target: SECRETS_TARGET }]
    expect(custodyViolations(broken, 'app-blue').join('\n')).toMatch(/app-blue\/gremion-ui: mounts the NATS seeds/)
  })

  test('break: a bind of secrets/nats into migrate fails', () => {
    const broken = structuredClone(app)
    broken.services.migrate!.volumes = [...(broken.services.migrate!.volumes ?? []), { type: 'bind', source: path.resolve('secrets/nats/kernel'), target: '/x' }]
    expect(custodyViolations(broken, 'app-blue').join('\n')).toMatch(/app-blue\/migrate: mounts the NATS seeds/)
  })

  test('break: NATS_URL on gremion-ui fails', () => {
    const broken = structuredClone(app)
    broken.services['gremion-ui']!.environment = { ...broken.services['gremion-ui']!.environment, NATS_URL: 'nats://nats-guardstack:4222' }
    expect(custodyViolations(broken, 'app-blue').join('\n')).toMatch(/gremion-ui: carries NATS_URL/)
  })
})
