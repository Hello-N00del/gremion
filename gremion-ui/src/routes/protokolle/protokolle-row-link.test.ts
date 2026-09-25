// TASK-009 kernel lane (F1 drift): each /protokolle row must link straight to
// the kernel's own, already-working per-committee editor at
// /members/committees/{committeeId}/protokolle/{id} — 'Bearbeiten' for a
// draft, 'Öffnen' otherwise — gated on data.isAdmin (the exact permission the
// target editor enforces for writes; see +page.server.ts). Unlike the
// product fix (c33778d6), the kernel row link also carries an aria-label
// naming the protocol: "Bearbeiten"/"Öffnen" repeats verbatim across every
// row, the same ambiguity-for-screen-reader-users problem OrgDetailPanel's
// "Verwalten" link had before 008372e — this closes it at first fix rather
// than as a follow-up round.
import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Page from './+page.svelte'

function protocol(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'protocol-1',
    title: 'Ref. Finanzen Nr. 12',
    meetingDate: '2026-05-01',
    status: 'draft',
    committeeId: 'committee-1',
    committeeName: 'Ref. Finanzen',
    attended: 3,
    total: 5,
    tops: 2,
    ...over,
  }
}

// The page only reads data.protocols / data.isAdmin — same relaxed-prop
// convention as the product's protocols-row-link.test.ts.
function mount(data: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Page, { props: { data } as any })
}

describe('/protokolle row — editor-link discoverability (kernel F1 drift)', () => {
  test('links a draft row to the editor with "Bearbeiten" + an aria-label naming the protocol, when isAdmin', () => {
    const { container, getByText } = mount({
      protocols: [protocol({ status: 'draft', title: 'Ref. Finanzen Nr. 12' })],
      isAdmin: true,
    })
    const anchors = Array.from(container.querySelectorAll('a'))
    const hrefs = anchors.map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/members/committees/committee-1/protokolle/protocol-1')
    const link = getByText('Bearbeiten')
    expect(link.getAttribute('aria-label')).toBe('Bearbeiten — Ref. Finanzen Nr. 12')
  })

  test('links a published row to the editor with "Öffnen" + an aria-label naming the protocol, when isAdmin', () => {
    const { container, getByText } = mount({
      protocols: [protocol({ status: 'published', id: 'protocol-2', title: 'Ref. Finanzen Nr. 13' })],
      isAdmin: true,
    })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/members/committees/committee-1/protokolle/protocol-2')
    const link = getByText('Öffnen')
    expect(link.getAttribute('aria-label')).toBe('Öffnen — Ref. Finanzen Nr. 13')
  })

  test('renders no editor link (and no anchor at all) for a non-admin viewer', () => {
    const { container, queryByText } = mount({ protocols: [protocol()], isAdmin: false })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('/members/committees/committee-1/protokolle/protocol-1')
    expect(queryByText('Bearbeiten')).toBeNull()
    expect(queryByText('Öffnen')).toBeNull()
  })
})
