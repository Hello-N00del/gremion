import { describe, it, expect } from 'vitest'
import { FILE_SETS, SERVICE, isLoopback, portViolations } from '../../scripts/check-app-port-binding.mjs'

// TASK-040: gremion-ui and gremion-public live in the per-colour app tier
// (docker-compose.app.yml), and the dev layer that publishes :3001/:3002 is
// docker-compose.app.dev.yml. These pin the file sets and the verdict on a
// render shaped like `docker compose config --format json`.

const port = (host_ip: string | undefined, published: string, target = 3000) => ({
  mode: 'ingress',
  ...(host_ip === undefined ? {} : { host_ip }),
  target,
  published,
  protocol: 'tcp',
})

describe('check-app-port-binding — file sets', () => {
  it('dev renders the app file plus the dev layer that publishes the ports, as DEV_APP does', () => {
    const dev = FILE_SETS.find((s: { name: string }) => s.name === 'dev')
    expect(dev?.args).toEqual(expect.arrayContaining(['docker-compose.app.yml', 'docker-compose.app.dev.yml']))
    expect(dev?.args).not.toContain('docker-compose.yml')
    expect(dev?.env).toMatchObject({ STACK: 'dev', COLOUR: 'blue', IMAGE_TAG: 'dev', COMPOSE_PROFILES: '*' })
  })

  it('prod renders the app file alone, once per colour, with every profile', () => {
    const prod = FILE_SETS.filter((s: { name: string }) => s.name.startsWith('prod'))
    expect(prod.map((s: { env: { COLOUR: string } }) => s.env.COLOUR).toSorted()).toEqual(['blue', 'green'])
    for (const s of prod) {
      expect(s.args.filter((a: string) => a.endsWith('.yml'))).toEqual(['docker-compose.app.yml'])
      expect(s.env.COMPOSE_PROFILES).toBe('*')
    }
  })

  it('never renders the root state files, which no longer carry gremion-ui', () => {
    for (const s of FILE_SETS) {
      expect(s.args).not.toContain('docker-compose.override.yml')
      expect(s.args).not.toContain('docker-compose.prod.yml')
    }
  })
})

describe('check-app-port-binding — portViolations', () => {
  it('accepts loopback-only bindings on every service', () => {
    const parsed = {
      services: {
        [SERVICE]: { ports: [port('127.0.0.1', '3001'), port('::1', '3001')] },
        'gremion-public': { ports: [port('127.0.0.1', '3002')] },
      },
    }
    expect(portViolations(parsed, 'dev')).toEqual([])
  })

  it('accepts a render with zero published ports (the host colours)', () => {
    expect(portViolations({ services: { [SERVICE]: {}, 'gremion-public': { ports: [] } } }, 'prod-blue')).toEqual([])
  })

  it('flags an unset host_ip (0.0.0.0) on gremion-ui', () => {
    const v = portViolations({ services: { [SERVICE]: { ports: [port(undefined, '3001')] } } }, 'dev')
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('gremion-ui publishes 0.0.0.0:3001')
  })

  it('flags a non-loopback bind on any other app service (gremion-public :3002)', () => {
    const v = portViolations(
      { services: { [SERVICE]: {}, 'gremion-public': { ports: [port('0.0.0.0', '3002')] } } },
      'dev',
    )
    expect(v).toEqual([expect.stringContaining('gremion-public publishes 0.0.0.0:3002')])
  })

  it('fails a render without gremion-ui: the wrong file set is not a clean one', () => {
    expect(portViolations({ services: { postgres: {} } }, 'dev')).toEqual([
      expect.stringContaining("service 'gremion-ui' absent from the dev render"),
    ])
    expect(portViolations({}, 'prod-green')).toHaveLength(1)
  })

  it('isLoopback: 127/8 and ::1 only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('[::1]')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})
