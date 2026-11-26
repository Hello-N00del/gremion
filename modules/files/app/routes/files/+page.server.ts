import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'
import { resolveWorkspaceRoots } from '$lib/server/files/workspace-roots'

export interface FileWorkspace {
  id: string
  /** The unit's plain name, as members are shown it. */
  label: string
  /** The folder's path on Nextcloud (its mount point, found by the ledger's folder id): what the browser opens. */
  rootPath: string
  abbr: string
  hue: number
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = await locals.auth()

  // Workspaces = org-units that provision a Nextcloud folder (seeder-backed, not
  // hardcoded). The sidebar uses these to scope the FileBrowser; absent a DB the
  // list degrades to empty and the sidebar shows only the "Alle Dateien" root.
  const units = await listOrgUnits().catch(() => [])
  const withFolder = units.filter((u) => u.wants_nextcloud_folder)
  // The folder of a unit is NOT named after it: on the Nextcloud shared by every customer its mount point
  // carries the customer's key. It is found by the folder id the ledger stores, never by name.
  const roots = await resolveWorkspaceRoots(withFolder)
  const workspaces: FileWorkspace[] = withFolder.map((u) => ({
    id: u.id,
    label: u.name,
    rootPath: roots.get(u.id) ?? u.name,
    abbr: deriveAbbr(u.name),
    hue: deriveHue(u.id),
  }))

  // Deep-link support (#157): the Gremien detail panel links to
  // `/files?ou=<orgUnitId>` so "Dokumente" lands directly in that committee's
  // folder. The active workspace (and thus the FileBrowser rootPath + sidebar
  // highlight) is keyed by the folder's path, so we resolve the incoming id to
  // its workspace's rootPath. Unknown id or no param → '' ("Alle Dateien"
  // root), which is also the no-deep-link default.
  const ou = url.searchParams.get('ou')
  const initialWorkspace = ou ? (workspaces.find((w) => w.id === ou)?.rootPath ?? '') : ''

  return {
    user: session?.user as SessionUser | undefined,
    workspaces,
    initialWorkspace,
  }
}
