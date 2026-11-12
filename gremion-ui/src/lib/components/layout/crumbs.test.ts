// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { crumbsFor } from './crumbs'

const UUID = '0b0f6c1e-6d0a-4f0e-9a43-0f7f6f1f2a10'

describe('crumbsFor: the section names in the top bar', () => {
  it('names route folders in German', () => {
    expect(crumbsFor({ pathname: '/tasks', routeId: '/tasks' })).toEqual(['Aufgaben'])
    expect(crumbsFor({ pathname: '/content/lists', routeId: '/content/lists' })).toEqual(['Inhalte', 'Verteilerlisten'])
    expect(crumbsFor({ pathname: '/systemstatus', routeId: '/systemstatus' })).toEqual(['Systemstatus'])
  })

  it('never shows the raw id of a page that names nothing itself', () => {
    expect(crumbsFor({ pathname: '/polls/1', routeId: '/polls/[id]', params: { id: '1' } })).toEqual(['Umfragen'])
    expect(
      crumbsFor({ pathname: `/content/${UUID}/edit`, routeId: '/content/[id]/edit', params: { id: UUID } }),
    ).toEqual(['Inhalte', 'Bearbeiten'])
    expect(
      crumbsFor({
        pathname: `/members/committees/${UUID}/protokolle/42`,
        routeId: '/members/committees/[id]/protokolle/[protocolId]',
        params: { id: UUID, protocolId: '42' },
      }),
    ).toEqual(['Mitglieder', 'Gremien', 'Protokolle'])
  })

  it('shows the name a page supplies for its id, and drops a segment set to null', () => {
    expect(
      crumbsFor({
        pathname: `/members/committees/${UUID}/protokolle/42`,
        routeId: '/members/committees/[id]/protokolle/[protocolId]',
        params: { id: UUID, protocolId: '42' },
        overrides: { committees: null, [UUID]: 'Finanzausschuss', '42': 'Sitzung vom 3. Mai' },
      }),
    ).toEqual(['Mitglieder', 'Finanzausschuss', 'Protokolle', 'Sitzung vom 3. Mai'])
  })

  it('keeps the label of a parameter that is a known section', () => {
    expect(
      crumbsFor({ pathname: '/settings/loeschfristen', routeId: '/settings/[section]', params: { section: 'loeschfristen' } }),
    ).toEqual(['Einstellungen', 'Löschfristen'])
  })

  it('keeps folder names of a rest parameter, decoded', () => {
    expect(
      crumbsFor({
        pathname: '/files/Sitzungen%202026/Mai',
        routeId: '/files/[...path]',
        params: { path: 'Sitzungen 2026/Mai' },
      }),
    ).toEqual(['Dokumente', 'Sitzungen 2026', 'Mai'])
    // One folder deep the value has no slash; it is still a folder name, not an id.
    expect(crumbsFor({ pathname: '/files/Mai', routeId: '/files/[...path]', params: { path: 'Mai' } })).toEqual([
      'Dokumente',
      'Mai',
    ])
  })

  it('drops an id that needs URL encoding', () => {
    expect(
      crumbsFor({ pathname: '/files/groups/a%20b', routeId: '/files/groups/[group]', params: { group: 'a b' } }),
    ).toEqual(['Dokumente', 'Gruppen'])
  })

  it('re-terms the committees folder per tenant', () => {
    expect(crumbsFor({ pathname: '/committees', routeId: '/committees', terms: { gremien: 'Ausschüsse' } })).toEqual([
      'Ausschüsse',
    ])
    expect(crumbsFor({ pathname: '/committees', routeId: '/committees' })).toEqual(['Gremien'])
  })

  it('does not throw on a malformed escape and shows an unmatched path as typed', () => {
    expect(crumbsFor({ pathname: '/nirgendwo/%E0%A4%A', routeId: null })).toEqual(['nirgendwo', '%E0%A4%A'])
  })
})
