// services/kernel-api/src/tenancy/target.ts — Q3: which database a customer's
// request may touch. The ONLY input is the customer's own control row:
//   db_conn_ref -> the secret (createSecretResolver) -> a url, which must name
//   exactly t_<customer hex32>__kernel (tenant-store assertTargetMatches: the
//   path, an explicit host and user, no startup-parameter query).
// Never the environment: tenant-store's envResolveTarget fallback
// (store.ts openTenantDb, names.ts) is never reached from here (R4), so A's
// resolved connection can never name B's database, and a customer whose secret
// is unset is a 503 for that customer only.
//
// Runtime: that url as written (PgBouncer on a pooled stack; prepare off).
// Migrate: the same credentials with the DIRECT server's host (directUrlFor).
import { assertTargetMatches, tenantModuleDbName, type ResolveTarget } from '@gremion/tenant-store'
import { KERNEL_MODULE } from '../migrate/chain.ts'

export class TargetError extends Error {
  override name = 'TargetError'
}

/** t_<hex32>__kernel of `customerId` (throws on anything but a canonical UUIDv7). */
export function kernelDatabaseOf(customerId: string): string {
  return tenantModuleDbName(customerId, KERNEL_MODULE)
}

/**
 * A tenant-store ResolveTarget over the customers' db_conn_refs. `refOf`
 * answers the CURRENT ref of the customer being resolved (the request's own
 * control row); the module must be the kernel one.
 */
export function kernelTargetResolver(o: { refOf(customerId: string): string | undefined; resolveSecret(ref: string): string }): ResolveTarget {
  return (customerId, moduleId) => {
    if (moduleId !== KERNEL_MODULE) throw new TargetError(`the kernel API opens only kernel databases, not ${JSON.stringify(moduleId)}`)
    const ref = o.refOf(customerId)
    if (!ref) throw new TargetError(`customer ${customerId} has no db_conn_ref in hand`)
    const url = o.resolveSecret(ref)
    assertTargetMatches(url, kernelDatabaseOf(customerId))
    return { url }
  }
}

/**
 * The migrate job's url: the runtime url's user, password and database on the
 * DIRECT server of `directBase` (host, port and its allowed query), so the
 * runner's session advisory lock never crosses a pooler. Asserted again.
 */
export function directUrlFor(runtimeUrl: string, directBase: string, customerId: string): string {
  const runtime = new URL(runtimeUrl)
  const direct = new URL(directBase)
  if (direct.protocol !== 'postgres:' && direct.protocol !== 'postgresql:') throw new TargetError('the direct server url is not postgres://')
  runtime.hostname = direct.hostname
  runtime.port = direct.port
  runtime.search = direct.search
  const url = runtime.toString()
  assertTargetMatches(url, kernelDatabaseOf(customerId))
  return url
}
