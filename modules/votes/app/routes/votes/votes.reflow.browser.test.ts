import '../../app.css'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'

/**
 * Reflow regression (R25-FX, UX-071a AC-1 / WCAG 1.4.10) for /votes at
 * 320/390 px — council-admin session only (the live test env's TASK-209
 * spec, deploy dd432250, reports it there but not for a plain member): the
 * page's `.head-actions` row has no `flex-wrap`, and for a manager/admin
 * session it holds THREE non-wrapping items (the Helios status pill, "Neue
 * Schnellumfrage" and "Neue Abstimmung") instead of the member's one, which
 * do not fit 320/390 px. The overflow amount is CONSTANT regardless of
 * viewport (84 px at 320, 14 px at 390 — the same ~404 px content width both
 * times), the signature of a fixed set of non-shrinking inline items rather
 * than anything proportional.
 */
const h = vi.hoisted(() => ({ pageData: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/votes'),
    get data() {
      return h.pageData
    },
  },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_HELIOS_URL: '' } }))
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/messages/de.json')).default as Record<string, string>
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})

import Page from './+page.svelte'

const baseData = {
  votes: [],
  // The real label ($lib/votes/helios-status.ts deriveHeliosStatus), not a
  // shortened stand-in — this is what actually sits in `.head-actions`.
  heliosStatus: { tone: 'success' as const, icon: 'check', label: 'Helios verbunden' },
  pollErrors: null,
  isManager: true,
}

async function mountAt(width: number) {
  await vpage.viewport(width, 640)
  h.pageData = { brand: {} }
  const host = document.createElement('div')
  host.id = 'reflow-host'
  host.style.cssText = 'width: 100%; padding: 0 16px; box-sizing: border-box;'
  document.body.append(host)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = render(Page, { props: { data: baseData } as any, target: host })
  return { ...r, host }
}

function overflow(host: HTMLElement): number {
  return host.scrollWidth - host.clientWidth
}

afterEach(() => {
  cleanup()
  document.getElementById('reflow-host')?.remove()
})

describe('/votes — reflow at 320/390 px (R25-FX, council admin)', () => {
  test.each([320, 390])('%i px: the status pill + two manager actions never push the page past the viewport', async (w) => {
    const { host } = await mountAt(w)
    expect(overflow(host)).toBeLessThanOrEqual(0)
  })
})
