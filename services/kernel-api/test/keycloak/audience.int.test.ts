// TASK-077 G8 (live half), Q7: a REAL Keycloak 26.6.1 imports the realm template
// and issues access tokens whose `aud` contains gremion-kernel-api; with the
// mapper removed it does not (guard (k)). Scratch containers t077g8-kc-*,
// 127.0.0.1 only, removed by name. Run with the integration config (needs Docker).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const REALM_FILE = fileURLToPath(new URL('../../../../docker/keycloak/realm-export.base.json', import.meta.url))
const IMAGE = 'quay.io/keycloak/keycloak:26.6.1'
const SECRET = 'g8-test-secret-g8-test-secret'
const containers: string[] = []
const tmp = mkdtempSync(join(tmpdir(), 't077g8-'))

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args[0]}: ${(r.stderr || '').slice(-400)}`)
  return (r.stdout || '').trim()
}

/** The template with placeholders filled and a direct-grant test user (test copy only; the repo file is untouched). */
function realmFor(withMapper: boolean) {
  const raw = readFileSync(REALM_FILE, 'utf8')
    .replaceAll('__REALM_NAME__', 'g8')
    .replaceAll('__APEX_DOMAIN__', 'localhost')
    .replaceAll('__SSL_REQUIRED__', 'none')
    .replace(/__[A-Z_]*SECRET__|__SMTP_PASSWORD__/g, 'x'.repeat(24))
    .replaceAll('__SMTP_PORT__', '25')
    .replaceAll('__SMTP_FROM__', 'g8@example.org')
    .replaceAll('__SMTP_HOST__', 'localhost')
    .replace(/__SMTP_[A-Z]+__/g, 'false')
  const doc = JSON.parse(raw)
  const ui = doc.clients.find((c: { clientId: string }) => c.clientId === 'gremion-ui')
  ui.directAccessGrantsEnabled = true
  ui.secret = SECRET
  if (!withMapper) {
    ui.protocolMappers = ui.protocolMappers.filter((m: { config: Record<string, string> }) => m.config['included.custom.audience'] !== 'gremion-kernel-api')
  }
  doc.users.push({
    username: 'g8user', enabled: true, emailVerified: true, email: 'g8@example.org', firstName: 'G', lastName: 'Eight',
    credentials: [{ type: 'password', value: 'g8pass', temporary: false }],
  })
  return doc
}

async function tokenAud(withMapper: boolean): Promise<string[]> {
  const name = `t077g8-kc-${withMapper ? 'with' : 'without'}`
  containers.push(name)
  const dir = join(tmp, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'g8.json'), JSON.stringify(realmFor(withMapper)))
  docker(['rm', '-f', name], true)
  docker(['create', '--name', name, '-p', '127.0.0.1::8080', '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=a', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=a', IMAGE, 'start-dev', '--import-realm'])
  docker(['cp', dir, `${name}:/opt/keycloak/data/import`])
  docker(['start', name])
  const port = docker(['port', name, '8080/tcp']).split('\n')[0].split(':').pop()
  const url = `http://127.0.0.1:${port}/realms/g8/protocol/openid-connect/token`
  const deadline = Date.now() + 100_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: 'gremion-ui', client_secret: SECRET, username: 'g8user', password: 'g8pass' }),
      })
      const body = (await r.json()) as { access_token?: string }
      if (body.access_token) {
        const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString())
        return ([] as string[]).concat(payload.aud ?? [])
      }
      last = JSON.stringify(body)
    } catch (e) {
      last = String(e)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`no token from ${name}: ${last}
${docker(["logs", "--tail", "25", name], true)}`)
}

afterAll(() => {
  for (const c of containers) { if (!process.env.G8_KEEP) docker(["rm", "-f", "-v", c], true) }
  rmSync(tmp, { recursive: true, force: true })
})

describe('G8 live: real Keycloak tokens carry the kernel audience', () => {
  it('with the mapper: aud contains gremion-kernel-api (and still gremion-ui)', async () => {
    const aud = await tokenAud(true)
    expect(aud).toContain('gremion-kernel-api')
    expect(aud).toContain('gremion-ui')
  }, 150_000)

  it('guard (k): mapper removed -> aud lacks gremion-kernel-api', async () => {
    const aud = await tokenAud(false)
    expect(aud).not.toContain('gremion-kernel-api')
  }, 150_000)
})
