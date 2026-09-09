import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import OrgDetailPanel from './OrgDetailPanel.svelte'
import TermMapPanel from './TermMapPanel.svelte'
import type { TreeNodeDTO } from '../../../routes/committees/+page.server'

// Matcher posture mirrors Sidebar.test.ts / FintsBanner.test.ts: getByText /
// querySelector are the assertions (jest-dom's custom matchers don't register
// cleanly under the browser resolve condition this repo needs for mounting).

const node = (overrides: Partial<TreeNodeDTO> = {}): TreeNodeDTO => ({
  id: 'ou-1',
  label: 'Stadtrat',
  abbr: 'SR',
  hue: 200,
  desc: '',
  kind: 'committee',
  kind_friendly: 'Gremium',
  childTerm: null,
  wantsRoom: false,
  wantsFiles: false,
  memberCount: 5,
  rollupCount: 5,
  budget: 0,
  authority: 'deciding',
  children: [],
  ...overrides,
})

describe('OrgDetailPanel — authority badge (#289)', () => {
  test("renders the full 'Beschließend' label for a deciding unit", () => {
    const { getByText } = render(OrgDetailPanel, {
      props: { node: node({ authority: 'deciding' }), isAdmin: false },
    })
    expect(getByText('Beschließend')).toBeTruthy()
  })

  test("renders the full 'Beratend' label for an advisory unit", () => {
    const { getByText } = render(OrgDetailPanel, {
      props: { node: node({ authority: 'advisory' }), isAdmin: false },
    })
    expect(getByText('Beratend')).toBeTruthy()
  })

  test('renders an honest disabled/empty caucus composition state (no fabricated seats)', () => {
    // D6 (design v11): the panel is GATED on the tenant term map — it renders
    // only when the tenant defines the 'fraktionen' term (which doubles as the
    // heading). Still no fabricated seats: present but disabled/empty.
    const { container, getByText } = render(OrgDetailPanel, {
      props: { node: node(), isAdmin: false, terms: { fraktionen: 'Fraktionszusammensetzung' } },
    })
    // The composition block is present but in a disabled/empty state.
    expect(container.querySelector('.caucus-composition')).toBeTruthy()
    expect(container.querySelector('.caucus-composition.disabled')).toBeTruthy()
    expect(getByText('Fraktionszusammensetzung')).toBeTruthy()
  })

  test("renders NO caucus panel for a tenant without the 'fraktionen' term (D6)", () => {
    // StuRa tenant #1 defines no caucus term — kommunales Vokabular must not
    // leak into caucus-less tenants.
    const { container } = render(OrgDetailPanel, {
      props: { node: node(), isAdmin: false },
    })
    expect(container.querySelector('.caucus-composition')).toBeNull()
  })
})

describe('TermMapPanel — Begriffe dieser Instanz (#289)', () => {
  test('renders a row showing the overridden label for a configured tenant', () => {
    const { getByText } = render(TermMapPanel, {
      props: { terms: { 'role.member': 'Ratsmitglied' } },
    })
    expect(getByText('Ratsmitglied')).toBeTruthy()
  })

  test('renders nothing when terms is undefined', () => {
    const { container } = render(TermMapPanel, { props: { terms: undefined } })
    expect(container.querySelector('.term-map')).toBeNull()
  })

  test('renders nothing when terms is empty', () => {
    const { container } = render(TermMapPanel, { props: { terms: {} } })
    expect(container.querySelector('.term-map')).toBeNull()
  })
})
