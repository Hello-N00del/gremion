// TASK-043 TDD 17b (section 11 (b)): the standalone compose file renders from
// its template; the port binds the loopback ONLY; no Traefik route; every
// capability dropped, a read-only root filesystem; IMAGE_TAG and PANEL_NETWORK
// are required (no default); the image is first-party with a build: (G11).
// `docker compose config` renders and creates nothing.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FILE = join(REPO, 'compose', 'control-panel', 'standalone.yml')
const TEMPLATE = join(REPO, 'compose', 'control-panel', 'standalone.env.tmpl')

/** The template with every CHANGE_ME_ value filled by a fixture value. */
function envFromTemplate(over: Record<string, string | null> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(TEMPLATE, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    env[m[1]!] = m[2]!.replace(/CHANGE_ME_OPERATOR_[a-z_]+/g, 'fixture')
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  return env
}

function render(env: Record<string, string>) {
  const base: Record<string, string> = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DOCKER_HOST', 'DOCKER_CONFIG', 'ProgramFiles', 'ProgramData']) {
    const v = process.env[k]
    if (v !== undefined) base[k] = v
  }
  return spawnSync('docker', ['compose', '-f', FILE, 'config', '--format', 'json'], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 })
}

describe('compose/control-panel/standalone.yml (TDD 17b)', () => {
  it('renders from its template: one loopback port, no Traefik route, hardened, first-party image with build:', () => {
    const r = render(envFromTemplate({ IMAGE_TAG: 'panel-test', PANEL_NETWORK: 'fixture_net' }))
    expect(r.status, r.stderr).toBe(0)
    const cfg = JSON.parse(r.stdout) as { services: Record<string, Record<string, unknown>> }
    expect(Object.keys(cfg.services)).toEqual(['control-panel'])
    const svc = cfg.services['control-panel']!
    const ports = svc.ports as { host_ip?: string; published?: string; target?: number }[]
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatchObject({ host_ip: '127.0.0.1', published: '3043', target: 3000 })
    expect((svc.labels as Record<string, string>)['traefik.enable']).toBe('false')
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

  it.each(['IMAGE_TAG', 'PANEL_NETWORK'])('fails without %s (no default)', (key) => {
    const r = render(envFromTemplate({ IMAGE_TAG: 'panel-test', PANEL_NETWORK: 'fixture_net', [key]: null }))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(key)
  })

  it('a PANEL_PORT never widens the bind address', () => {
    const r = render(envFromTemplate({ IMAGE_TAG: 't', PANEL_NETWORK: 'n', PANEL_PORT: '4000' }))
    expect(r.status, r.stderr).toBe(0)
    const ports = (JSON.parse(r.stdout) as { services: Record<string, { ports: { host_ip?: string }[] }> }).services['control-panel']!.ports
    expect(ports.every((p) => p.host_ip === '127.0.0.1')).toBe(true)
  })
})
