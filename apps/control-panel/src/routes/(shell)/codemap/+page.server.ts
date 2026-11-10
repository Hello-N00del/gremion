// The "Code-Karte" page: what the image build made of the code, read here (server-side) from the fixed files in
// CODEMAP_DIR. The gate in hooks.server.ts already ran. A missing map is a notice, never an error page.
import { readStatus } from '$lib/server/codemap'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = () => ({ status: readStatus() })
