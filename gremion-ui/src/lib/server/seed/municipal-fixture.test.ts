// P2.2-data (#202) Task 7 — THE meta-plan §6-P2.2 acceptance test.
// A municipal-council (Gemeinderat) blueprint with its own org schema —
// multi-root (Gemeinderat + Verwaltung + Ortschaftsräte as ROOT SIBLINGS),
// Ausschüsse with an advisory authority, three Fraktionen (caucuses), and a
// non-voting sachkundiger Bürger — must pass BOTH validation layers through
// the same `parseBlueprintDocument` code path the StuRa tenant uses, while
// STURA_BLUEPRINT keeps validating against GREMION_ORG_SCHEMA unchanged.
import { describe, it, expect } from 'vitest'
import { parseBlueprintDocument } from './blueprint-schema'
import { validateBlueprint, STURA_BLUEPRINT, type GremionBlueprint } from './org-blueprint'
import { GREMION_ORG_SCHEMA, orgSchemaFromBlueprint } from '../governance/org-schema'

function municipalBlueprint(): GremionBlueprint {
  return {
    schema_version: 1,
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
      { username: 'sk.buerger',  firstName: 'Sven',  lastName: 'Kundig', email: 'sk.buerger@gemeinde.example',  realmRole: 'member' }
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
        voting: false }
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
    // Carve note: no finance section — the finance feature module is not part of
    // the governance-only kernel, so GremionBlueprint no longer carries `finance`.
  }
}

describe('municipal blueprint fixture (meta-plan §6-P2.2 acceptance)', () => {
  it('passes BOTH validation layers via parseBlueprintDocument', () => {
    const result = parseBlueprintDocument(municipalBlueprint())
    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('has zero integrity errors against its OWN org schema', () => {
    const bp = municipalBlueprint()
    expect(validateBlueprint(bp, orgSchemaFromBlueprint(bp.orgSchema!))).toEqual([])
  })

  it('is genuinely multi-root: 4 root siblings across 3 kinds', () => {
    const roots = municipalBlueprint().orgUnits.filter((o) => o.parentKey === null)
    expect(roots).toHaveLength(4)
    expect(new Set(roots.map((o) => o.kind)))
      .toEqual(new Set(['council', 'administration', 'district_council']))
  })

  it('exercises the §3.5(d) flags: one advisory Ausschuss + one non-voting membership', () => {
    const bp = municipalBlueprint()
    expect(bp.orgUnits.filter((o) => o.authority === 'advisory')).toHaveLength(1)
    expect(bp.memberships.filter((m) => m.voting === false)).toHaveLength(1)
  })

  it('puts councillor1 in exactly ONE Fraktion and ≥2 Ausschuss memberships', () => {
    const bp = municipalBlueprint()
    const fraktionen = bp.caucuses!.caucuses.filter((c) =>
      c.members.some((m) => m.userKey === 'councillor1'))
    expect(fraktionen).toHaveLength(1)
    const committeeKeys = new Set(
      bp.orgUnits.filter((o) => o.kind === 'committee').map((o) => o.key))
    const committeeMemberships = bp.memberships.filter(
      (m) => m.userKey === 'councillor1' && committeeKeys.has(m.orgUnitKey))
    expect(committeeMemberships.length).toBeGreaterThanOrEqual(2)
  })

  it('does not regress tenant #1: STURA_BLUEPRINT validates through the SAME code path', () => {
    const result = parseBlueprintDocument(STURA_BLUEPRINT)
    expect(result.ok ? [] : result.errors).toEqual([])
    expect(result.ok).toBe(true)
    // and directly against the default catalog (layer 2 alone)
    expect(validateBlueprint(STURA_BLUEPRINT, GREMION_ORG_SCHEMA)).toEqual([])
  })
})
