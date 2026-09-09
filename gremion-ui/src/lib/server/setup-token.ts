import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { requireTenant } from '$lib/server/tenant/context'

// #256-5: the setup token is PER-TENANT authority. It used to be minted from
// the CONFIG_PATH env only — one process-global secret that authorized the setup
// wizard (incl. KC admin-account creation) for EVERY tenant whose
// setup_complete was still false. The token path now derives from the RESOLVED
// tenant's configPath directory, so each tenant's wizard is gated by a token
// minted in that tenant's own data dir. requireTenant() is fail-closed — the
// setup routes always run inside the tenantResolveHandle ALS scope.
function getTokenPath(): string {
  const tenant = requireTenant()
  // Mirrors config.ts getConfigPath(): the `default` tenant keeps the
  // CONFIG_PATH env as its source of truth (byte-identical — ctx.configPath is
  // deliberately NOT consulted); every other tenant uses its registry-resolved
  // configPath. T14 §7.7: the default-tenant read goes through defaultTenantEnv.
  const configPath =
    tenant.id === 'default' ? (defaultTenantEnv('CONFIG_PATH') ?? '/app/config/config.json') : tenant.configPath
  return configPath.replace(/\/[^/]+$/, '') + '/.setup-token'
}

function initSetupToken(): string {
  const path = getTokenPath()
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim()
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(path, token, { mode: 0o600 })
  // Print clearly to stdout — operator retrieves from pod logs (kubectl logs <pod>)
  process.stdout.write(
    '\n' +
    '=======================================================\n' +
    '  Gremion Setup Token (retrieve from pod logs)\n' +
    `  ${token}\n` +
    '  Pass as:  X-Setup-Token: <token>\n' +
    '  on all requests to /api/setup/* until setup completes\n' +
    '=======================================================\n\n'
  )
  return token
}

// #256-5: keyed by canonical tenant id — one cached token per tenant, never a
// process-global `_token` shared across tenants.
const _tokens = new Map<string, string>()

function getSetupToken(): string {
  const tenantId = requireTenant().id
  let token = _tokens.get(tenantId)
  if (token === undefined) {
    token = initSetupToken()
    _tokens.set(tenantId, token)
  }
  return token
}

/** Returns true if the supplied token matches the CURRENT tenant's setup token (constant-time). */
export function validateSetupToken(candidate: string | null): boolean {
  if (!candidate) return false
  const expected = getSetupToken()
  if (candidate.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i)
  }
  return diff === 0
}

/** Delete the CURRENT tenant's token file and clear its cache entry once setup is complete. */
export function clearSetupToken(): void {
  const path = getTokenPath()
  if (existsSync(path)) rmSync(path)
  _tokens.delete(requireTenant().id)
}
