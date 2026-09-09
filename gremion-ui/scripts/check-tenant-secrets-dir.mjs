// No shebang: invoked via `node …` (package.json `check`) — matches the sibling
// check-domain-regex.mjs / check-app-port-binding.mjs / check-tenant-env-guard.mjs
// convention (a hashbang breaks the vitest inline .mjs transform if a unit test
// imports a helper here).
// @ts-nocheck — standalone node build script (CLI-invoked, not TS-typed).
/**
 * P2.1c (#202, FIX3-C): TENANT_SECRETS_DIR vs provisioner-credential guard.
 *
 * THE BUG THIS CATCHES. The gremion-ui container bind-mounts the host
 * `${TENANT_SECRETS_DIR:-./secrets/tenants}` read-only at `/run/secrets/tenants`
 * (docker-compose.yml, D-SECMOUNT) so per-tenant secret files appear live. The
 * §7.2 least-privilege PROVISIONER service-account credential lives in a SEPARATE
 * host file `${TENANT_PROVISIONER_SECRET_FILE:-./secrets/tenant_provisioner}`
 * (scripts/tenant-provision.ts) — deliberately OUTSIDE the tenants dir so the
 * tenant data-plane container can never read it. If an operator points
 * TENANT_SECRETS_DIR at a PARENT dir that contains (or is an ancestor of) the
 * provisioner cred file — e.g. the `secrets/` root — the bind mount would expose
 * the provisioner credential INTO the tenant data-plane container, defeating the
 * least-privilege boundary (an in-container compromise could mint/destroy
 * tenants). This check fails (exit 1) when that containment holds.
 *
 * WHAT THIS CHECK ASSERTS (pure path math — NO docker, NO running stack):
 *   The resolved TENANT_SECRETS_DIR must NOT contain (and must not equal) the
 *   resolved provisioner credential file. Equivalently: the provisioner cred file
 *   must NOT resolve to a path inside TENANT_SECRETS_DIR.
 *
 * Defaults mirror tenant-provision.ts exactly (TENANT_SECRETS_DIR ->
 * ./secrets/tenants, TENANT_PROVISIONER_SECRET_FILE -> ./secrets/tenant_provisioner,
 * both relative to the repo root). With the defaults the dir is `secrets/tenants`
 * and the cred is its SIBLING `secrets/tenant_provisioner` — safe — so `pnpm
 * check` stays green in dev / on this staging host; the guard only fires on a
 * misconfiguration.
 *
 * Exit: 0 = OK; 1 = the provisioner credential is inside TENANT_SECRETS_DIR.
 *
 * Repo root: ../.. relative to this script (gremion-ui/scripts -> repo root).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** True iff `child` is `parent` itself or nested anywhere under it. Path-only
 *  (no fs access): both inputs must already be absolute + normalized. Uses
 *  path.relative so it is correct across `/` and `\` and trailing separators. */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  // rel === '' -> child IS parent; a non-'..'-prefixed, non-absolute rel -> nested.
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** The pure guard. Returns { ok, reason } given the resolved (absolute) secrets
 *  dir and provisioner cred file. The provisioner cred must NOT live inside the
 *  bind-mounted tenant-secrets dir. */
export function assertSecretsDirSafe(secretsDir, provisionerFile) {
  const dir = path.resolve(secretsDir)
  const cred = path.resolve(provisionerFile)
  if (isInside(dir, cred)) {
    return {
      ok: false,
      reason:
        `the provisioner credential file ('${cred}') resolves INSIDE TENANT_SECRETS_DIR ('${dir}') — ` +
        'that directory is bind-mounted read-only into the gremion-ui (tenant data-plane) container at ' +
        '/run/secrets/tenants (D-SECMOUNT), so the least-privilege provisioner credential would be ' +
        'exposed to the tenant data-plane. Point TENANT_SECRETS_DIR at a DEDICATED leaf directory ' +
        '(e.g. ./secrets/tenants) that does NOT contain the provisioner credential — NEVER the ' +
        'secrets/ root. See .env.example (TENANT_SECRETS_DIR) and scripts/tenant-provision.ts.',
    }
  }
  return { ok: true }
}

/** Resolve the two paths from env, mirroring tenant-provision.ts defaults. A
 *  relative TENANT_SECRETS_DIR (e.g. ./secrets/tenants) is resolved from the repo
 *  root, exactly as docker compose resolves a relative bind-mount source. */
function resolvedPaths() {
  const secretsDirRaw = process.env.TENANT_SECRETS_DIR ?? path.join(REPO_ROOT, 'secrets', 'tenants')
  const provisionerRaw =
    process.env.TENANT_PROVISIONER_SECRET_FILE ?? path.join(REPO_ROOT, 'secrets', 'tenant_provisioner')
  return {
    secretsDir: path.isAbsolute(secretsDirRaw) ? secretsDirRaw : path.resolve(REPO_ROOT, secretsDirRaw),
    provisionerFile: path.isAbsolute(provisionerRaw)
      ? provisionerRaw
      : path.resolve(REPO_ROOT, provisionerRaw),
  }
}

function main() {
  const { secretsDir, provisionerFile } = resolvedPaths()
  const result = assertSecretsDirSafe(secretsDir, provisionerFile)
  if (!result.ok) {
    console.error(`[tenant-secrets-dir] FAIL: ${result.reason}`)
    process.exit(1)
  }
  console.info(
    `[tenant-secrets-dir] OK — the provisioner credential ('${provisionerFile}') is outside ` +
      `TENANT_SECRETS_DIR ('${secretsDir}'); the bind mount cannot leak it into the tenant data-plane.`,
  )
  process.exit(0)
}

// Only run main() when invoked as a script (not when a unit test imports the
// exported helpers) — matches check-domain-regex.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
