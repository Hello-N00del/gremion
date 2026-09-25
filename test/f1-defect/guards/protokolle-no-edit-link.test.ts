// test/f1-defect/guards/protokolle-no-edit-link.test.ts
//
// Ported from TASK-008's StuRaOS integration worktree
// (t009-int:test/f1-defect/guards/protocols-no-edit-link.test.ts) into the
// kernel civitas repo — TASK-009 k2, item 2. Path adaptation: the kernel's
// route is /protokolle, not /protocols (the German URL segment the kernel
// never renamed — see gremion-ui's own
// refactor(routes): standardise the app's German URL segments to English,
// c71fc29a, which only touched the product tree); this file therefore
// renders gremion-ui/src/routes/protokolle/+page.svelte, the kernel's own
// aggregate list, not the product's routes/protocols/+page.svelte.
//
// P1 guard (protocol edit surface undiscoverable from /protokolle). The
// kernel's own fix landed at TASK-009 k2 item 1 (this same session, commit
// 7724fe9): BEFORE that commit this guard's admin case is RED (no anchor to
// the per-committee editor exists at any isAdmin value, and data.isAdmin is
// not even computed by the loader); AFTER, it is GREEN. See this
// directory's README.md for how that was proven for a scratch, pre-fix
// copy of +page.server.ts/+page.svelte. The aria-label assertion is
// kernel-specific (the product fix, c33778d6, does not carry one) — see
// item 1's commit message for why the kernel closes that gap at first fix.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import ProtokollePage from '../../../gremion-ui/src/routes/protokolle/+page.svelte'

const draftRow = {
  id: 'protocol-1',
  committeeId: 'committee-1',
  committeeName: 'Referat Finanzen',
  status: 'draft' as const,
  title: 'Ref. Finanzen Nr. 12',
  meetingDate: '2026-09-11',
  tops: 3,
  attended: 3,
  total: 3,
}

describe('/protokolle — edit-route discoverability for admins (P1 guard, ported)', () => {
  it('renders a link to the real nested editor for a draft protocol, with an aria-label naming it, when isAdmin', () => {
    const data = { protocols: [draftRow], isAdmin: true } as never

    const { container } = render(ProtokollePage, { props: { data } })
    const anchors = Array.from(container.querySelectorAll('a'))
    const hrefs = anchors.map((a) => a.getAttribute('href'))
    const expectedHref = `/members/committees/${draftRow.committeeId}/protokolle/${draftRow.id}`

    expect(hrefs, `rendered anchors: ${JSON.stringify(hrefs)}`).toContain(expectedHref)
    const link = anchors.find((a) => a.getAttribute('href') === expectedHref)
    expect(link?.getAttribute('aria-label')).toBe(`Bearbeiten — ${draftRow.title}`)
  })

  it('renders NO such link when isAdmin is false (no privilege leak in the DOM)', () => {
    const data = { protocols: [draftRow], isAdmin: false } as never
    const { container } = render(ProtokollePage, { props: { data } })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain(`/members/committees/${draftRow.committeeId}/protokolle/${draftRow.id}`)
  })
})
