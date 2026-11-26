import type { LayoutServerLoad } from './$types'
import { currentMountSuffix } from '$lib/server/files/workspace-roots'
import { stripMountSuffix } from '$lib/files/mount-label'

// A group folder's mount point on the shared Nextcloud ends in the customer's key (" (<key>)",
// lib/server/files/namespace.ts). Every page under /files shows the plain unit name instead, so the key
// is handed down once, here: it is a string derived from the tenant, no Nextcloud call. The top bar names
// the folder from the URL, so the segment of the group folder is named here too (crumbOverrides).
export const load: LayoutServerLoad = ({ url }) => {
  const mountSuffix = currentMountSuffix()
  const crumbOverrides: Record<string, string | null> = {}
  // /files/<group folder>/... and /files/edit/<group folder>/...: the mount point is the first or second segment below /files
  const segments = url.pathname.split('/').filter(Boolean)
  for (const segment of segments.slice(1, 3)) {
    if (mountSuffix === '') break
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // a segment that is not valid percent-encoding is shown as it is
    }
    const plain = stripMountSuffix(decoded, mountSuffix)
    if (plain !== decoded) crumbOverrides[segment] = plain
  }
  return { mountSuffix, crumbOverrides }
}
