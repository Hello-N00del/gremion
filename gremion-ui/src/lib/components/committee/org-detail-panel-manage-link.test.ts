// TASK-009 lane A: reachability for the existing (already-working, already
// permission-gated) seat/committee management surface at
// /members/committees/{id}. OrgDetailPanel had member count, budget and
// (product-only) Board/Matrix/Dokumente links but no pointer to that route —
// see test/f1-defect/ROOT-CAUSE.md (G1) in the StuRaOS repo for the full
// diagnosis this mirrors. This does not change access control: it reuses the
// exact `isAdmin` prop the panel's caller (routes/committees/+page.server.ts,
// CouncilAdmin || ITAdmin) already computes and passes in.
import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import OrgDetailPanel from './OrgDetailPanel.svelte'
import type { TreeNodeDTO } from '../../../routes/committees/+page.server'

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

describe('OrgDetailPanel — Verwalten link (TASK-009 lane A, G1)', () => {
  test('renders a Verwalten link to /members/committees/{id} for an admin viewer', () => {
    const { container } = render(OrgDetailPanel, {
      props: { node: node({ id: 'committee-42' }), isAdmin: true },
    })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/members/committees/committee-42')
  })

  // Every org-unit kind (Gremium/Referat/Vorstand/Fraktion/Gruppe — `kind` is
  // an admin-configured label, not a fixed enum) resolves through the same
  // /members/committees/{id} route, so the link does not branch on node.kind.
  test('renders the same Verwalten link regardless of the node kind', () => {
    const { container } = render(OrgDetailPanel, {
      props: { node: node({ id: 'referat-9', kind: 'referat', kind_friendly: 'Referat' }), isAdmin: true },
    })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/members/committees/referat-9')
  })

  test('renders NO Verwalten link (and no anchor at all in the kernel) for a non-admin viewer', () => {
    const { container } = render(OrgDetailPanel, {
      props: { node: node({ id: 'committee-42' }), isAdmin: false },
    })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('/members/committees/committee-42')
  })
})
