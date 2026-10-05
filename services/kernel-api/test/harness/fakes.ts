// In-process test doubles for the kernel API's deps: a control registry and a
// module registry held in memory, a gate with per-customer verdicts, and a
// recorder of every read and every tenant.host.rejected event. Every count a
// spec asserts ("zero registry reads", "exactly one lookup") comes from here.
import type { FastifyInstance } from 'fastify'
import { createHostRejectionLog, type HostRejectReason } from '@gremion/tenancy-core'
import { buildApp } from '../../src/app/build.ts'
import type { GateVerdict, KernelApiDeps, TenantRow, TenantStatus } from '../../src/app/deps.ts'
import type { ModuleRuntimeDecl } from '../../src/registry/declarations.ts'

export const APEX = 'example.org'
export const PROXY_SECRET = 'proxy-secret-for-tests-0123456789'
export const A_ID = '0192f0c1-2b3c-7d4e-8f00-1122334455aa'
export const B_ID = '0192f0c1-2b3c-7d4e-8f00-1122334455bb'
export const A_HOST = 'a.example.org'
export const B_HOST = 'council-b.example'

export function tenantRow(id: string, slug: string, status: TenantStatus = 'active', over: Partial<TenantRow> = {}): TenantRow {
  return {
    customerId: id,
    slug,
    status,
    realm: `realm-${slug}`,
    issuer: `https://${slug}.example.org/realms/realm-${slug}`,
    kcInternal: `http://keycloak:8080/realms/realm-${slug}`,
    dbConnRef: `env:KERNEL_DB_${slug.toUpperCase().replaceAll('-', '_')}`,
    ...over,
  }
}

export const DECL: ModuleRuntimeDecl = {
  version: '1.0.0',
  database: { postgresService: 'calendar-postgres', migrations: 'migrations' },
  export: { kind: 'pg_dump', retentionProfile: 'rp-cal-module-data' },
  timedJobs: [],
  platformServer: null,
}

export interface Recorder {
  hostLookups: string[]
  idLookups: string[]
  registryReads: string[]
  gateChecks: string[]
  tokenChecks: string[]
  events: Array<{ msg: string; fields: Record<string, unknown> }>
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>
}

export interface FakeWorld {
  /** host -> customer id */
  domains: Map<string, string>
  tenants: Map<string, TenantRow>
  /** customer id -> enabled (moduleKey, semver) */
  enabled: Map<string, Array<{ moduleKey: string; semver: string }>>
  declarations: Map<string, ModuleRuntimeDecl>
  verdicts: Map<string, GateVerdict>
  controlDown: boolean
  /** customer id the token was minted for -> accepted tokens, by token string */
  tokens: Map<string, string>
  moduleSecrets: Map<string, string>
}

export function world(): FakeWorld {
  return {
    domains: new Map([
      [A_HOST, A_ID],
      [B_HOST, B_ID],
    ]),
    tenants: new Map([
      [A_ID, tenantRow(A_ID, 'a')],
      [B_ID, tenantRow(B_ID, 'council-b')],
    ]),
    enabled: new Map([
      [A_ID, [{ moduleKey: 'calendar', semver: '1.0.0' }]],
      [B_ID, []],
    ]),
    declarations: new Map([['calendar', DECL]]),
    verdicts: new Map(),
    controlDown: false,
    tokens: new Map([
      ['token-a', A_ID],
      ['token-b', B_ID],
    ]),
    moduleSecrets: new Map([['calendar', 'calendar-module-secret-0123456789']]),
  }
}

export function fakeDeps(w: FakeWorld, over: Partial<KernelApiDeps> = {}): { deps: KernelApiDeps; rec: Recorder } {
  const rec: Recorder = { hostLookups: [], idLookups: [], registryReads: [], gateChecks: [], tokenChecks: [], events: [], logs: [] }
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => void rec.logs.push({ level, msg, ...(fields ? { fields } : {}) })
  const deps: KernelApiDeps = {
    proxySecret: PROXY_SECRET,
    platformDomain: APEX,
    moduleSecrets: w.moduleSecrets,
    tenancy: {
      async lookupHost(host) {
        rec.hostLookups.push(host)
        if (w.controlDown) throw new Error('connect ECONNREFUSED control')
        const id = w.domains.get(host)
        return id ? (w.tenants.get(id) ?? null) : null
      },
      async lookupId(id) {
        rec.idLookups.push(id)
        if (w.controlDown) throw new Error('connect ECONNREFUSED control')
        return w.tenants.get(id) ?? null
      },
    },
    registry: {
      async listEnabled(customerId) {
        rec.registryReads.push(`list:${customerId}`)
        return w.enabled.get(customerId) ?? []
      },
      async isEnabled(customerId, moduleKey) {
        rec.registryReads.push(`is:${customerId}:${moduleKey}`)
        return (w.enabled.get(customerId) ?? []).some((m) => m.moduleKey === moduleKey)
      },
    },
    tokens: {
      async verify(token, tenant) {
        rec.tokenChecks.push(tenant.customerId)
        if (w.tokens.get(token) !== tenant.customerId) throw new Error('token not for this customer')
        return { sub: 'person-1', iss: tenant.issuer }
      },
    },
    gate: {
      async check(tenant) {
        rec.gateChecks.push(tenant.customerId)
        return w.verdicts.get(tenant.customerId) ?? { ok: true }
      },
    },
    declarations: { get: (k) => w.declarations.get(k) },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    hostRejection: createHostRejectionLog({ emit: (msg, fields) => void rec.events.push({ msg, fields }), schedule: () => {} }),
    ...over,
  }
  return { deps, rec }
}

export function appWith(w: FakeWorld, over: Partial<KernelApiDeps> = {}): { app: FastifyInstance; rec: Recorder; deps: KernelApiDeps } {
  const { deps, rec } = fakeDeps(w, over)
  return { app: buildApp({}, deps), rec, deps }
}

/** The headers of a proxied BFF request for `host`. */
export function edge(host: string, token?: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    host,
    'x-forwarded-host': host,
    'x-proxy-trust': PROXY_SECRET,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...over,
  }
}

export function rejectedReasons(rec: Recorder): HostRejectReason[] {
  return rec.events.filter((e) => e.msg === 'tenant.host.rejected').map((e) => e.fields.reason as HostRejectReason)
}

export function reads(rec: Recorder): number {
  return rec.hostLookups.length + rec.idLookups.length + rec.registryReads.length
}
