// test/f1-defect/guards/committees-no-manage-link.test.ts
//
// Ported from TASK-008's StuRaOS integration worktree (same file name,
// t009-int:test/f1-defect/guards/committees-no-manage-link.test.ts) into the
// kernel civitas repo — TASK-009 k2, item 2. The kernel component under test
// IS the same OrgDetailPanel.svelte (the product carries it unmodified from
// here), so no path adaptation was needed beyond the relative depth from
// this repo's own test/f1-defect/guards/ to its own gremion-ui/.
//
// G1 guard (seat/committee mutation surface undiscoverable from
// /committees). The kernel's own fix landed at 715c829 (Verwalten link) +
// 008372e (its aria-label) — BEFORE either commit this guard's admin case is
// RED (no anchor to /members/committees/{id} exists at any isAdmin value);
// AFTER, it is GREEN. See this directory's README.md for how that was
// proven for a scratch, pre-fix copy of OrgDetailPanel.svelte.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import OrgDetailPanel from '../../../gremion-ui/src/lib/components/committee/OrgDetailPanel.svelte'
import type { TreeNodeDTO } from '../../../gremion-ui/src/routes/committees/+page.server'

const node: TreeNodeDTO = {
  id: 'committee-1',
  label: 'Referat Finanzen',
  abbr: 'RF',
  hue: 0,
  desc: '',
  kind: 'referat',
  kind_friendly: 'Referat',
  childTerm: null,
  wantsRoom: true,
  wantsFiles: true,
  memberCount: 3,
  rollupCount: 3,
  budget: 0,
  authority: 'deciding',
  children: [],
}

describe('OrgDetailPanel — seat-management link discoverability for admins (G1 guard, ported)', () => {
  it('renders a link to the real per-committee admin route (/members/committees/{id}) when isAdmin', () => {
    const { container } = render(OrgDetailPanel, { props: { node, isAdmin: true } })

    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    const expectedHref = `/members/committees/${node.id}`

    expect(links, `rendered anchors: ${JSON.stringify(links)}`).toContain(expectedHref)
  })

  it('renders NO such link when isAdmin is false (no privilege leak in the DOM)', () => {
    const { container } = render(OrgDetailPanel, { props: { node, isAdmin: false } })
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(links).not.toContain(`/members/committees/${node.id}`)
  })
})
