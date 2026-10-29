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
import { createTenantDb } from './tenant-db.ts'

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
  const tenantDb = createTenantDb({ resolveSecret, log })
  const deps: KernelApiDeps = {
    proxySecret: config.proxySecret,
    platformDomain: config.platformDomain,
    moduleSecrets: config.moduleSecrets,
    tenancy: controlTenancyStore(control),
    registry: platformRegistryStore(platform),
    tokens: createTokenVerifier(),
    gate,
    declarations: { get: (key) => declarations.get(key) },
    tenantDb,
    log,
    hostRejection: createHostRejectionLog({ emit: (msg, fields) => log.warn(msg, { tenant: null, ...fields }) }),
  }
  return {
    deps,
    async close() {
      await Promise.allSettled([gate.close(), tenantDb.close(), control.end({ timeout: 5 }), platform.end({ timeout: 5 })])
    },
  }
}
