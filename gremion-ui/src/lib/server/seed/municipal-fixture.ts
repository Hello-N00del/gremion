// The fictional municipal-council people fixture (test fixtures + the fixture-username list).
//
// The municipal ORGANISATION (Gemeinderat, Verwaltung, Ortschaftsräte, Ausschüsse, the kind
// catalogue, the Fraktionen, the demo-seeder discriminator) is vertical DATA and is served by
// the blueprint registry from verticals/municipal/blueprint.json -- it is NOT repeated here.
// What this file adds is only what a vertical deliberately does not carry: the people (users,
// memberships, caucus members). Keep it out of runtime seed paths: the registry's
// MUNICIPAL_BLUEPRINT@1 has no users.
//
// The `dev.admin` superuser is part of this fixture: seedAssignments and seedDevAdminGroups key
// on `userMap.get('dev.admin')`, so the seeder tests that run this blueprint need it. It carries
// the `it-admin` realm role and sits on the Gemeinderat and the Verwaltung.
import type { GremionBlueprint } from './org-blueprint'
import { resolveBlueprint } from './blueprint-registry'

const org = resolveBlueprint('MUNICIPAL_BLUEPRINT@1')

/** Fraktion membership by caucus key. councillor1 is in exactly ONE (one caucus per member per council). */
const CAUCUS_MEMBERS: Record<string, Array<{ userKey: string; termStart?: string }>> = {
  'fraktion-a': [{ userKey: 'councillor1', termStart: '2026-01-01' }],
  'fraktion-b': [{ userKey: 'councillor2' }],
  'fraktion-c': [{ userKey: 'councillor3' }],
}

export const MUNICIPAL_BLUEPRINT: GremionBlueprint = {
  ...org,
  users: [
    { username: 'councillor1', firstName: 'Carla', lastName: 'Eins',  email: 'councillor1@gemeinde.example', realmRole: 'member' },
    { username: 'councillor2', firstName: 'Cem',   lastName: 'Zwei',  email: 'councillor2@gemeinde.example', realmRole: 'member' },
    { username: 'councillor3', firstName: 'Cora',  lastName: 'Drei',  email: 'councillor3@gemeinde.example', realmRole: 'member' },
    // sachkundiger Bürger: sits on an Ausschuss WITHOUT a vote (§3.5(d) -- the `voting` flag
    // covers this; no new membership type needed).
    { username: 'sk.buerger',  firstName: 'Sven',  lastName: 'Kundig', email: 'sk.buerger@gemeinde.example',  realmRole: 'member' },
    { username: 'dev.admin',   firstName: 'Dev',   lastName: 'Admin',  email: 'dev.admin@musterstadt.example', realmRole: 'it-admin' },
  ],
  memberships: [
    { userKey: 'councillor1', orgUnitKey: 'gemeinderat',     membershipType: 'elected',   termStart: '2026-01-01', termEnd: null },
    { userKey: 'councillor2', orgUnitKey: 'gemeinderat',     membershipType: 'elected',   termStart: '2026-01-01', termEnd: null },
    { userKey: 'councillor3', orgUnitKey: 'gemeinderat',     membershipType: 'elected',   termStart: '2026-01-01', termEnd: null },
    // councillor1 sits on TWO Ausschüsse (cross-committee, one Fraktion)
    { userKey: 'councillor1', orgUnitKey: 'hauptausschuss',  membershipType: 'elected',   termStart: '2026-01-01', termEnd: null },
    { userKey: 'councillor1', orgUnitKey: 'finanzausschuss', membershipType: 'elected',   termStart: '2026-01-01', termEnd: null },
    // the sachkundige Bürger sits on the Kulturausschuss WITHOUT a vote
    { userKey: 'sk.buerger',  orgUnitKey: 'kulturausschuss', membershipType: 'unelected', termStart: '2026-01-01', termEnd: null,
      voting: false },
    { userKey: 'dev.admin',   orgUnitKey: 'gemeinderat',     membershipType: 'employee',  termStart: '2026-01-01', termEnd: null },
    { userKey: 'dev.admin',   orgUnitKey: 'verwaltung',      membershipType: 'employee',  termStart: '2026-01-01', termEnd: null },
  ],
  caucuses: {
    ...org.caucuses,
    caucuses: (org.caucuses?.caucuses ?? []).map((c) => ({ ...c, members: CAUCUS_MEMBERS[c.key] ?? [] })),
  },
}
