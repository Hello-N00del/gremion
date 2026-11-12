import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte'
import AttendanceChips from './AttendanceChips.svelte'

// Finding 3 (E2E 2026-11-11): the server saved each click but the chip only
// changed after a reload, and the accessible label was English. The chip must
// track the persisted state: flip after a 200, stay put and show the error
// after a failure.

const entries = () => [
  { user_id: 'u-1', status: 'present' as const, displayName: 'Anna Beispiel' },
  { user_id: 'u-2', status: 'absent' as const, displayName: 'Ben Muster' },
]

function stubFetch(status: number) {
  const fn = vi.fn(async () => new Response('{}', { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AttendanceChips', () => {
  test('labels are German, including the aria-label', () => {
    const { getByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    expect(getByRole('button', { name: 'Anna Beispiel: anwesend' })).toBeTruthy()
    expect(getByRole('button', { name: 'Ben Muster: abwesend' })).toBeTruthy()
  })

  test('a 200 flips the chip to the new status without a reload', async () => {
    const fetchMock = stubFetch(200)
    const { getByRole, queryByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => expect(getByRole('button', { name: 'Anna Beispiel: abwesend' })).toBeTruthy())
    expect(queryByRole('button', { name: 'Anna Beispiel: anwesend' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/protocols/p-1')
    expect(JSON.parse(init.body as string)).toEqual({
      attendanceUpdate: { userId: 'u-1', status: 'absent' },
    })
  })

  test('repeated clicks cycle anwesend, abwesend, entschuldigt, anwesend', async () => {
    stubFetch(200)
    const { getByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    for (const next of ['abwesend', 'entschuldigt', 'anwesend']) {
      const chip = getByRole('button', { name: /^Anna Beispiel:/ })
      await fireEvent.click(chip)
      await waitFor(() => expect(getByRole('button', { name: `Anna Beispiel: ${next}` })).toBeTruthy())
    }
  })

  test('a 500 keeps the old status and shows the error', async () => {
    stubFetch(500)
    const { getByRole, queryByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/nicht gespeichert/))
    expect(getByRole('button', { name: 'Anna Beispiel: anwesend' })).toBeTruthy()
    expect(queryByRole('button', { name: 'Anna Beispiel: abwesend' })).toBeNull()
  })

  test('a network failure keeps the old status and shows the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const { getByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    await waitFor(() => expect(getByRole('alert')).toBeTruthy())
    expect(getByRole('button', { name: 'Anna Beispiel: anwesend' })).toBeTruthy()
  })

  test('a non-admin click sends nothing', async () => {
    const fetchMock = stubFetch(200)
    const { getByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: false, protocolId: 'p-1' },
    })
    await fireEvent.click(getByRole('button', { name: 'Anna Beispiel: anwesend' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a second click while a save is in flight does not send a second request', async () => {
    let release: (r: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { release = res }))
    vi.stubGlobal('fetch', fetchMock)
    const { getByRole } = render(AttendanceChips, {
      props: { entries: entries(), isAdmin: true, protocolId: 'p-1' },
    })
    const chip = getByRole('button', { name: 'Anna Beispiel: anwesend' })
    await fireEvent.click(chip)
    await fireEvent.click(chip)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release(new Response('{}', { status: 200 }))
    await waitFor(() => expect(getByRole('button', { name: 'Anna Beispiel: abwesend' })).toBeTruthy())
  })
})
