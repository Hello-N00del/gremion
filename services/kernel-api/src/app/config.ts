// services/kernel-api/src/app/config.ts — the kernel API's environment
// contract (lane note s.3), read ONCE at boot by main.ts and never by
// buildApp (routes:check boots buildApp with no environment, C18).
//
// Fail closed: a missing required value refuses to boot, naming it, and never
// echoes a value (several carry credentials).

export interface KernelApiConfig {
  /** Q8: the proxy shared secret; required at boot (gremion-ui's isProxyTrusted fails OPEN without it, R1). */
  proxySecret: string
  /** PLATFORM_DOMAIN: the apex whose nine reserved names are never a customer host. */
  platformDomain: string
  /** The control registry, as the kernel API's SELECT-only reader role (C13). */
  controlDbUrl: string
  /** gremion_platform, as the same reader role. */
  platformDbUrl: string
  /** Q8: KERNEL_API_MODULE_SECRET_<ID> per module key (lower-case key), only the ones set. */
  moduleSecrets: ReadonlyMap<string, string>
  /** The release this image ships (dist-vX.Y.Z): the schema gate's releaseRef, the migrate job's ledger release_ref. */
  releaseRef: string | undefined
  /** Where modules/<key>/module.json are read from (the image carries them). */
  modulesRoot: string
  /** Where scripts/migrations/ranges.json is read from (the register; the image carries it). */
  kernelRoot: string
  host: string
  port: number
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Readonly<Record<string, string | undefined>>

const MODULE_SECRET = /^KERNEL_API_MODULE_SECRET_([A-Z][A-Z0-9_]{1,39})$/

function required(env: Env, name: string, problems: string[]): string {
  const v = env[name]
  if (v === undefined || v.trim() === '') {
    problems.push(`${name} is not set`)
    return ''
  }
  return v.trim()
}

/** The module secrets present in `env`: KERNEL_API_MODULE_SECRET_<ID> -> lower-case module key. */
export function moduleSecretsFrom(env: Env): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(env)) {
    const m = MODULE_SECRET.exec(k)
    if (!m || v === undefined) continue
    const secret = v.trim()
    // A short secret is as good as none: it is ignored, so that module has no trust.
    if (secret.length < 24) continue
    out.set(m[1]!.toLowerCase(), secret)
  }
  return out
}

export function readConfig(env: Env, defaults: { modulesRoot: string; kernelRoot: string }): KernelApiConfig {
  const problems: string[] = []
  const proxySecret = required(env, 'TENANT_PROXY_SHARED_SECRET', problems)
  if (proxySecret && proxySecret.length < 24) problems.push('TENANT_PROXY_SHARED_SECRET is shorter than 24 characters')
  const platformDomain = required(env, 'PLATFORM_DOMAIN', problems)
  const controlDbUrl = required(env, 'KERNEL_API_CONTROL_DB_URL', problems)
  const platformDbUrl = required(env, 'KERNEL_API_PLATFORM_DB_URL', problems)
  const port = Number(env.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT is not a TCP port')
  if (problems.length) throw new ConfigError(`kernel-api refuses to boot: ${problems.join('; ')}`)
  return {
    proxySecret,
    platformDomain,
    controlDbUrl,
    platformDbUrl,
    moduleSecrets: moduleSecretsFrom(env),
    releaseRef: env.GREMION_RELEASE_REF?.trim() || undefined,
    modulesRoot: env.KERNEL_API_MODULES_ROOT?.trim() || defaults.modulesRoot,
    kernelRoot: env.KERNEL_API_KERNEL_ROOT?.trim() || defaults.kernelRoot,
    host: env.HOST ?? '0.0.0.0',
    port,
  }
}
