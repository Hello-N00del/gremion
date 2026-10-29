// Seed custody (Q4, TRD-408/442), read out of the renders the host uses:
// only tenant-create mounts the nats-secrets volume (rw, whole) or carries NATS_URL,
// with ONE named exception (TASK-080-a, brief G6): the kernel API, a NATS publisher
// of its own (FLOWS['kernel-api']), mounts ITS OWN subtree and nothing wider --
// the volume's kernel-api/ subpath at /run/secrets/nats/kernel-api, read-only.
// gremion-ui, gremion-public, migrate and nats mount no seed.
import path from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error -- untyped .mjs guard module shared with make lint-pooled-stack
import { PROJECTS, renderProject } from '../../../scripts/check-pooled-stack.mjs'

type Render = {
  services: Record<string, { environment?: Record<string, unknown>; volumes?: { type: string; source?: string; target: string; read_only?: boolean; volume?: { subpath?: string } }[] }>
  volumes?: Record<string, { name?: string; external?: boolean }>
}

const SECRETS_TARGET = '/run/secrets/nats'
/** The one service allowed to hold the seeds (and to reach the broker today). */
export const SEED_HOLDERS = ['tenant-create']
/** Services that read exactly one identity's subtree, read-only (and reach the broker as it). */
export const SEED_READERS: Record<string, { target: string; subpath: string }> = {
  'kernel-api': { target: '/run/secrets/nats/kernel-api', subpath: 'kernel-api' },
}

export function custodyViolations(r: Render, label: string): string[] {
  const out: string[] = []
  for (const [name, svc] of Object.entries(r.services ?? {})) {
    for (const v of svc.volumes ?? []) {
      const def = v.type === 'volume' && v.source ? r.volumes?.[v.source] : undefined
      const isSecrets =
        v.target === SECRETS_TARGET ||
        v.target.startsWith(`${SECRETS_TARGET}/`) ||
        String(def?.name ?? '').endsWith('_nats_secrets') ||
        // a bind source is a host path: '/' on Linux, '\' when compose renders on Windows
        (v.type === 'bind' && /(^|[\\/])secrets[\\/]nats([\\/]|$)/.test(String(v.source ?? '')))
      const reader = SEED_READERS[name]
      if (isSecrets && reader) {
        const exact = v.type === 'volume' && v.source === 'nats-secrets' && v.target === reader.target && v.read_only === true && v.volume?.subpath === reader.subpath
        if (!exact) out.push(`${label}/${name}: may mount only the ${reader.subpath}/ subpath of the seeds at ${reader.target}, read-only (${v.source ?? '?'} -> ${v.target}, subpath ${v.volume?.subpath ?? 'none'}, ro ${String(v.read_only)})`)
      } else if (isSecrets && !SEED_HOLDERS.includes(name)) out.push(`${label}/${name}: mounts the NATS seeds (${v.source ?? '?'} -> ${v.target})`)
    }
    if (svc.environment && 'NATS_URL' in svc.environment && !SEED_HOLDERS.includes(name) && !(name in SEED_READERS)) {
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

  test('only tenant-create mounts nats-secrets or carries NATS_URL -- in every project the host renders', () => {
    const ids = PROJECTS.map((p: { id: string }) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['state', 'app-blue', 'app-green', 'ops', 'mail']))
    for (const id of ids) {
      const r = id === 'state' ? state : id === 'app-blue' ? app : render(id)
      expect(Object.keys(r.services ?? {}).length, `${id} renders no service`).toBeGreaterThan(0)
      expect(custodyViolations(r, id)).toEqual([])
    }
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

  test('TASK-080-a: the kernel API holds exactly its own subtree, read-only, and reaches the broker; the migrate one-shot does neither', () => {
    const k = app.services['kernel-api']!
    const mounts = (k.volumes ?? []).filter((v) => v.source === 'nats-secrets')
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({ type: 'volume', source: 'nats-secrets', target: '/run/secrets/nats/kernel-api', read_only: true, volume: { subpath: 'kernel-api' } })
    expect(String(k.environment?.NATS_URL)).toBe('nats://nats-guardstack:4222')
    expect(k.environment?.NATS_SECRETS_DIR).toBe('/run/secrets/nats')
    const m = app.services['kernel-api-migrate']
    // the one-shot may be absent from a render; when present it holds neither the broker URL nor the secrets volume
    expect(m?.environment ?? {}).not.toHaveProperty('NATS_URL')
    expect((m?.volumes ?? []).some((v) => v.source === 'nats-secrets')).toBe(false)
  })

  test('break: the whole seed volume (or a writable, or another module\'s subpath) mounted into kernel-api fails', () => {
    for (const bad of [
      { type: 'volume', source: 'nats-secrets', target: SECRETS_TARGET, read_only: true },
      { type: 'volume', source: 'nats-secrets', target: '/run/secrets/nats/kernel-api', volume: { subpath: 'kernel-api' } },
      { type: 'volume', source: 'nats-secrets', target: '/run/secrets/nats/kernel', read_only: true, volume: { subpath: 'kernel' } },
    ]) {
      const broken = structuredClone(app)
      broken.services['kernel-api']!.volumes = [...(broken.services['kernel-api']!.volumes ?? []).filter((v) => v.source !== 'nats-secrets'), bad]
      expect(custodyViolations(broken, 'app-blue').join('\n'), JSON.stringify(bad)).toMatch(/app-blue\/kernel-api: may mount only the kernel-api\/ subpath/)
    }
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
