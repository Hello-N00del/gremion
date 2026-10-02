import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'

export interface FileWorkspace {
  id: string
  label: string
  abbr: string
  hue: number
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = await locals.auth()

  // Workspaces = org-units that provision a Nextcloud folder (seeder-backed, not
  // hardcoded). The sidebar uses these to scope the FileBrowser; absent a DB the
  // list degrades to empty and the sidebar shows only the "Alle Dateien" root.
  const units = await listOrgUnits().catch(() => [])
  const workspaces: FileWorkspace[] = units
    .filter((u) => u.wants_nextcloud_folder)
    .map((u) => ({
      id: u.id,
      label: u.name,
      abbr: deriveAbbr(u.name),
      hue: deriveHue(u.id),
    }))

  // Deep-link support (#157): the Gremien detail panel links to
  // `/files?ou=<orgUnitId>` so "Dokumente" lands directly in that committee's
  // folder. The active workspace (and thus the FileBrowser rootPath + sidebar
  // highlight) is keyed by the org-unit NAME, not its id, so we resolve the
  // incoming id to its workspace label. Unknown id or no param → '' ("Alle
  // Dateien" root), which is also the no-deep-link default.
  const ou = url.searchParams.get('ou')
  const initialWorkspace = ou ? (workspaces.find((w) => w.id === ou)?.label ?? '') : ''

  return {
    user: session?.user as SessionUser | undefined,
    workspaces,
    initialWorkspace,
  }
}
