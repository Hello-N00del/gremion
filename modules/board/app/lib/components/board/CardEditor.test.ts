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
    // the due date reads in German order whatever the browser language is; the data stays ISO
    const due = screen.getByLabelText('Fällig am') as HTMLInputElement
    expect(due.type).toBe('text')
    expect(due.value).toBe('01.12.2026')
    expect(due.placeholder).toBe('TT.MM.JJJJ')
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
    await fireEvent.input(screen.getByLabelText('Fällig am'), { target: { value: '15.12.2026' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/board/b1/cards')
    expect(init.method).toBe('PATCH')
    // the description was not touched, so it is not sent; the date was typed in German order and goes out as ISO
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

  it('reads a date typed without leading zeros and tidies it when the field is left', async () => {
    open()
    const due = screen.getByLabelText('Fällig am') as HTMLInputElement
    await fireEvent.input(due, { target: { value: '5.1.2027' } })
    await fireEvent.blur(due)
    expect(due.value).toBe('05.01.2027')
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody()).toEqual({ cardId: 'c1', dueDate: '2027-01-05' })
  })

  // A text that is no date must never reach the server as "no due date": that would silently
  // remove the date the card already has.
  it.each(['31.02.2026', '12/15/2026', '2026-12-15', 'morgen'])('does not save "%s" as a due date and says which format it wants', async (typed) => {
    const { onsaved, onclose } = open()
    const due = screen.getByLabelText('Fällig am')
    await fireEvent.input(due, { target: { value: typed } })
    expect(due).toHaveAttribute('aria-invalid', 'true')
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onsaved).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('TT.MM.JJJJ')
  })

  it('saves again once the date is corrected', async () => {
    open()
    const due = screen.getByLabelText('Fällig am')
    await fireEvent.input(due, { target: { value: '31.02.2026' } })
    await fireEvent.input(due, { target: { value: '28.02.2026' } })
    expect(due).not.toHaveAttribute('aria-invalid')
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody()).toEqual({ cardId: 'c1', dueDate: '2026-02-28' })
  })

  // The calendar button opens the browser's own picker as a convenience; what it picks is shown
  // in German order like a typed date.
  it('takes a day picked in the calendar and shows it in German order', async () => {
    const { container } = render(CardEditor, { boardId: 'b1', card: CARD, members: MEMBERS, onclose: vi.fn(), onsaved: vi.fn() })
    expect(screen.getByRole('button', { name: 'Fälligkeit im Kalender wählen' })).toBeInTheDocument()
    const native = container.querySelector('input[type="date"]') as HTMLInputElement
    // the native control is a helper only: out of the tab order and hidden from assistive tech
    expect(native).toHaveAttribute('aria-hidden', 'true')
    expect(native.tabIndex).toBe(-1)
    await fireEvent.change(native, { target: { value: '2026-12-24' } })
    expect(screen.getByLabelText('Fällig am')).toHaveValue('24.12.2026')
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody()).toEqual({ cardId: 'c1', dueDate: '2026-12-24' })
  })

  it('shows an empty date field for a card without a due date and sends nothing for it', async () => {
    open({ ...CARD, due_date: null })
    expect(screen.getByLabelText('Fällig am')).toHaveValue('')
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Neu' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody()).toEqual({ cardId: 'c1', title: 'Neu' })
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
