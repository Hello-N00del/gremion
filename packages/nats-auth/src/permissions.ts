// packages/nats-auth/src/permissions.ts (@gremion/nats-auth)
//
// NATS user permissions, PURE in (tenant, module): derived from FLOWS and the
// STREAMS topology alone, with each stream filter's tenant wildcard replaced by
// the tenant (gremion.*.newsletter.> -> gremion.<t>.newsletter.>).
//
// Inside one tenant account (T_<t>) the streams are the tenant's own, so the
// JetStream API grants are per stream NAME:
//  - a publisher may publish its own subjects and read its stream's info
//    (ensureStream is read-only on an equal config -- @gremion/ports G2);
//  - a consumer may read the stream's info and create/inspect/delete/pull its
//    own consumers on that stream, and ack;
//  - nobody but the tenant's admin creates, updates, deletes or purges a
//    stream, or reads messages around a consumer (DIRECT.GET, STREAM.MSG.GET);
//  - every connection gets its OWN inbox prefix, _INBOX_<module>_<tenant>, and
//    is refused the shared _INBOX.>, so no module reads another's replies.
import { FLOWS, NO_BROKER, TOPOLOGY } from './flows.ts'

export interface PermissionSet {
  allow: string[]
  deny: string[]
}
export interface Permissions {
  publish: PermissionSet
  subscribe: PermissionSet
}

const TOKEN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Tenant ids become a subject token, an account name and a file name. */
export function assertTenantId(tenant: string): void {
  if (!TOKEN_RE.test(tenant)) {
    throw new Error(`[nats-auth] tenant id ${JSON.stringify(tenant)} is not a safe token (want ${TOKEN_RE})`)
  }
}

export function assertModuleId(module: string): void {
  if (!TOKEN_RE.test(module) || module === 'admin') {
    throw new Error(`[nats-auth] module id ${JSON.stringify(module)} is not a safe token (want ${TOKEN_RE}, not "admin")`)
  }
}

export const accountFor = (tenant: string): string => `T_${tenant}`
export const inboxPrefixFor = (tenant: string, module: string): string => `_INBOX_${module}_${tenant}`
export const ADMIN_INBOX = (tenant: string): string => `_INBOX_admin_${tenant}`
export const SYS_INBOX = '_INBOX_sysreload'

/** The stream's filters for one tenant: the tenant token (index 1) set. */
export function tenantSubjects(stream: string, tenant: string): string[] {
  const d = TOPOLOGY[stream]
  if (!d) throw new Error(`[nats-auth] unknown stream ${stream}`)
  return d.subjects.map((s) => {
    const t = s.split('.')
    if (t[1] !== '*') throw new Error(`[nats-auth] stream ${stream} filter ${s} has no tenant wildcard at token 1`)
    t[1] = tenant
    return t.join('.')
  })
}

export const MODULE_PUBLISH_DENY: readonly string[] = Object.freeze([
  '$JS.API.STREAM.CREATE.>',
  '$JS.API.STREAM.UPDATE.>',
  '$JS.API.STREAM.DELETE.>',
  '$JS.API.STREAM.PURGE.>',
  '$JS.API.DIRECT.GET.>',
  '$JS.API.STREAM.MSG.GET.>',
])

const consumerGrants = (s: string): string[] => [
  `$JS.API.STREAM.INFO.${s}`,
  `$JS.API.CONSUMER.CREATE.${s}`,
  `$JS.API.CONSUMER.CREATE.${s}.>`,
  `$JS.API.CONSUMER.INFO.${s}.>`,
  `$JS.API.CONSUMER.DELETE.${s}.>`,
  `$JS.API.CONSUMER.MSG.NEXT.${s}.>`,
  `$JS.ACK.${s}.>`,
]

export function flowFor(module: string) {
  const flow = FLOWS[module]
  if (flow) return flow
  if (NO_BROKER.ids.includes(module)) throw new Error(`[nats-auth] module ${module} is in NO_BROKER: it gets no NATS user`)
  throw new Error(`[nats-auth] module ${module} is in neither FLOWS nor NO_BROKER -- classify it in packages/nats-auth/src/flows.ts`)
}

export function modulePermissions(tenant: string, module: string): Permissions {
  assertTenantId(tenant)
  assertModuleId(module)
  const flow = flowFor(module)
  const allow: string[] = []
  for (const s of flow.publishes) allow.push(...tenantSubjects(s, tenant))
  allow.push('$JS.API.INFO')
  for (const s of flow.publishes) allow.push(`$JS.API.STREAM.INFO.${s}`)
  for (const s of flow.consumes) allow.push(...consumerGrants(s).filter((g) => !allow.includes(g)))
  return {
    publish: { allow, deny: [...MODULE_PUBLISH_DENY] },
    subscribe: { allow: [`${inboxPrefixFor(tenant, module)}.>`], deny: ['_INBOX.>'] },
  }
}

export function adminPermissions(tenant: string): Permissions {
  assertTenantId(tenant)
  return {
    publish: { allow: ['$JS.API.>', '$JS.ACK.>'], deny: [] },
    subscribe: { allow: [`${ADMIN_INBOX(tenant)}.>`], deny: ['_INBOX.>'] },
  }
}

/** The one SYS-account user: finds the server and asks it to reload. It must
 *  never read connections (CONNZ) or evict them (KICK) -- suspension is the
 *  declarative empty set plus a reload (Q8). */
export const SYS_RELOAD_PERMISSIONS: Readonly<Permissions> = Object.freeze({
  publish: { allow: ['$SYS.REQ.SERVER.PING', '$SYS.REQ.SERVER.*.RELOAD'], deny: [] },
  subscribe: { allow: [`${SYS_INBOX}.>`], deny: [] },
})

/** The rules a module's permissions must satisfy, re-derived independently of
 *  modulePermissions() so a change there that widens a grant fails here. */
export function permissionViolations(tenant: string, module: string, p: Permissions): string[] {
  const out: string[] = []
  const flow = flowFor(module)
  const own = flow.publishes.flatMap((s) => tenantSubjects(s, tenant))
  const consumed = new Set(flow.consumes)
  const touched = new Set([...flow.publishes, ...flow.consumes])
  for (const a of p.publish.allow) {
    if (a.startsWith('$JS.API.') || a.startsWith('$JS.ACK.')) {
      if (a === '$JS.API.INFO') continue
      if (/^\$JS\.API\.>$|^\$JS\.API\.[A-Z]+\.>$|^\$JS\.>$/.test(a)) {
        out.push(`${module}@${tenant}: wildcard JetStream grant ${a} (${'$JS.API.>'} is the admin's)`)
        continue
      }
      const m = /^\$JS\.(?:API\.(STREAM\.INFO|CONSUMER\.(?:CREATE|INFO|DELETE|MSG\.NEXT))|(ACK))\.([^.]+)(\.>)?$/.exec(a)
      if (!m) {
        out.push(`${module}@${tenant}: JetStream grant ${a} is not one a module may hold (STREAM.UPDATE, DIRECT.GET, ... are the admin's)`)
        continue
      }
      const verb = m[1] ?? m[2]
      const stream = m[3]!
      if (verb === 'STREAM.INFO') {
        if (!touched.has(stream)) out.push(`${module}@${tenant}: ${a} on a stream with no flow`)
      } else if (!consumed.has(stream)) {
        out.push(`${module}@${tenant}: ${a} on ${stream}, for which ${module} has no consume flow`)
      }
      continue
    }
    if (!own.includes(a)) out.push(`${module}@${tenant}: publish grant ${a} is outside its own subjects [${own.join(', ')}]`)
  }
  for (const s of touched) {
    if (!p.publish.allow.includes(`$JS.API.STREAM.INFO.${s}`)) out.push(`${module}@${tenant}: missing $JS.API.STREAM.INFO.${s} (its boot reads the stream)`)
  }
  for (const d of MODULE_PUBLISH_DENY) {
    if (!p.publish.deny.includes(d)) out.push(`${module}@${tenant}: missing publish deny ${d}`)
  }
  const inbox = `${inboxPrefixFor(tenant, module)}.>`
  if (p.subscribe.allow.length !== 1 || p.subscribe.allow[0] !== inbox) {
    out.push(`${module}@${tenant}: subscribe allow must be exactly its own inbox ${inbox}, got [${p.subscribe.allow.join(', ')}]`)
  }
  if (!p.subscribe.deny.includes('_INBOX.>')) out.push(`${module}@${tenant}: missing subscribe deny _INBOX.> (the shared inbox)`)
  return out
}

export function sysReloadViolations(p: Permissions): string[] {
  const want = ['$SYS.REQ.SERVER.PING', '$SYS.REQ.SERVER.*.RELOAD']
  const out: string[] = []
  for (const a of p.publish.allow) if (!want.includes(a)) out.push(`SYS reload user may publish ${a} (only ${want.join(', ')})`)
  for (const a of p.subscribe.allow) if (a !== `${SYS_INBOX}.>`) out.push(`SYS reload user may subscribe ${a} (only ${SYS_INBOX}.>)`)
  return out
}
