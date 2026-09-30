// apps/control-panel/src/lib/server/config.ts — the panel's environment
// contract (README.md). Parsed and VALIDATED once; /healthz reports only
// whether it is valid (never a value). Secrets are read from *_FILE paths,
// never from the environment itself.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type Executor = 'gremion-tenant' | 'none'

export interface PanelConfig {
  /** The browser origin (behind `ssh -L`): SvelteKit's CSRF check compares with it. */
  origin: string
  /** The PUBLIC issuer, exact: https://<platform domain>/auth/realms/platform. */
  issuer: string
  /** Keycloak's internal /auth base for the server-to-server calls. */
  internalBase: string
  /** The ops realm (always `platform`: never a customer realm, TRD-048). */
  realm: string
  clientId: string
  clientSecret: string
  authSecret: string
  /** The acr every session must carry (loa2: multi-factor). */
  requiredAcr: string
  controlDatabaseUrl: string
  /** Absent: "Neuer Mandant" is disabled with the reason; list and status still work. */
  platformDatabaseUrl: string | null
  executor: Executor
  /** gremion-switch's evict bearer; absent: /api/internal/evict refuses everything. */
  internalPushSecret: string | null
}

export type Env = Readonly<Record<string, string | undefined>>
export type ConfigResult = { ok: true; config: PanelConfig } | { ok: false; problems: string[] }

export const OPS_REALM = 'platform'
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/

function readSecret(env: Env, name: string, readFile: (p: string) => string, problems: string[]): string {
  const path = env[name]
  if (!path) {
    problems.push(`${name} is not set`)
    return ''
  }
  try {
    const v = readFile(path).trim()
    if (!v) problems.push(`${name} names an empty file`)
    return v
  } catch {
    problems.push(`${name} names a file that cannot be read`)
    return ''
  }
}

export function loadConfig(env: Env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult {
  const problems: string[] = []
  const origin = env.ORIGIN ?? ''
  if (!ORIGIN_RE.test(origin)) problems.push('ORIGIN is not an exact origin (scheme://host[:port])')

  const issuer = (env.PANEL_OIDC_ISSUER ?? '').replace(/\/$/, '')
  let realm = ''
  try {
    const u = new URL(issuer)
    const m = /^\/auth\/realms\/([^/]+)$/.exec(u.pathname) ?? /^\/realms\/([^/]+)$/.exec(u.pathname)
    realm = m?.[1] ?? ''
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) problems.push('PANEL_OIDC_ISSUER must be https')
  } catch {
    problems.push('PANEL_OIDC_ISSUER is not a URL')
  }
  if (realm !== OPS_REALM) problems.push(`PANEL_OIDC_ISSUER must name the ops realm ${OPS_REALM} (a customer realm is never the panel's issuer, TRD-048)`)

  const internalBase = (env.PANEL_OIDC_INTERNAL_BASE ?? '').replace(/\/$/, '')
  if (!/^https?:\/\/[^/]+(\/.*)?$/.test(internalBase)) problems.push('PANEL_OIDC_INTERNAL_BASE is not a URL')

  const clientId = env.PANEL_OIDC_CLIENT_ID ?? ''
  if (!clientId) problems.push('PANEL_OIDC_CLIENT_ID is not set')
  const clientSecret = readSecret(env, 'PANEL_OIDC_CLIENT_SECRET_FILE', readFile, problems)
  const authSecret = readSecret(env, 'AUTH_SECRET_FILE', readFile, problems)

  const requiredAcr = env.PANEL_REQUIRED_ACR ?? ''
  if (requiredAcr !== 'loa2') problems.push('PANEL_REQUIRED_ACR must be loa2 (multi-factor sign-in, TRD-048)')

  const controlDatabaseUrl = env.CONTROL_DATABASE_URL ?? ''
  if (!/^postgres(ql)?:\/\//.test(controlDatabaseUrl)) problems.push('CONTROL_DATABASE_URL is not a postgres URL')
  const platformDatabaseUrl = env.PLATFORM_DATABASE_URL ? env.PLATFORM_DATABASE_URL : null
  if (platformDatabaseUrl !== null && !/^postgres(ql)?:\/\//.test(platformDatabaseUrl)) problems.push('PLATFORM_DATABASE_URL is not a postgres URL')

  const executorRaw = env.PANEL_EXECUTOR ?? 'none'
  if (executorRaw !== 'gremion-tenant' && executorRaw !== 'none') problems.push('PANEL_EXECUTOR must be gremion-tenant or none')

  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    config: {
      origin,
      issuer,
      internalBase,
      realm,
      clientId,
      clientSecret,
      authSecret,
      requiredAcr,
      controlDatabaseUrl,
      platformDatabaseUrl,
      executor: executorRaw as Executor,
      internalPushSecret: env.INTERNAL_PUSH_SECRET ? env.INTERNAL_PUSH_SECRET : null,
    },
  }
}

/**
 * The absolute path of an executable `name` on `pathEnv`, or null. POSIX: a
 * regular file with an execute bit; Windows (dev only): `name` + a PATHEXT
 * extension. A directory or a plain data file is never an executor.
 */
export function resolveOnPath(name: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  if (!name || name.includes('/') || name.includes('\\')) return null
  const win = process.platform === 'win32'
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        if (!win) {
          if ((st.mode & 0o111) === 0) continue
          accessSync(p, constants.X_OK)
        }
        return p
      } catch {
        // absent or not executable: keep looking
      }
    }
  }
  return null
}

/** Why "Neuer Mandant" is disabled, or null when it is available (Q6, the long-lead rule). */
export function newCustomerDisabledReason(c: PanelConfig, resolve: (name: string) => string | null = (n) => resolveOnPath(n)): string | null {
  if (c.platformDatabaseUrl === null) return 'Keine Plattform-Datenbank konfiguriert (PLATFORM_DATABASE_URL): gremion-tenant init ist auf diesem Host noch nicht gelaufen.'
  if (c.executor === 'none') return 'Kein Ausführer konfiguriert (PANEL_EXECUTOR=none): Mandanten legt gremion-tenant create auf dem Host an.'
  if (resolve('gremion-tenant') === null) {
    return 'PANEL_EXECUTOR=gremion-tenant, aber gremion-tenant ist in dieser Umgebung nicht im PATH (das Panel-Image enthält es nicht): Mandanten legt gremion-tenant create auf dem Host an.'
  }
  return null
}
