// src/routes/messages/manage/manage-page.test.ts
//
// TASK-009 fix round 2, MEDIUM (house review of B4): rename used the
// browser-native window.prompt() instead of an in-app affordance. This
// guards the replacement — an inline input + Speichern/Abbrechen, same
// shape as the sibling /messages Einstellungen panel — actually drives
// the PATCH call, and that window.prompt is never invoked.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/messages/manage'), data: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import Page from './+page.svelte'

const baseData = {
  matrix: 'reachable' as const,
  units: [
    { unitId: 'ou-1', unitName: 'Vorstand', state: 'aktiv' as const, roomId: '!vorstand:matrix.test' },
  ],
}

function renderPage(data: Partial<typeof baseData> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
  vi.stubGlobal('fetch', fetchMock)
  const utils = render(Page, { props: { data: { ...baseData, ...data } as never } })
  return { ...utils, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/messages/manage — rename (MEDIUM fix: in-app affordance, not window.prompt)', () => {
  it('never calls window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt')
    renderPage()
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })

  it('Umbenennen opens an inline input (no native prompt) and Speichern PATCHes the new name', async () => {
    const { getByText, getByLabelText, fetchMock } = renderPage()
    await fireEvent.click(getByText('Umbenennen'))
    const input = getByLabelText('Neuer Raumname') as HTMLInputElement
    expect(input.value).toBe('Vorstand')
    await fireEvent.input(input, { target: { value: 'Vorstand (neu)' } })
    await fireEvent.click(getByText('Speichern'))

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/messages/rooms/${encodeURIComponent('!vorstand:matrix.test')}`,
      expect.objectContaining({ method: 'PATCH' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body).toEqual({ orgUnitId: 'ou-1', name: 'Vorstand (neu)' })
  })

  it('Abbrechen discards the edit without calling fetch', async () => {
    const { getByText, queryByLabelText, fetchMock } = renderPage()
    await fireEvent.click(getByText('Umbenennen'))
    await fireEvent.click(getByText('Abbrechen'))
    expect(queryByLabelText('Neuer Raumname')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
