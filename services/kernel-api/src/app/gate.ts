// services/kernel-api/src/app/gate.ts — the per-customer schema gate (B21,
// TRD-353 runtime half): is THIS customer's kernel database at the kernel-api
// chain's union manifest, in idt.schema_migration?
//
//   * one tenant-store schemaGate for the kernel-api chain (ONE gate per
//     chain: its verdicts are keyed by customer within it), over the union of
//     KERNEL_API_MIGRATION_DIRS (G3 b) and the chain's own ledger (G3 a);
//   * cacheTtlMs 0 (lane note C5, A3; Q9): a suspended or freshly migrated
//     customer is judged on the very next request -- the tenant-store default
//     of 5 s would serve a stale verdict;
//   * the database it reads is the customer's own target (Q3, target.ts),
//     opened through tenant-store's bounded pool store with prepare off (the
//     runtime url may be PgBouncer), never an env fallback.
// A database behind, diverged or unreachable answers 503 for that customer
// only; a failed check is never cached.
import type { DbProfile, Sql } from '@gremion/db'
import { createTenantStore, schemaGate } from '@gremion/tenant-store'
import { KERNEL_API_LEDGER, KERNEL_MODULE } from '../migrate/chain.ts'
import { kernelTargetResolver } from '../tenancy/target.ts'
import type { CustomerGate, GateVerdict, Logger, TenantRow } from './deps.ts'

export const GATE_RETRY_AFTER_SECONDS = 30

export interface CustomerGateOptions {
  /** Absolute migration dirs of the kernel-api chain this image ships. */
  dirs: readonly string[]
  /** GREMION_RELEASE_REF: a contract row after the head is served only up to this release. */
  releaseRef?: string
  resolveSecret(ref: string): string
  log: Logger
  /** Test seam (tenant-store createTenantStore's). */
  createDb?: (profile: DbProfile) => Sql
  maxPools?: number
}

export function createCustomerGate(o: CustomerGateOptions): CustomerGate & { close(): Promise<void> } {
  // The ref of the customer being checked, from the request's own control row.
  const refs = new Map<string, string>()
  const store = createTenantStore({
    resolveTarget: kernelTargetResolver({ refOf: (id) => refs.get(id), resolveSecret: o.resolveSecret }),
    maxPools: o.maxPools ?? 64,
    maxConnections: 2,
    prepare: false,
    ...(o.createDb ? { createDb: o.createDb } : {}),
    onError: (err, context) => o.log.error('kernel-api: tenant pool', { context, err: (err as Error).message }),
  })
  const gate = schemaGate({
    dirs: o.dirs,
    ledger: KERNEL_API_LEDGER,
    openDb: (customerId) => store.openTenantDb(customerId, KERNEL_MODULE),
    cacheTtlMs: 0,
    retryAfterSeconds: GATE_RETRY_AFTER_SECONDS,
    ...(o.releaseRef ? { releaseRef: o.releaseRef } : {}),
    log: (line) => o.log.warn(line),
  })
  return {
    async check(tenant: TenantRow): Promise<GateVerdict> {
      refs.set(tenant.customerId, tenant.dbConnRef)
      return gate.check(tenant.customerId)
    },
    close: () => store.close(),
  }
}
