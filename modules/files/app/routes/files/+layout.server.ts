import type { LayoutServerLoad } from './$types'
import { currentMountSuffix } from '$lib/server/files/workspace-roots'

// A group folder's mount point on the shared Nextcloud ends in the customer's key (" (<key>)",
// lib/server/files/namespace.ts). Every page under /files shows the plain unit name instead, so the key
// is handed down once, here: it is a string derived from the tenant, no Nextcloud call.
export const load: LayoutServerLoad = () => ({ mountSuffix: currentMountSuffix() })
