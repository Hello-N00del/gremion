// TASK-043 TDD 17b (section 11 (b)) as amended by [D R29-I11]: the standalone
// compose file renders from its template; the panel is routed by the host's
// edge Traefik on ONE operator-supplied host name (PANEL_HOST: env only, no
// literal host in the repo), TLS through the operator-named resolver, with
// gremion-ui's HSTS; ORIGIN is https://<PANEL_HOST> (the app refuses every
// other Host); the only published port binds the loopback; every capability
// dropped, a read-only root filesystem; IMAGE_TAG, PANEL_NETWORK, PANEL_HOST
// and the Traefik entrypoint/resolver are required (no default); the image is
// first-party with a build: (G11). `docker compose config` creates nothing.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FILE = join(REPO, 'compose', 'control-panel', 'standalone.yml')
const TEMPLATE = join(REPO, 'compose', 'control-panel', 'standalone.env.tmpl')
const OPS_LINK = join(REPO, 'compose', 'control-panel', 'ops-link.yml')
const HOST = 'panel.fixture.example'

/** The template with every CHANGE_ME_ value filled by a fixture value. */
function envFromTemplate(over: Record<string, string | null> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(TEMPLATE, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    env[m[1]!] = m[2]!.replace(/CHANGE_ME_OPERATOR_[a-z_]+/g, 'fixture')
  }
  env.PANEL_HOST = HOST
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  return env
}

function render(env: Record<string, string>, files: string[] = [FILE]) {
  const base: Record<string, string> = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DOCKER_HOST', 'DOCKER_CONFIG', 'ProgramFiles', 'ProgramData']) {
    const v = process.env[k]
    if (v !== undefined) base[k] = v
  }
  return spawnSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 })
}

type Svc = Record<string, unknown>
function service(env: Record<string, string>, files?: string[]): Svc {
  const r = render(env, files)
  expect(r.status, r.stderr).toBe(0)
  const cfg = JSON.parse(r.stdout) as { services: Record<string, Svc>; networks?: Record<string, { name?: string; external?: boolean }> }
  expect(Object.keys(cfg.services)).toEqual(['control-panel'])
  return cfg.services['control-panel']!
}

describe('compose/control-panel/standalone.yml (TDD 17b, R29-I11)', () => {
  it('renders from its template: hardened, first-party image with build:, loopback-only port', () => {
    const svc = service(envFromTemplate({ IMAGE_TAG: 'panel-test', PANEL_NETWORK: 'fixture_net' }))
    const ports = svc.ports as { host_ip?: string; published?: string; target?: number }[]
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatchObject({ host_ip: '127.0.0.1', published: '3043', target: 3000 })
    expect(svc.read_only).toBe(true)
    expect(svc.cap_drop).toEqual(['ALL'])
    expect(svc.security_opt).toEqual(['no-new-privileges:true'])
    expect(svc.image).toBe('ghcr.io/hello-n00del/gremion-control-panel:panel-test')
    expect(svc.build).toBeTruthy()
    const env = svc.environment as Record<string, string>
    expect(env.PANEL_REQUIRED_ACR).toBe('loa2')
    expect(env.PANEL_EXECUTOR).toBe('none')
    expect(env.PANEL_OIDC_ISSUER).toMatch(/\/auth\/realms\/platform$/)
    expect(JSON.stringify(env)).not.toMatch(/SECRET=|client_secret\s*[:=]\s*[A-Za-z0-9]/)
  })

  it('one Traefik router on PANEL_HOST only, TLS by the named resolver, HSTS equal to gremion-ui, ORIGIN https://<PANEL_HOST>', () => {
    const svc = service(envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'fixture_net', PANEL_TRAEFIK_ENTRYPOINT: 'websecure', PANEL_CERT_RESOLVER: 'fixture-le' }))
    const l = svc.labels as Record<string, string>
    expect(l['traefik.enable']).toBe('true')
    expect(l['traefik.docker.network']).toBe('fixture_net')
    const routers = Object.keys(l).filter((k) => /^traefik\.http\.routers\.[^.]+\.rule$/.test(k))
    expect(routers).toEqual(['traefik.http.routers.gremion-panel.rule'])
    expect(l['traefik.http.routers.gremion-panel.rule']).toBe(`Host(\`${HOST}\`)`)
    expect(l['traefik.http.routers.gremion-panel.entrypoints']).toBe('websecure')
    expect(l['traefik.http.routers.gremion-panel.tls']).toBe('true')
    expect(l['traefik.http.routers.gremion-panel.tls.certresolver']).toBe('fixture-le')
    expect(l['traefik.http.routers.gremion-panel.middlewares']).toBe('gremion-panel-hsts')
    expect(l['traefik.http.routers.gremion-panel.service']).toBe('gremion-panel')
    expect(l['traefik.http.services.gremion-panel.loadbalancer.server.port']).toBe('3000')
    // gremion-ui's HSTS on the test env: one year, includeSubDomains, never preload.
    expect(l['traefik.http.middlewares.gremion-panel-hsts.headers.stsseconds']).toBe('31536000')
    expect(l['traefik.http.middlewares.gremion-panel-hsts.headers.stsincludesubdomains']).toBe('true')
    expect(l['traefik.http.middlewares.gremion-panel-hsts.headers.stspreload']).toBe('false')
    expect((svc.environment as Record<string, string>).ORIGIN).toBe(`https://${HOST}`)
  })

  it('names no literal host: the file and its template carry no domain', () => {
    for (const f of [FILE, TEMPLATE]) {
      // The registry host of the first-party image is the one allowed name.
      const text = readFileSync(f, 'utf8').replaceAll('ghcr.io/hello-n00del/', '')
      expect(text, f).not.toMatch(/\b[a-z0-9-]+\.(de|com|org|net|io|eu|app)\b/i)
    }
  })

  it.each(['IMAGE_TAG', 'PANEL_NETWORK', 'PANEL_HOST', 'PANEL_TRAEFIK_ENTRYPOINT', 'PANEL_CERT_RESOLVER'])('fails without %s (no default)', (key) => {
    const r = render(envFromTemplate({ IMAGE_TAG: 'panel-test', PANEL_NETWORK: 'fixture_net', [key]: null }))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(key)
  })

  it('a PANEL_PORT never widens the bind address', () => {
    const svc = service(envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'n', PANEL_PORT: '4000' }))
    const ports = svc.ports as { host_ip?: string }[]
    expect(ports.every((p) => p.host_ip === '127.0.0.1')).toBe(true)
  })
})

describe('compose/control-panel/ops-link.yml (the Betrieb page reads Prometheus server-side)', () => {
  const env = () => envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'fixture_net', PANEL_OPS_NETWORK: 'fixture-ops_ops' })

  it('adds the ops network and PANEL_PROMETHEUS_URL; Traefik stays pinned to the panel network; still one loopback port', () => {
    const svc = service(env(), [FILE, OPS_LINK])
    expect(Object.keys(svc.networks as Record<string, unknown>).sort()).toEqual(['ops', 'panel'])
    expect((svc.environment as Record<string, string>).PANEL_PROMETHEUS_URL).toBe('http://prometheus:9090')
    expect((svc.labels as Record<string, string>)['traefik.docker.network']).toBe('fixture_net')
    expect(svc.ports as unknown[]).toHaveLength(1)
    const r = render(env(), [FILE, OPS_LINK])
    const cfg = JSON.parse(r.stdout) as { networks: Record<string, { name?: string; external?: boolean }> }
    expect(cfg.networks.ops).toMatchObject({ name: 'fixture-ops_ops', external: true })
  })

  it('PANEL_OPS_NETWORK is required (no default network name)', () => {
    const r = render(envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'fixture_net' }), [FILE, OPS_LINK])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/PANEL_OPS_NETWORK required/)
  })

  it('without the overlay the panel has no Prometheus URL (the page shows itself disabled)', () => {
    const svc = service(envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'fixture_net' }))
    expect((svc.environment as Record<string, string>).PANEL_PROMETHEUS_URL).toBeUndefined()
  })
})
