// gremion-ui/src/lib/server/polls/tenant-scope.ts
// Tenant binding for Nextcloud Polls. The platform shares ONE Nextcloud (one user
// table, one OIDC mapping, one admin credential) across tenants, so there is no
// per-tenant NC user/group to scope by. Instead every poll is bound to its tenant
// by a server-controlled marker at the head of the stored title:
//     "[gt:<tenantId>] <title as typed>"
// and every read/by-id route checks it. The marker is stripped before a poll
// leaves this module, only the LEADING marker counts (a marker typed inside a
// title is just text), and the marker is always written by the server, never taken
// from the caller. Polls with no marker (created before isolation) belong to no
// tenant unless VOTES_LEGACY_POLL_TENANT_ID names exactly one that claims them.
// DUPLICATED in modules/votes/src/polls/tenant-scope.ts (the leaf is a separate
// process); keep the two identical.

export const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MARKER = /^\[gt:([A-Za-z0-9-]{1,64})\] /

/** A poll-access refusal. `pollsStatus` is the HTTP status callers should map to
 *  (404 for another tenant's / unknown poll — deliberately no existence oracle). */
export class PollAccessError extends Error {
  readonly pollsStatus: number
  constructor(pollsStatus: number, message: string) {
    super(message)
    this.name = 'PollAccessError'
    this.pollsStatus = pollsStatus
  }
}

/** HTTP status of a poll-access refusal, else null. Duck-typed on `pollsStatus` so
 *  it survives module boundaries / test doubles of the client module. */
export function pollAccessStatus(e: unknown): number | null {
  const s = (e as { pollsStatus?: unknown } | null)?.pollsStatus
  return typeof s === 'number' ? s : null
}

export function assertTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new PollAccessError(400, 'missing or malformed tenant id')
  }
  return tenantId
}

export function tagTitle(tenantId: string, title: string): string {
  return `[gt:${assertTenantId(tenantId)}] ${title}`
}

export function readTitle(stored: string): { tenantId: string | null; title: string } {
  const m = MARKER.exec(stored)
  return m ? { tenantId: m[1] ?? null, title: stored.slice(m[0].length) } : { tenantId: null, title: stored }
}

/** Return the poll with its marker stripped if `tenantId` owns it, else null. */
export function scopePoll<T extends { configuration: { title: string } }>(
  poll: T,
  tenantId: string,
  legacyTenantId?: string,
): T | null {
  const { tenantId: owner, title } = readTitle(poll.configuration.title)
  const effective = owner ?? (legacyTenantId && legacyTenantId === tenantId ? tenantId : null)
  if (effective !== tenantId) return null
  return { ...poll, configuration: { ...poll.configuration, title } }
}
