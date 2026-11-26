import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/darstellung'), form: null } }))

import TabAccessibility from './TabAccessibility.svelte'
import { themeMode, fontSize } from '$lib/stores/theme'

// The Darstellung options are choices of one out of several. A screen reader user needs to hear
// which option is on (pressed state) and which setting a group of options belongs to (group name).

describe('Darstellung - accessible names and state', () => {
  it('the light/dark options announce which one is on', async () => {
    themeMode.set('light')
    render(TabAccessibility)
    const group = screen.getByRole('group', { name: 'Erscheinungsbild' })
    expect(within(group).getByRole('button', { name: 'Hell', pressed: true })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Dunkel', pressed: false })).toBeTruthy()
    await fireEvent.click(within(group).getByRole('button', { name: 'Dunkel' }))
    expect(within(group).getByRole('button', { name: 'Dunkel', pressed: true })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Hell', pressed: false })).toBeTruthy()
    themeMode.set('light')
  })

  it('the font size options announce which one is on', async () => {
    fontSize.set('normal')
    render(TabAccessibility)
    const group = screen.getByRole('group', { name: 'Schriftgröße' })
    expect(within(group).getByRole('button', { name: 'Normal', pressed: true })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Groß', pressed: false })).toBeTruthy()
    await fireEvent.click(within(group).getByRole('button', { name: 'Sehr groß' }))
    expect(within(group).getByRole('button', { name: 'Sehr groß', pressed: true })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Normal', pressed: false })).toBeTruthy()
    fontSize.set('normal')
  })

  it('the colour vision options are a named radio group, each radio named by its label', () => {
    render(TabAccessibility)
    const group = screen.getByRole('radiogroup', { name: 'Farbsehkorrektur' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    for (const r of radios) expect((r as HTMLInputElement).labels?.[0]?.textContent?.trim()).toBeTruthy()
    expect(within(group).getAllByRole('radio', { checked: true })).toHaveLength(1)
  })

  it('the language options keep a name and a pressed state', () => {
    render(TabAccessibility)
    const group = screen.getByRole('group', { name: 'Sprache' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(expect.arrayContaining(['true', 'false']))
  })

  it('the motion option has a name', () => {
    render(TabAccessibility)
    expect(screen.getByRole('checkbox', { name: 'Animationen reduzieren' })).toBeTruthy()
  })
})
