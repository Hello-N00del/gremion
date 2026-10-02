// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

// #157: the Gremien detail panel deep-links to `/files?ou=<orgUnitId>` so the
// "Dokumente" button lands directly in that committee's folder. The loader
// resolves the incoming id to its workspace LABEL (the org-unit name — the value
// the FileBrowser rootPath + sidebar highlight are keyed by); unknown id or no
// param degrades to '' ("Alle Dateien" root). listOrgUnits is mocked so the
// loader never touches a real DB connection.
const { mockListOrgUnits } = vi.hoisted(() => ({ mockListOrgUnits: vi.fn() }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: mockListOrgUnits,
}))

// F1-FIX-04 r3: the loader filters by visibility (D-3), so the rows carry the
// real columns it reads; the committee_only case lives in
// routes/calendar/calendar-committees-visibility.test.ts.
const UNITS = [
  { id: 'ou-vorstand', parent_id: null, visibility: 'all_members', name: 'Vorstand', wants_nextcloud_folder: true },
  { id: 'ou-fsi', parent_id: null, visibility: 'all_members', name: 'Fachschaft Informatik', wants_nextcloud_folder: true },
  // no Nextcloud folder → never a workspace, so its id must not resolve
  { id: 'ou-no-folder', parent_id: null, visibility: 'all_members', name: 'Geschlossene Gruppe', wants_nextcloud_folder: false },
]

function makeLocals() {
  return {
    auth: async () => ({ user: { id: 'u1', email: 'a@b.de', name: 'A B', roles: ['member'], groups: [] } }),
  }
}

async function runLoad(rawUrl: string) {
  const { load } = await import('./+page.server')
  // @ts-expect-error partial event mock — load only reads locals.auth + url
  return load({ locals: makeLocals(), url: new URL(rawUrl) })
}

describe('GET /files loader — ?ou deep-link (#157)', () => {
  beforeEach(() => {
    mockListOrgUnits.mockReset()
    mockListOrgUnits.mockResolvedValue(UNITS)
  })

  it('resolves ?ou=<existing workspace id> to that workspace label', async () => {
    const result = (await runLoad('http://localhost/files?ou=ou-vorstand')) as {
      initialWorkspace: string
    }
    expect(result.initialWorkspace).toBe('Vorstand')
  })

  it('resolves a second workspace id correctly', async () => {
    const result = (await runLoad('http://localhost/files?ou=ou-fsi')) as { initialWorkspace: string }
    expect(result.initialWorkspace).toBe('Fachschaft Informatik')
  })

  it('returns "" for an unknown ou id', async () => {
    const result = (await runLoad('http://localhost/files?ou=ou-does-not-exist')) as {
      initialWorkspace: string
    }
    expect(result.initialWorkspace).toBe('')
  })

  it('returns "" for an org-unit without a Nextcloud folder (not a workspace)', async () => {
    const result = (await runLoad('http://localhost/files?ou=ou-no-folder')) as {
      initialWorkspace: string
    }
    expect(result.initialWorkspace).toBe('')
  })

  it('returns "" when no ou param is present', async () => {
    const result = (await runLoad('http://localhost/files')) as { initialWorkspace: string }
    expect(result.initialWorkspace).toBe('')
  })
})
