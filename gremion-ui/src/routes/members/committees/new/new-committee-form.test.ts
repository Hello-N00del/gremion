import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import Page from './+page.svelte'

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }))
vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('https://pilot.test/members/committees/new') } }))

// The kinds come from the customer's catalogue and the parent list follows the chosen kind's own
// allowedParentKinds: the same rule the server applies on submit.
const kinds = [
  { key: 'council', label: 'Gremium', canBeRoot: true, allowedParentKinds: [] },
  { key: 'committee', label: 'Referat', canBeRoot: false, allowedParentKinds: ['council', 'committee'] },
  { key: 'group', label: 'Gruppe', canBeRoot: true, allowedParentKinds: ['council', 'committee', 'group'] },
]
const parents = [
  { id: 'ou-1', name: 'Fachschaftsrat', kind: 'council' },
  { id: 'ou-2', name: 'Referat Finanzen', kind: 'committee' },
  { id: 'ou-3', name: 'Lesekreis', kind: 'group' },
]
// Display labels some units of this customer carry instead of their kind's label.
const kindLabels = ['AG', 'Fachschaft', 'Initiative', 'Vorstand']

function mount() {
  return render(Page, { props: { data: { kinds, parents, kindLabels } as never, form: null } })
}
const optionNames = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent?.trim())

afterEach(() => cleanup())

describe('new unit form', () => {
  it('offers every kind of the catalogue as "Art"', () => {
    mount()
    expect(optionNames(screen.getByLabelText('Art'))).toEqual(['Gremium', 'Referat', 'Gruppe'])
  })

  it('lists as parents exactly the units whose kind the chosen kind accepts, and follows a change of kind', async () => {
    mount()
    const art = screen.getByLabelText('Art') as HTMLSelectElement
    await fireEvent.change(art, { target: { value: 'committee' } })
    expect(optionNames(screen.getByLabelText(/Übergeordnete Einheit/))).toEqual(['— bitte wählen —', 'Fachschaftsrat', 'Referat Finanzen'])
    await fireEvent.change(art, { target: { value: 'group' } })
    // a group may sit under a group, and may stay at the top
    expect(optionNames(screen.getByLabelText(/Übergeordnete Einheit/))).toEqual(['— keine —', 'Fachschaftsrat', 'Referat Finanzen', 'Lesekreis'])
  })

  it('a kind that cannot be a root has no "keine" option and requires a parent', async () => {
    mount()
    await fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'committee' } })
    const parent = screen.getByLabelText(/Übergeordnete Einheit/) as HTMLSelectElement
    expect(optionNames(parent)).not.toContain('— keine —')
    expect(parent.required).toBe(true)
  })

  it('a kind without any allowed parent shows no parent field', async () => {
    mount()
    await fireEvent.change(screen.getByLabelText('Art'), { target: { value: 'council' } })
    expect(screen.queryByLabelText(/Übergeordnete Einheit/)).toBeNull()
  })

  it('offers the display labels the customer already uses, as suggestions for an optional "Bezeichnung"', () => {
    const { container } = mount()
    const field = screen.getByLabelText(/Bezeichnung/) as HTMLInputElement
    expect(field.name).toBe('kindLabel')
    expect(field.required).toBe(false)
    expect(field.maxLength).toBe(40)
    const list = container.querySelector(`datalist#${field.getAttribute('list')}`)
    expect(Array.from(list?.querySelectorAll('option') ?? []).map((o) => o.getAttribute('value'))).toEqual(kindLabels)
  })

  it('names the two options in plain words, not after the subsystems', () => {
    const { container } = mount()
    expect(screen.getByRole('checkbox', { name: 'Chatraum anlegen' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Dateiordner anlegen' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/Matrix|Nextcloud/)
  })
})
