import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte'
import AttendanceSection from './AttendanceSection.svelte'

// Finding 3 (E2E 2026-11-11): the quorum line ("Nicht beschlussfähig") only
// changed after a reload. The section owns the chips and the quorum pill, so a
// saved click must move both; a failed save must move neither.

const voting = () => [
  { user_id: 'u-1', status: 'present' as const, displayName: 'Anna Beispiel' },
  { user_id: 'u-2', status: 'present' as const, displayName: 'Ben Muster' },
  { user_id: 'u-3', status: 'absent' as const, displayName: 'Cora Probe' },
]
const advisory = () => [
  { user_id: 'u-9', status: 'absent' as const, displayName: 'Dora Gast' },
]

function stubFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = () => ({ attendance: voting(), advisoryAttendance: advisory(), isAdmin: true, protocolId: 'p-1' })

describe('AttendanceSection', () => {
  test('renders the quorum line from the roster', () => {
    const { getByText } = render(AttendanceSection, { props: props() })
    expect(getByText('Beschlussfähig 2/3')).toBeTruthy()
  })

  test('a 200 on a present member updates chip and quorum line without a reload', async () => {
    stubFetch(200)
    const { getByRole, getByText, queryByText } = render(AttendanceSection, { props: props() })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => expect(getByRole('button', { name: 'Anna Beispiel: abwesend' })).toBeTruthy())
    expect(getByText('Nicht beschlussfähig')).toBeTruthy()
    expect(queryByText('Beschlussfähig 2/3')).toBeNull()
  })

  test('a 200 on an excused member makes the meeting quorate again', async () => {
    stubFetch(200)
    const { getByRole, getByText } = render(AttendanceSection, {
      props: {
        ...props(),
        attendance: [
          { user_id: 'u-1', status: 'present', displayName: 'Anna Beispiel' },
          { user_id: 'u-2', status: 'excused', displayName: 'Ben Muster' },
          { user_id: 'u-3', status: 'absent', displayName: 'Cora Probe' },
        ],
      },
    })
    expect(getByText('Nicht beschlussfähig')).toBeTruthy()
    // excused -> present
    await fireEvent.click(getByRole('button', { name: 'Ben Muster: entschuldigt' }))
    await waitFor(() => expect(getByRole('button', { name: 'Ben Muster: anwesend' })).toBeTruthy())
    expect(getByText('Beschlussfähig 2/3')).toBeTruthy()
  })

  test('a 500 changes neither the chip nor the quorum line and shows the error', async () => {
    stubFetch(500)
    const { getByRole, getByText, queryByText } = render(AttendanceSection, { props: props() })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/nicht gespeichert/))
    expect(getByRole('button', { name: 'Anna Beispiel: anwesend' })).toBeTruthy()
    expect(getByText('Beschlussfähig 2/3')).toBeTruthy()
    expect(queryByText('Nicht beschlussfähig')).toBeNull()
  })

  test('advisory members never count toward the quorum', async () => {
    stubFetch(200)
    const { getByRole, getByText } = render(AttendanceSection, { props: props() })
    await fireEvent.click(getByRole('button', { name: 'Dora Gast: abwesend' }))
    await waitFor(() => expect(getByRole('button', { name: 'Dora Gast: entschuldigt' })).toBeTruthy())
    await fireEvent.click(getByRole('button', { name: 'Dora Gast: entschuldigt' }))
    await waitFor(() => expect(getByRole('button', { name: 'Dora Gast: anwesend' })).toBeTruthy())
    expect(getByText('Beschlussfähig 2/3')).toBeTruthy()
  })

  test('an empty voting roster is not quorate', () => {
    const { getByText } = render(AttendanceSection, {
      props: { ...props(), attendance: [], advisoryAttendance: [] },
    })
    expect(getByText('Nicht beschlussfähig')).toBeTruthy()
  })
})
