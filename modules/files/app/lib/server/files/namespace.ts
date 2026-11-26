// src/lib/server/files/namespace.ts
// The per-customer namespace of everything the files module creates on the SHARED Nextcloud.
//
// One Nextcloud serves every customer of an install, and its group folder mount points and group ids
// are instance-wide. A unit named "Vorstand" in two customers must therefore not mean the same mount
// point, and a unit id must not mean the same group.
// Each customer gets a short stable key, derived from its tenant id, and every name the module creates
// carries it:
//
//   group folder mount point   <unit name> (<key>)          e.g. "Vorstand (1efb7da1c9)"
//   Nextcloud group id         ou-<key>-<unit id>           e.g. "ou-1efb7da1c9-0192f0c4-..."
//
// The name SHOWN to members is the plain unit name: the mount point is only where the folder lives. A
// folder is always found by the folder id the provisioning ledger stores ("<folderId>:<groupId>"), never
// by name; plainMountName() is only for showing a mount point back to its customer.
//
// infra/host/bin/gremion-files-namespace derives the same key with sha256sum and moves the folders and
// groups made before the namespace existed into this form; the vector in namespace.test.ts and in
// test/host/files-namespace.bats must agree.
import { createHash } from 'node:crypto'
import { getTenant } from '$lib/server/tenant/context'

/** Hex digits of the key. Hashed, not a prefix of the id: tenant ids are time-ordered, so a prefix of two customers created close together nearly agrees. */
const KEY_LENGTH = 10

/** The key of one customer: the first 10 hex digits of sha256 of its (lower-case) tenant id. */
export function tenantKey(tenantId: string): string {
  if (tenantId.trim() === '') throw new Error('tenantKey: an empty tenant id has no namespace')
  return createHash('sha256').update(tenantId.toLowerCase()).digest('hex').slice(0, KEY_LENGTH)
}

/** The key of the customer whose scope the code runs in (the tenant context fails closed outside one). */
export function currentTenantKey(): string {
  return tenantKey(getTenant().id)
}

/** What a mount point ends in for this key. */
export function mountSuffix(key: string): string {
  return ` (${key})`
}

/** The group folder mount point of a unit made today: the plain name plus the customer's key. */
export function unitMountPoint(key: string, unitName: string): string {
  return `${unitName}${mountSuffix(key)}`
}

/** The Nextcloud group of a unit made today: `ou-<key>-<unit id>` (50 characters for a uuid; Nextcloud allows 64). */
export function unitGroupId(key: string, unitId: string): string {
  return `ou-${key}-${unitId}`
}

/** A mount point as its customer is shown it: this customer's key removed, any other value unchanged. */
export function plainMountName(key: string, mountPoint: string): string {
  const suffix = mountSuffix(key)
  return mountPoint.endsWith(suffix) && mountPoint.length > suffix.length ? mountPoint.slice(0, -suffix.length) : mountPoint
}
