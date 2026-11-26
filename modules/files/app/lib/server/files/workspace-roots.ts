// src/lib/server/files/workspace-roots.ts
// Where the Files page opens a unit's folder.
//
// A unit's group folder lives on the ONE Nextcloud shared by every customer of the install, and its mount
// point is what a member's WebDAV path starts with. The mount point is not the unit's name (namespace.ts):
// a folder made today is "<unit name> (<key>)", a folder made before the namespace is the plain name until
// the operator script moves it. The folder is therefore found by the id the provisioning ledger stores
// ("<folderId>:<groupId>"), looked up in the instance's folder list: it works for both forms, and a plain
// name can never lead to another customer's folder.
import { getTenantOrNull } from '$lib/server/tenant/context'
import { getResource } from '$lib/server/governance/provisioning/ledger'
import { createNextcloudClient } from './nextcloud-client'
import { currentTenantKey, mountSuffix, unitMountPoint } from './namespace'

/** The suffix a mount point of the current customer ends in, or '' outside a customer's scope. */
export function currentMountSuffix(): string {
  return getTenantOrNull() === null ? '' : mountSuffix(currentTenantKey())
}

/**
 * unit id -> the path (the folder's current mount point) the Files page opens for it. A unit whose folder
 * cannot be found (no ledger row yet, a recorded folder that is gone, Nextcloud or the ledger not answering)
 * gets the mount point a folder made today would have; the page never fails over it.
 */
export async function resolveWorkspaceRoots(
  units: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  key: string = currentTenantKey(),
): Promise<Map<string, string>> {
  const roots = new Map<string, string>(units.map((u) => [u.id, unitMountPoint(key, u.name)]))
  if (units.length === 0) return roots
  try {
    const folders = new Map((await createNextcloudClient().listGroupFolders()).map((f) => [f.id, f.mountPoint]))
    for (const u of units) {
      const externalId = (await getResource(u.id, 'nextcloud'))?.external_id
      if (!externalId) continue
      const folderId = Number(externalId.slice(0, externalId.indexOf(':')))
      const mountPoint = folders.get(folderId)
      if (mountPoint) roots.set(u.id, mountPoint)
    }
  } catch (err) {
    console.error('[files] the folders of the units could not be resolved; opening the namespaced names instead:', err)
    return new Map(units.map((u) => [u.id, unitMountPoint(key, u.name)]))
  }
  return roots
}
