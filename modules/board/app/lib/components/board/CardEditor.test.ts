import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import CardEditor from './CardEditor.svelte'
import type { CardView, MemberOption } from './types'

const U_ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const U_BERT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBERS: MemberOption[] = [
  { id: U_ANNA, name: 'Anna Adler' },
  { id: U_BERT, name: 'Bert Berg' },
]

const CARD: CardView = {
  id: 'c1',
  stack_id: 's1',
  title: 'Plakate drucken',
  description: 'DIN A2, 40 Stück',
  due_date: '2026-12-01',
  label: null,
  sort_order: 0,
  protocol_action_item_id: null,
  created_by: null,
  created_at: new Date('2026-11-01T10:00:00Z'),
  assignee_name: 'Anna Adler',
  assignee_id: U_ANNA,
  is_mine: false,
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'c1' } }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(card: CardView = CARD, extra: { onclose?: () => void; onsaved?: () => void } = {}) {
  const onclose = extra.onclose ?? vi.fn()
  const onsaved = extra.onsaved ?? vi.fn()
  render(CardEditor, { boardId: 'b1', card, members: MEMBERS, onclose, onsaved })
  return { onclose, onsaved }
}

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string)

describe('the card editor as a modal dialog', () => {
  it('hands focus back to the control that opened it when it closes', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    open()
    expect(document.activeElement).toBe(screen.getByLabelText('Titel'))
    cleanup()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('keeps Tab inside the dialog: from the last control it wraps to the first, and back', async () => {
    open()
    const dialog = screen.getByRole('dialog')
    const cancel = screen.getByRole('button', { name: 'Abbrechen' })
    const first = screen.getByRole('button', { name: 'Schließen' })
    cancel.focus()
    await fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)
  })
})

describe('the card editor', () => {
  it('shows the card\'s title, description, assignee and due date', () => {
    open()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Titel')).toHaveValue('Plakate drucken')
    expect(screen.getByLabelText('Beschreibung')).toHaveValue('DIN A2, 40 Stück')
    expect(screen.getByLabelText('Zuständig')).toHaveValue(U_ANNA)
    // the date control takes and gives ISO; the browser shows it in the user's own format
    const due = screen.getByLabelText('Fällig am') as HTMLInputElement
    expect(due.type).toBe('date')
    expect(due.value).toBe('2026-12-01')
  })

  it('offers "Niemand" and exactly the committee members as assignees', () => {
    open()
    const options = [...(screen.getByLabelText('Zuständig') as HTMLSelectElement).options].map((o) => o.textContent?.trim())
    expect(options).toEqual(['Niemand', 'Anna Adler', 'Bert Berg'])
  })

  it('saves what changed with a PATCH to the cards route, then tells the page', async () => {
    const { onsaved } = open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Plakate und Flyer drucken' } })
    await fireEvent.change(screen.getByLabelText('Zuständig'), { target: { value: U_BERT } })
    await fireEvent.input(screen.getByLabelText('Fällig am'), { target: { value: '2026-12-15' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/board/b1/cards')
    expect(init.method).toBe('PATCH')
    // the description was not touched, so it is not sent; the date goes out as ISO
    expect(sentBody()).toEqual({
      cardId: 'c1',
      title: 'Plakate und Flyer drucken',
      assigneeKeycloakId: U_BERT,
      dueDate: '2026-12-15',
    })
  })

  it('clears the due date and the assignee with null', async () => {
    open()
    await fireEvent.input(screen.getByLabelText('Fällig am'), { target: { value: '' } })
    await fireEvent.change(screen.getByLabelText('Zuständig'), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody()).toEqual({ cardId: 'c1', assigneeKeycloakId: null, dueDate: null })
  })

  it('sends nothing and just closes when nothing changed', async () => {
    const { onclose, onsaved } = open()
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onsaved).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('does not save an empty title', async () => {
    open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: '   ' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Titel')
  })

  it('keeps the dialog open and says why when the server refuses (assignee not in the committee)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Die Person ist kein Mitglied dieses Gremiums' }), { status: 400 }))
    const { onsaved, onclose } = open()
    await fireEvent.change(screen.getByLabelText('Zuständig'), { target: { value: U_BERT } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('kein Mitglied'))
    expect(onsaved).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Titel')).toHaveValue('Plakate drucken')
  })

  it('keeps the dialog open on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    const { onsaved } = open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Neu' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(onsaved).not.toHaveBeenCalled()
  })

  it('closes on Abbrechen and on Escape without saving', async () => {
    const { onclose } = open()
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onclose).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The assignee left the committee: the card keeps the name, the picker has no entry for them.
  describe('a card whose assignee is no longer a member', () => {
    const former: CardView = { ...CARD, assignee_name: 'Gerda Gegangen', assignee_id: null }

    it('shows who it is assigned to and keeps that unless the member picks someone else', async () => {
      open(former)
      const select = screen.getByLabelText('Zuständig') as HTMLSelectElement
      expect(select.selectedOptions[0].textContent).toContain('Gerda Gegangen')
      await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Neu' } })
      await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(sentBody()).toEqual({ cardId: 'c1', title: 'Neu' })
    })

    it('can still be cleared with "Niemand"', async () => {
      open(former)
      await fireEvent.change(screen.getByLabelText('Zuständig'), { target: { value: '' } })
      await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(sentBody()).toEqual({ cardId: 'c1', assigneeKeycloakId: null })
    })
  })
})
