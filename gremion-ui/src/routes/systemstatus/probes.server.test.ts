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

  // The in-tree files and messaging modules register their probe WITHOUT a moduleId
  // ({ service: 'nextcloud' } / { service: 'synapse' }). Matching by moduleId alone
  // dropped both rows and reported a dead Nextcloud or Synapse as "all reachable".
  describe('probes registered in the real shape (service only, no moduleId)', () => {
    const real = (nc: () => Promise<boolean>, sy: () => Promise<boolean>) => [
      { service: 'nextcloud', validate: nc },
      { service: 'synapse', validate: sy },
    ]

    it('are matched by service name', async () => {
      expect(byKey(await probeServices(deps({ moduleProbes: real(up, up) })))).toEqual({
        db: 'ok',
        keycloak: 'ok',
        nextcloud: 'ok',
        matrix: 'ok',
      })
    })

    it('a dead Nextcloud or Synapse is reported unreachable, not left out', async () => {
      const rows = await probeServices(deps({ moduleProbes: real(down, down) }))
      expect(byKey(rows)).toMatchObject({ nextcloud: 'unreachable', matrix: 'unreachable' })
    })

    it('a switched-off module is off and its probe is not called', async () => {
      const validate = vi.fn(up)
      const rows = await probeServices(
        deps({ modules: { files: false, messages: true }, moduleProbes: real(validate, up) }),
      )
      expect(byKey(rows).nextcloud).toBe('off')
      expect(validate).not.toHaveBeenCalled()
    })
  })

  it('an unreadable module config (null switches) lists no module row and probes no module', async () => {
    const validate = vi.fn(up)
    const rows = await probeServices(
      deps({ modules: null, moduleProbes: [{ service: 'nextcloud', validate }, { service: 'synapse', validate }] }),
    )
    expect(rows.map((r) => r.key)).toEqual(['db', 'keycloak'])
    expect(validate).not.toHaveBeenCalled()
  })

  it('logs each failed probe with its key and a reason, never the error message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await probeServices(
        deps({
          db: async () => {
            throw new TypeError('password=hunter2')
          },
          keycloak: down,
        }),
      )
      const lines = warn.mock.calls.map((c) => c.join(' '))
      expect(lines.some((l) => l.includes('db') && l.includes('TypeError'))).toBe(true)
      expect(lines.some((l) => l.includes('keycloak'))).toBe(true)
      expect(lines.join(' ')).not.toContain('hunter2')
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores probes that belong to no module', async () => {
    const validate = vi.fn(up)
    const rows = await probeServices(deps({ moduleProbes: [{ service: 'something', validate }] }))
    expect(rows.map((r) => r.key)).toEqual(['db', 'keycloak'])
    expect(validate).not.toHaveBeenCalled()
  })
})
