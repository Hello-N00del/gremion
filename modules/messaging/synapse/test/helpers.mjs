// Shared helpers of the Synapse image-source tests (node:test; run by
// `make lint-synapse`). Everything resolves inside modules/messaging/synapse/.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SYN = fileURLToPath(new URL('..', import.meta.url))
export const SHIM = join(SYN, 'render-homeserver.sh')
export const TEMPLATE = join(SYN, 'homeserver.yaml')
export const PROBE = join(SYN, 'healthcheck.sh')
export const PREFLIGHT = join(SYN, 'db-preflight.py')

/** Fails naming the missing tool, so an absent binary never reads as a finding. */
export function requireTools(tools) {
  for (const t of tools) {
    const r = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`missing tool: ${t} (the Synapse module tests need it on PATH)`)
  }
}

/** The render inputs of brief section 5.2, every required key set. */
export function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    SYNAPSE_SERVER_NAME: 'chat.example.org',
    MATRIX_PUBLIC_URL: 'https://chat.example.org',
    SYNAPSE_DB_HOST: 'messaging-postgres',
    SYNAPSE_DB_PORT: '5432',
    SYNAPSE_DB_NAME: 'synapse',
    SYNAPSE_DB_USER: 'synapse',
    SYNAPSE_DB_PASSWORD: 'dbpwTESTvalue01',
    SYNAPSE_KEYCLOAK_ISSUER_URL: 'https://idp.example.org/auth/realms/council',
    SYNAPSE_OIDC_CLIENT_SECRET: 'oidcTESTsecret02',
    SYNAPSE_REGISTRATION_SHARED_SECRET: 'regTESTsecret03',
    ...extra,
  }
}

export function scratchDir() {
  return mkdtempSync(join(tmpdir(), 't198-synapse-'))
}

/**
 * Runs the render shim as the entrypoint does (`render-homeserver.sh true`).
 * Returns { status, stderr, text, cfg } -- cfg is the rendered YAML as JSON,
 * or null when nothing (or nothing parseable) was written.
 */
export function render(env, { template = TEMPLATE, args = ['true'] } = {}) {
  requireTools(['bash', 'python3'])
  const dir = scratchDir()
  const out = join(dir, 'homeserver.yaml')
  try {
    const r = spawnSync('bash', [SHIM, ...args], {
      env: { ...env, SYNAPSE_TEMPLATE: template, SYNAPSE_CONFIG: out },
      encoding: 'utf8',
    })
    let text = null
    try {
      text = readFileSync(out, 'utf8')
    } catch {
      text = null
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, text, cfg: text ? yamlToJson(text) : null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function yamlToJson(text) {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], {
    input: text,
    encoding: 'utf8',
  })
  if (r.status !== 0) return null
  return JSON.parse(r.stdout)
}

/** A copy of the template with `edit` applied, in a scratch dir; returns its path. */
export function editedTemplate(edit) {
  const dir = scratchDir()
  const p = join(dir, 'homeserver.yaml.tpl')
  writeFileSync(p, edit(readFileSync(TEMPLATE, 'utf8')))
  return p
}
