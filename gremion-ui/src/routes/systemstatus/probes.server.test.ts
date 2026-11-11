import { describe, it, expect, vi } from 'vitest'
import { probeServices, type ProbeDeps } from './probes.server'

// E3 (finding 4): the status page reports what the app can check right now. Every
// row is a live probe or a module switch; nothing is read from a provisioning
// record that a hand-wired tenant never updates.

const up = async () => true
const down = async () => false

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    db: async () => undefined,
    keycloak: up,
    modules: { files: true, messages: true },
    moduleProbes: [
      { moduleId: 'files', service: 'nextcloud', validate: up },
      { moduleId: 'messages', service: 'synapse', validate: up },
    ],
    timeoutMs: 50,
    ...over,
  }
}

const byKey = (rows: { key: string; status: string }[]) => Object.fromEntries(rows.map((r) => [r.key, r.status]))

describe('probeServices', () => {
  it('reports every service ok when all probes answer', async () => {
    expect(byKey(await probeServices(deps()))).toEqual({
      db: 'ok',
      keycloak: 'ok',
      nextcloud: 'ok',
      matrix: 'ok',
    })
  })

  it('a rejecting database probe is unreachable, the others stay ok', async () => {
    const rows = await probeServices(
      deps({
        db: async () => {
          throw new Error('connection refused')
        },
      }),
    )
    expect(byKey(rows)).toMatchObject({ db: 'unreachable', keycloak: 'ok', nextcloud: 'ok', matrix: 'ok' })
  })

  it('a keycloak probe returning false is unreachable', async () => {
    expect(byKey(await probeServices(deps({ keycloak: down }))).keycloak).toBe('unreachable')
  })

  it('a module probe that returns false or throws is unreachable', async () => {
    const rows = await probeServices(
      deps({
        moduleProbes: [
          { moduleId: 'files', service: 'nextcloud', validate: down },
          {
            moduleId: 'messages',
            service: 'synapse',
            validate: async () => {
              throw new Error('boom')
            },
          },
        ],
      }),
    )
    expect(byKey(rows)).toMatchObject({ nextcloud: 'unreachable', matrix: 'unreachable' })
  })

  it('a probe that never answers is unreachable after the timeout', async () => {
    const rows = await probeServices(deps({ keycloak: () => new Promise<boolean>(() => {}) }))
    expect(byKey(rows).keycloak).toBe('unreachable')
  })

  it('a switched-off module is off and its probe is never called', async () => {
    const validate = vi.fn(up)
    const rows = await probeServices(
      deps({
        modules: { files: false, messages: true },
        moduleProbes: [
          { moduleId: 'files', service: 'nextcloud', validate },
          { moduleId: 'messages', service: 'synapse', validate: up },
        ],
      }),
    )
    expect(byKey(rows).nextcloud).toBe('off')
    expect(validate).not.toHaveBeenCalled()
  })

  it('a module key missing from the switch map counts as off', async () => {
    expect(byKey(await probeServices(deps({ modules: { messages: true } }))).nextcloud).toBe('off')
  })

  it('a service whose module registers no probe in this deployment gets no row at all', async () => {
    const rows = await probeServices(
      deps({ moduleProbes: [{ moduleId: 'messages', service: 'synapse', validate: up }] }),
    )
    expect(rows.map((r) => r.key)).toEqual(['db', 'keycloak', 'matrix'])
  })

  it('ignores probes that belong to no module', async () => {
    const validate = vi.fn(up)
    const rows = await probeServices(deps({ moduleProbes: [{ service: 'something', validate }] }))
    expect(rows.map((r) => r.key)).toEqual(['db', 'keycloak'])
    expect(validate).not.toHaveBeenCalled()
  })
})
