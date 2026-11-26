import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import Page from './+page.svelte'

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }))
vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('https://pilot.test/members/committees/new') } }))

// The kinds come from the customer's catalogue and the parent list follows the chosen kind's own
// allowedParentKinds: the same rule the server applies on submit.
const kinds = [
  { key: 'council', label: 'Gremium', canBeRoot: true, allowedParentKinds: [] },
  { key: 'referat', label: 'Referat', canBeRoot: false, allowedParentKinds: ['council'] },
  { key: 'ag', label: 'AG', canBeRoot: false, allowedParentKinds: ['referat', 'council'] },
  { key: 'group', label: 'Gruppe', canBeRoot: true, allowedParentKinds: ['council', 'referat', 'group'] },
]
const parents = [
  { id: 'ou-1', name: 'Fachschaftsrat', kind: 'council' },
  { id: 'ou-2', name: 'Referat Finanzen', kind: 'referat' },
  { id: 'ou-3', name: 'Lesekreis', kind: 'group' },
]

function mount() {
  return render(Page, { props: { data: { kinds, parents } as never, form: null } })
}
const optionNames = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent?.trim())

afterEach(() => cleanup())

describe('new unit form', () => {
  it('offers every kind of the catalogue as "Art"', () => {
    mount()
    expect(optionNames(screen.getByLabelText('Art'))).toEqual(['Gremium', 'Referat', 'AG', 'Gruppe'])
  })

  it('lists as parents exactly the units whose kind the chosen kind accepts, and follows a change of kind', async () => {
    mount()
    const art = screen.getByLabelText('Art') as HTMLSelectElement
    await fireEvent.change(art, { target: { value: 'referat' } })
    expect(optionNames(screen.getByLabelText(/Übergeordnete Einheit/))).toEqual(['— bitte wählen —', 'Fachschaftsrat'])
    await fireEvent.change(art, { target: { value: 'ag' } })
    expect(optionNames(screen.getByLabelText(/Übergeordnete Einheit/))).toEqual(['— bitte wählen —', 'Fachschaftsrat', 'Referat Finanzen'])
    await fireEvent.change(art, { target: { value: 'group' } })
    // a group may sit under a group, and may stay at the top
    expect(optionNames(screen.getByLabelText(/Übergeordnete Einheit/))).toEqual(['— keine —', 'Fachschaftsrat', 'Referat Finanzen', 'Lesekreis'])
  })

  it('a kind that cannot be a root has no "keine" option and requires a parent', async () => {
    mount()
    await fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'referat' } })
    const parent = screen.getByLabelText(/Übergeordnete Einheit/) as HTMLSelectElement
    expect(optionNames(parent)).not.toContain('— keine —')
    expect(parent.required).toBe(true)
  })

  it('a kind without any allowed parent shows no parent field', async () => {
    mount()
    await fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'council' } })
    expect(screen.queryByLabelText(/Übergeordnete Einheit/)).toBeNull()
  })

  it('names the two options in plain words, not after the subsystems', () => {
    const { container } = mount()
    expect(screen.getByRole('checkbox', { name: 'Chatraum anlegen' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Dateiordner anlegen' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/Matrix|Nextcloud/)
  })

  it('the submit button has an accessible name', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Erstellen' })).toBeTruthy()
  })
})
