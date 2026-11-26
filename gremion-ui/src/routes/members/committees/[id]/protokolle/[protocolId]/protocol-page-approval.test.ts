// The protocol page and the two-person publish: the person who submitted sees that a second
// person has to approve and gets no publish button; an eligible second person sees
// "Freigeben und veröffentlichen"; a body without a second approver says so plainly; the
// record of who submitted and who approved is shown. The page only reflects what the load
// computed (the publish route decides).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'

const viewer = vi.hoisted(() => ({ roles: ['council-admin'] as string[] }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: readable({
      url: new URL('http://localhost/members/committees/c1/protokolle/p1'),
      get data() {
        return { user: { id: 'viewer', roles: viewer.roles } }
      },
    }),
  }
})
vi.mock('$app/state', () => ({ page: { data: {} } }))

import Page from './+page.svelte'

type Approval = {
  canApprove: boolean
  refusal: 'submitter' | 'author' | 'not-eligible' | null
  otherEligibleCount: number | null
  submitted: { name: string; at: string } | null
  approved: { name: string; at: string } | null
}

const data = (status: 'submitted' | 'published', approval: Approval) => ({
  protocol: {
    id: 'p1', committee_id: 'c1', title: 'Sitzung', meeting_date: '2026-06-21', location: null, status,
    guest_edit_enabled: false, body_html: '<p>Text</p>', hasDraftDocument: false,
  },
  attendance: [],
  advisoryAttendance: [],
  quorum: { eligibleVotingCount: 3, presentVotingCount: 2, quorate: true },
  resolutions: [],
  actionItems: [],
  wopiToken: null,
  approval,
  pendingApprovals: [],
  committee: { id: 'c1', name: 'Finanzausschuss' },
  committeeId: 'c1',
})

const submittedBy = { name: 'Anna Beispiel', at: '2026-06-22T08:30:00.000Z' }

afterEach(() => {
  viewer.roles = ['council-admin']
})

describe('protocol page: publishing needs a second person', () => {
  it('shows the submitter that a second person has to approve, with no publish button', () => {
    render(Page, {
      props: {
        data: data('submitted', {
          canApprove: false, refusal: 'submitter', otherEligibleCount: 2, submitted: submittedBy, approved: null,
        }) as never,
      },
    })
    expect(screen.getByText('Wartet auf Freigabe durch eine zweite Person')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Freigeben und veröffentlichen' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Veröffentlichen' })).toBeNull()
    expect(screen.queryByTestId('no-second-approver')).toBeNull()
  })

  it('offers an eligible second person "Freigeben und veröffentlichen"', () => {
    render(Page, {
      props: {
        data: data('submitted', {
          canApprove: true, refusal: null, otherEligibleCount: 1, submitted: submittedBy, approved: null,
        }) as never,
      },
    })
    expect(screen.getByRole('button', { name: 'Freigeben und veröffentlichen' })).toBeTruthy()
    expect(screen.queryByText('Wartet auf Freigabe durch eine zweite Person')).toBeNull()
  })

  it('offers a voting member who is not an admin the approval button too', () => {
    viewer.roles = ['member']
    render(Page, {
      props: {
        data: data('submitted', {
          canApprove: true, refusal: null, otherEligibleCount: 1, submitted: submittedBy, approved: null,
        }) as never,
      },
    })
    expect(screen.getByRole('button', { name: 'Freigeben und veröffentlichen' })).toBeTruthy()
  })

  it('says plainly that a body with a single eligible person cannot publish', () => {
    render(Page, {
      props: {
        data: data('submitted', {
          canApprove: false, refusal: 'submitter', otherEligibleCount: 0, submitted: submittedBy, approved: null,
        }) as never,
      },
    })
    expect(screen.getByTestId('no-second-approver').textContent).toMatch(/keine zweite Person/)
    expect(screen.queryByRole('button', { name: /veröffentlichen/i })).toBeNull()
  })

  it('shows who submitted and who approved on the published minutes', () => {
    render(Page, {
      props: {
        data: data('published', {
          canApprove: false, refusal: null, otherEligibleCount: null, submitted: submittedBy,
          approved: { name: 'Ben Muster', at: '2026-06-23T10:15:00.000Z' },
        }) as never,
      },
    })
    const record = screen.getByTestId('approval-record').textContent ?? ''
    expect(record).toContain('Eingereicht von')
    expect(record).toContain('Anna Beispiel')
    expect(record).toContain('Freigegeben und veröffentlicht von')
    expect(record).toContain('Ben Muster')
    expect(screen.queryByText('Wartet auf Freigabe durch eine zweite Person')).toBeNull()
  })

  it('shows no record for minutes published before the two people were recorded', () => {
    render(Page, {
      props: {
        data: data('published', {
          canApprove: false, refusal: null, otherEligibleCount: null, submitted: null, approved: null,
        }) as never,
      },
    })
    expect(screen.queryByTestId('approval-record')).toBeNull()
  })
})
