import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'

// TabAccessibility reads the current page for the language form's redirect target; a plain URL is
// all it needs.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/darstellung'), form: null } }))

import TabAccessibility from './TabAccessibility.svelte'

// The rest of the app addresses people with "Sie". The Darstellung tab used the informal "du"
// ("deine Sehbedingungen", "Wähle ...", "wenn du ..."), which reads as a different voice.

describe('Darstellung & Barrierefreiheit — formal address', () => {
  const text = () => render(TabAccessibility).container.textContent ?? ''

  it('uses no informal du-forms anywhere on the tab', () => {
    const informal = /\b(du|dein|deine|deinen|deinem|deiner|deines|dir|dich|wähle|reduziere|passe|lege)\b/i
    expect(text().match(informal)).toBeNull()
  })

  it('addresses the reader with Sie / Ihr', () => {
    const t = text()
    expect(t).toContain('Ihre Sehbedingungen')
    expect(t).toContain('Ihrem Gerät')
    expect(t).toContain('Wählen Sie zwischen hellem und dunklem Modus.')
    expect(t).toContain('Reduzieren Sie Bewegungseffekte, wenn Sie empfindlich auf Animationen reagieren.')
  })
})
