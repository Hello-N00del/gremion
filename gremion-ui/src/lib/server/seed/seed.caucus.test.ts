// P2.2-data (#202) Task 8: pure SQL-row shaping for the caucus seeder.
// DB inserts themselves are integration territory (deferred post-#249);
// these tests pin the resolution/throw behavior of caucusRowsFromBlueprint.
import { describe, it, expect } from 'vitest'
import { caucusRowsFromBlueprint } from './seed'
import { STURA_BLUEPRINT } from './org-blueprint'
import type { GremionBlueprint } from './org-blueprint'

const orgUnitIdByKey = new Map([
  ['gemeinderat', 'ou-council-1'],
  ['ortschaftsrat-a', 'ou-council-2'],
])
const userIdByKey = new Map([
  ['councillor1', 'kc-user-1'],
  ['councillor2', 'kc-user-2'],
])

const caucusSection: Pick<GremionBlueprint, 'caucuses'> = {
  caucuses: {
    caucuses: [
      {
        key: 'spd', councilOrgUnitKey: 'gemeinderat', name: 'SPD-Fraktion', color: '#e3000f',
        members: [
          { userKey: 'councillor1', termStart: '2026-01-01', termEnd: '2031-12-31' },
          { userKey: 'councillor2' },
        ],
      },
      { key: 'gruene', councilOrgUnitKey: 'gemeinderat', name: 'Grüne Fraktion', members: [] },
    ],
  },
}

describe('caucusRowsFromBlueprint', () => {
  it('returns empty row sets when the blueprint has no caucuses section', () => {
    expect(caucusRowsFromBlueprint({}, orgUnitIdByKey, userIdByKey))
      .toEqual({ caucus: [], memberships: [] })
  })

  it('returns empty row sets for STURA_BLUEPRINT (tenant #1 seeds zero caucuses)', () => {
    expect(caucusRowsFromBlueprint(STURA_BLUEPRINT, orgUnitIdByKey, userIdByKey))
      .toEqual({ caucus: [], memberships: [] })
  })

  it('resolves council org-unit ids onto caucus rows (color defaults to null)', () => {
    const { caucus } = caucusRowsFromBlueprint(caucusSection, orgUnitIdByKey, userIdByKey)
    expect(caucus).toEqual([
      { key: 'spd', councilOrgUnitId: 'ou-council-1', name: 'SPD-Fraktion', color: '#e3000f' },
      { key: 'gruene', councilOrgUnitId: 'ou-council-1', name: 'Grüne Fraktion', color: null },
    ])
  })

  it('resolves membership rows with the denormalized council id (D-CD) and null term defaults', () => {
    const { memberships } = caucusRowsFromBlueprint(caucusSection, orgUnitIdByKey, userIdByKey)
    expect(memberships).toEqual([
      { caucusKey: 'spd', councilOrgUnitId: 'ou-council-1', userKeycloakId: 'kc-user-1',
        termStart: '2026-01-01', termEnd: '2031-12-31' },
      { caucusKey: 'spd', councilOrgUnitId: 'ou-council-1', userKeycloakId: 'kc-user-2',
        termStart: null, termEnd: null },
    ])
  })

  it('throws on an unresolvable councilOrgUnitKey', () => {
    const bp: Pick<GremionBlueprint, 'caucuses'> = {
      caucuses: { caucuses: [{ key: 'x', councilOrgUnitKey: 'missing', name: 'X', members: [] }] },
    }
    expect(() => caucusRowsFromBlueprint(bp, orgUnitIdByKey, userIdByKey))
      .toThrow(/caucusRowsFromBlueprint: unknown orgUnitKey "missing"/)
  })

  it('throws on an unresolvable member userKey', () => {
    const bp: Pick<GremionBlueprint, 'caucuses'> = {
      caucuses: {
        caucuses: [{
          key: 'x', councilOrgUnitKey: 'gemeinderat', name: 'X',
          members: [{ userKey: 'ghost' }],
        }],
      },
    }
    expect(() => caucusRowsFromBlueprint(bp, orgUnitIdByKey, userIdByKey))
      .toThrow(/caucusRowsFromBlueprint: unknown userKey "ghost"/)
  })
})
