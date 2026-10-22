// services/kernel-api/src/app/wire.ts — the production deps (main.ts only).
// Two reader pools (control, gremion_platform: ensureKernelApiReader's role,
// prepare off: either may sit behind PgBouncer), the per-customer gate, the
// JWKS-backed token verifier, the module declarations the image carries, and
// a structured JSON logger. Nothing here runs at import time.
import type { Sql } from '@gremion/db'
import { createHostRejectionLog } from '@gremion/tenancy-core'
import postgres from 'postgres'
import { platformRegistryStore } from '../registry/store.ts'
import { loadDeclarations } from '../registry/declarations.ts'
import { allowsEnvRefs, createSecretResolver } from '../tenancy/secrets.ts'
import { controlTenancyStore } from '../tenancy/store.ts'
import { createTokenVerifier } from '../tenancy/tokens.ts'
import type { KernelApiConfig } from './config.ts'
import type { KernelApiDeps, Logger } from './deps.ts'
import { createCustomerGate } from './gate.ts'
import type { AuthzCliDeps } from '../authz/cli.ts'

/** One JSON line per event on stdout/stderr (the house log shape: level, msg, ts, fields). */
export function jsonLogger(write: (line: string, level: string) => void = (l, level) => (level === 'info' ? console.log(l) : console.error(l))): Logger {
  const emit = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => {
    try {
      write(JSON.stringify({ level, msg, ts: new Date().toISOString(), service: 'kernel-api', ...fields }), level)
    } catch {
      // a log line never fails a request
    }
  }
  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}

export interface Wired {
  deps: KernelApiDeps
  /** The two reader pools (control registry, gremion_platform), for the authz verbs; closed by close(). */
  pools: { control: Sql; platform: Sql }
  close(): Promise<void>
}

export function wireDeps(config: KernelApiConfig, o: { dirs: readonly string[]; log?: Logger; env?: NodeJS.ProcessEnv }): Wired {
  const log = o.log ?? jsonLogger()
  const open = (url: string): Sql => postgres(url, { max: 4, prepare: false, onnotice: () => {}, connect_timeout: 10, idle_timeout: 60 })
  const control = open(config.controlDbUrl)
  const platform = open(config.platformDbUrl)
  const resolveSecret = createSecretResolver({ env: o.env ?? process.env, allowEnvRefs: allowsEnvRefs(o.env ?? process.env) })
  const gate = createCustomerGate({ dirs: o.dirs, ...(config.releaseRef ? { releaseRef: config.releaseRef } : {}), resolveSecret, log })
  const declarations = loadDeclarations(config.modulesRoot)
  const deps: KernelApiDeps = {
    proxySecret: config.proxySecret,
    platformDomain: config.platformDomain,
    moduleSecrets: config.moduleSecrets,
    tenancy: controlTenancyStore(control),
    registry: platformRegistryStore(platform),
    tokens: createTokenVerifier(),
    gate,
    declarations: { get: (key) => declarations.get(key) },
    log,
    kernelDb: (tenant) => gate.db(tenant),
    hostRejection: createHostRejectionLog({ emit: (msg, fields) => log.warn(msg, { tenant: null, ...fields }) }),
  }
  return {
    deps,
    pools: { control, platform },
    async close() {
      await Promise.allSettled([gate.close(), control.end({ timeout: 5 }), platform.end({ timeout: 5 })])
    },
  }
}

/** The `kernel-api authz` verbs' deps (and the in-process sweep's): the same pools and gate as serve, no extra connection. */
export function authzCliDeps(w: Wired): AuthzCliDeps {
  const { control, platform } = w.pools
  return {
    // TRD-082 exemption: like migrate, the verbs iterate every active customer
    listCustomerIds: async () => (await control<{ id: string }[]>`SELECT t.id::text AS id FROM public.tenant t WHERE t.status = 'active' ORDER BY t.id`).map((r) => r.id),
    lookup: (id) => w.deps.tenancy.lookupId(id),
    db: (tenant) => w.deps.kernelDb!(tenant),
    moduleIds: async () =>
      new Map(
        (
          await platform<{ module_key: string; module_id: string }[]>`
            SELECT m.module_key, m.module_id::text FROM plt.module m
             WHERE EXISTS (SELECT 1 FROM plt.module_version v WHERE v.module_id = m.module_id)`
        ).map((r) => [r.module_key, r.module_id] as const),
      ),
    enabledModules: async (customerId) => new Set((await w.deps.registry.listEnabled(customerId)).map((m) => m.moduleKey)),
  }
}
