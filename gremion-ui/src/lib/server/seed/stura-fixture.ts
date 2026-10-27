// The realistic StuRa people fixture (test fixtures + the fixture-username list).
//
// The StuRa ORGANISATION (units, offices, kind catalogue) is vertical DATA and is
// served by the blueprint registry from verticals/stura/blueprint.json -- it is
// NOT repeated here. What this file adds is only what a vertical deliberately does
// not carry: the fictional people (users, memberships, office assignments) the
// seed/integration tests and `fixtureUsernames()` need. Keep it out of runtime
// seed paths: the registry's STURA_BLUEPRINT@1 has no users.
import type { GremionBlueprint } from './org-blueprint'
import { resolveBlueprint } from './blueprint-registry'

// Term epochs for the fixture. The elected term (Oct 2025 - Sep 2026) is the
// currently-active StuRa term; the appointment dates are seed-authoring-relative
// (authored 2026-05-22) and run one year forward.
const ELECTED_START = '2025-10-01'
const ELECTED_END = '2026-09-30'
const APPOINTED_START = '2026-05-22'
const APPOINTED_END = '2027-05-22'

const org = resolveBlueprint('STURA_BLUEPRINT@1')

export const STURA_BLUEPRINT: GremionBlueprint = {
  ...org,
  users: [
    { username: 'anna.berger',  firstName: 'Anna',   lastName: 'Berger',  email: 'anna.berger@council.example',  realmRole: 'council-admin' },
    { username: 'ben.hoffmann', firstName: 'Ben',    lastName: 'Hoffmann', email: 'ben.hoffmann@council.example', realmRole: 'council-admin' },
    { username: 'clara.wagner', firstName: 'Clara',  lastName: 'Wagner',  email: 'clara.wagner@council.example',  realmRole: 'member' },
    { username: 'david.schulz', firstName: 'David',  lastName: 'Schulz',  email: 'david.schulz@council.example',  realmRole: 'member' },
    { username: 'emma.fischer', firstName: 'Emma',   lastName: 'Fischer', email: 'emma.fischer@council.example',  realmRole: 'member' },
    { username: 'felix.weber',  firstName: 'Felix',  lastName: 'Weber',   email: 'felix.weber@council.example',   realmRole: 'member' },
    { username: 'greta.koch',   firstName: 'Greta',  lastName: 'Koch',    email: 'greta.koch@council.example',    realmRole: 'member' },
    { username: 'hannes.bauer', firstName: 'Hannes', lastName: 'Bauer',   email: 'hannes.bauer@council.example',  realmRole: 'member' },
    { username: 'ida.richter',  firstName: 'Ida',    lastName: 'Richter', email: 'ida.richter@council.example',   realmRole: 'member' },
    { username: 'jonas.klein',  firstName: 'Jonas',  lastName: 'Klein',   email: 'jonas.klein@council.example',   realmRole: 'member' },
    { username: 'klara.wolf',   firstName: 'Klara',  lastName: 'Wolf',    email: 'klara.wolf@council.example',    realmRole: 'guest' },
    { username: 'lena.neumann', firstName: 'Lena',   lastName: 'Neumann', email: 'lena.neumann@council.example',  realmRole: 'member' },
    { username: 'tobias.krause',firstName: 'Tobias', lastName: 'Krause',  email: 'tobias.krause@council.example', realmRole: 'it-admin' },
    // tom.maier: deliberate fixture — a registered 'guest' user with no org-unit
    // membership, exercising the "invited but not yet placed" account state.
    { username: 'tom.maier',    firstName: 'Tom',    lastName: 'Maier',   email: 'tom.maier@council.example',     realmRole: 'guest' },
    { username: 'dev.admin',    firstName: 'Dev',    lastName: 'Admin',   email: 'dev.admin@council.example',     realmRole: 'it-admin' }
  ],
  memberships: [
    { userKey: 'anna.berger',  orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'anna.berger',  orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ben.hoffmann', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ben.hoffmann', orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'ref-finanzen',    membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'david.schulz', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'david.schulz', orgUnitKey: 'ref-hochschulpolitik', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'emma.fischer', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'emma.fischer', orgUnitKey: 'ref-oeffentlichkeit', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'felix.weber',  orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'felix.weber',  orgUnitKey: 'ref-soziales',    membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'greta.koch',   orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'hannes.bauer', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ida.richter',  orgUnitKey: 'ref-finanzen',    membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'jonas.klein',  orgUnitKey: 'ag-nachhaltigkeit', membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'klara.wolf',   orgUnitKey: 'ag-nachhaltigkeit', membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'lena.neumann', orgUnitKey: 'studierendenrat', membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'lena.neumann', orgUnitKey: 'ref-soziales',    membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'tobias.krause',orgUnitKey: 'it-team',         membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    // dev.admin is the all-access development superuser: the central-finance actor
    // for the seeded finance fixtures (master spec §6, Task 21) AND a member of
    // every org-unit so it can act everywhere. Its Keycloak group membership
    // (every realm group) is granted separately in seed.ts → seedDevAdminGroups.
    { userKey: 'dev.admin',    orgUnitKey: 'studierendenrat',     membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'vorstand',            membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'it-team',             membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-finanzen',        membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-hochschulpolitik',membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ag-nachhaltigkeit',   membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-oeffentlichkeit', membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-soziales',        membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'fs-informatik',       membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'fs-maschinenbau',     membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ini-kulturcafe',      membershipType: 'employee', termStart: APPOINTED_START, termEnd: null }
  ],
  assignments: [
    { roleKey: 'vorsitz',           userKey: 'anna.berger',   startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'stellv-vorsitz',    userKey: 'ben.hoffmann',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'finanzvorstand',    userKey: 'clara.wagner',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-finanzen', userKey: 'clara.wagner',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-hopo',     userKey: 'david.schulz',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-oeffi',    userKey: 'emma.fischer',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-soziales', userKey: 'felix.weber',   startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'it-verantwortung',  userKey: 'tobias.krause', startDate: APPOINTED_START, endDate: APPOINTED_END }
  ]
}
