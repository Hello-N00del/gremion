import type { GremionBlueprint } from './org-blueprint'

// P2.3 (#202) T2 — the municipal-council (Gemeinderat) seedable blueprint.
//
// This is the same fixture proven in municipal-fixture.test.ts (multi-root
// Gemeinderat + Verwaltung + Ortschaftsräte as ROOT SIBLINGS, Ausschüsse with
// an advisory authority, three Fraktionen, a non-voting sachkundiger Bürger),
// promoted from an inline test fixture into an EXPORTED, seedable artifact so a
// non-default tenant can be fed its own blueprint at seed time
// (registry blueprintRef `MUNICIPAL_BLUEPRINT@1`).
//
// Difference from the fixture: it adds the `dev.admin` superuser the seeder
// hard-requires — seedAssignments and seedDevAdminGroups both key on
// `userMap.get('dev.admin')`. dev.admin carries the `it-admin` realm role
// (page access) and sits on the Gemeinderat so it can act there. There is no
// finance section: the finance feature module is carved out of the
// governance-only kernel.
export const MUNICIPAL_BLUEPRINT: GremionBlueprint = {
  schema_version: 1,
  // P2.3 (#202) Component 3: the includeDemo path (live staging env sets
  // SEED_DEMO_FIXTURES=true) seeds the MUNICIPAL demo set — a Beschluss/protocol
  // in an Ausschuss, keyed on THIS blueprint's keys (the carved-out calendar
  // entry is no longer seeded). Without this discriminator runSeed would run the
  // StuRa-hardcoded seeders, which throw `unknown org-unit key "studierendenrat"`
  // and abort the entire municipal seed.
  demoSeeder: 'municipal',
  // Per-tenant vocabulary: the kind taxonomy is DATA, not code (§3.5(a)).
  orgSchema: [
    { key: 'council', label: 'Gemeinderat', childTerm: 'Ausschüsse',
      allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 0 },
    { key: 'administration', label: 'Verwaltung',
      allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1, sortOrder: 1 },
    { key: 'district_council', label: 'Ortschaftsrat',
      allowedParentKinds: [], canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 2 },
    { key: 'committee', label: 'Ausschuss',
      allowedParentKinds: ['council'], canBeRoot: false, rootMin: 0, rootMax: 0, sortOrder: 3 }
  ],
  users: [
    { username: 'councillor1', firstName: 'Carla', lastName: 'Eins',  email: 'councillor1@gemeinde.example', realmRole: 'member' },
    { username: 'councillor2', firstName: 'Cem',   lastName: 'Zwei',  email: 'councillor2@gemeinde.example', realmRole: 'member' },
    { username: 'councillor3', firstName: 'Cora',  lastName: 'Drei',  email: 'councillor3@gemeinde.example', realmRole: 'member' },
    // sachkundiger Bürger: sits on an Ausschuss WITHOUT a vote (§3.5(d) —
    // the `voting` flag covers this; no new membership type needed).
    { username: 'sk.buerger',  firstName: 'Sven',  lastName: 'Kundig', email: 'sk.buerger@gemeinde.example',  realmRole: 'member' },
    // dev.admin is the all-access development superuser — seedAssignments and
    // seedDevAdminGroups both require userMap.get('dev.admin'). it-admin realm
    // role gates page access; its every-group membership is granted separately
    // in seed.ts → seedDevAdminGroups.
    { username: 'dev.admin',   firstName: 'Dev',   lastName: 'Admin',  email: 'dev.admin@musterstadt.example', realmRole: 'it-admin' }
  ],
  // Multi-root: Gemeinderat + Verwaltung + 2 Ortschaftsräte are ROOT SIBLINGS
  // (impossible under the retired hardcoded single-council rule).
  orgUnits: [
    { key: 'gemeinderat', name: 'Gemeinderat', description: 'Das kommunale Hauptorgan', kind: 'council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    { key: 'verwaltung', name: 'Stadtverwaltung', description: 'Die Verwaltung', kind: 'administration',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    { key: 'or-nord', name: 'Ortschaftsrat Nord', description: null, kind: 'district_council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    { key: 'or-sued', name: 'Ortschaftsrat Süd', description: null, kind: 'district_council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    { key: 'hauptausschuss', name: 'Hauptausschuss', description: null, kind: 'committee',
      parentKey: 'gemeinderat', visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    { key: 'finanzausschuss', name: 'Finanzausschuss', description: null, kind: 'committee',
      parentKey: 'gemeinderat', visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false },
    // a beratender (advisory) Ausschuss — §3.5(d) committee authority
    { key: 'kulturausschuss', name: 'Kulturausschuss', description: null, kind: 'committee',
      parentKey: 'gemeinderat', visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      authority: 'advisory' }
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
    // dev.admin sits on the Gemeinderat (and the Verwaltung) so the all-access
    // superuser can act in the council it administers (§T2: on the Gemeinderat
    // as employee).
    { userKey: 'dev.admin',   orgUnitKey: 'gemeinderat',     membershipType: 'employee',  termStart: '2026-01-01', termEnd: null },
    { userKey: 'dev.admin',   orgUnitKey: 'verwaltung',      membershipType: 'employee',  termStart: '2026-01-01', termEnd: null }
  ],
  roles: [],
  assignments: [],
  // Three Fraktionen on the Gemeinderat; councillor1 is in exactly ONE
  // (one caucus per member per council — the D-CD constraint).
  caucuses: {
    caucuses: [
      { key: 'fraktion-a', councilOrgUnitKey: 'gemeinderat', name: 'Fraktion A', color: '#e11d48',
        members: [{ userKey: 'councillor1', termStart: '2026-01-01' }] },
      { key: 'fraktion-b', councilOrgUnitKey: 'gemeinderat', name: 'Fraktion B', color: '#0ea5e9',
        members: [{ userKey: 'councillor2' }] },
      { key: 'fraktion-c', councilOrgUnitKey: 'gemeinderat', name: 'Fraktion C', color: null,
        members: [{ userKey: 'councillor3' }] }
    ]
  }
  // Carve note: the finance feature module is not part of the governance-only
  // kernel, so the (formerly empty) finance blueprint section is gone — the
  // GremionBlueprint type no longer carries a `finance` field.
}
