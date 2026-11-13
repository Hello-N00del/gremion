// German count labels on the dashboard head and KPI row: the singular for exactly one
// ("1 Termin", "1 Abstimmung läuft", "neue Nachricht"), never "1 Termine" / "1 Abstimmungen laufen".
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import PageHead from './PageHead.svelte'
import KpiRow from './KpiRow.svelte'

function head(over: Partial<{ myEventCount: number; liveVotesCount: number; approvalsCount: number; isMember: boolean }>) {
  const { container } = render(PageHead, {
    props: {
      nextMeeting: null,
      firstName: 'Alex',
      isMember: true,
      financeEnabled: true,
      approvalsCount: 0,
      liveVotesCount: 0,
      myEventCount: 0,
      gremienPlural: 'Gremien',
      newExpenseHref: null,
      ...over,
    },
  })
  return container.querySelector('.page-sub')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function kpiDeltas(unreadCount: number, isMember = true) {
  const { container } = render(KpiRow, {
    props: {
      isMember,
      financeEnabled: true,
      upcomingCount: 0,
      myEventCount: 0,
      liveVotesCount: 0,
      unreadCount,
      approvalsCount: 0,
      budgetSummary: null,
      gremienPlural: 'Gremien',
    },
  })
  return Array.from(container.querySelectorAll('.delta')).map((d) => d.textContent?.trim())
}

describe('dashboard head counts', () => {
  it('reads "1 Termin ... 1 Abstimmung läuft" for one of each', () => {
    expect(head({ myEventCount: 1, liveVotesCount: 1 })).toMatch(/^1 Termin in .* · 1 Abstimmung läuft\.$/)
  })

  it('reads the plural for several and for none', () => {
    expect(head({ myEventCount: 3, liveVotesCount: 2 })).toMatch(/^3 Termine in .* · 2 Abstimmungen laufen\.$/)
    expect(head({ myEventCount: 0, liveVotesCount: 0 })).toMatch(/^0 Termine in .* · 0 Abstimmungen laufen\.$/)
  })

  it('reads "1 Antrag wartet" for a single approval, "2 Anträge warten" for two', () => {
    expect(head({ isMember: false, approvalsCount: 1, liveVotesCount: 1 })).toBe(
      '1 Antrag wartet auf Freigabe · 1 Abstimmung läuft.',
    )
    expect(head({ isMember: false, approvalsCount: 2, liveVotesCount: 2 })).toBe(
      '2 Anträge warten auf Freigabe · 2 Abstimmungen laufen.',
    )
  })
})

describe('dashboard KPI unread label', () => {
  it('reads "neue Nachricht" for one unread message', () => {
    expect(kpiDeltas(1)).toContain('neue Nachricht')
  })

  it('reads "neue Nachrichten" for several and "alles gelesen" for none', () => {
    expect(kpiDeltas(4)).toContain('neue Nachrichten')
    expect(kpiDeltas(0)).toContain('alles gelesen')
  })
})
