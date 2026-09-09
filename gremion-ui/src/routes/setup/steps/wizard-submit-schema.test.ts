import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { configUpdateSchema } from '$lib/server/config'

// Step4Smtp reads $page.data.brand (resolveBrand's placeholder-name fallback).
// Outside a real SvelteKit router context $page has no value, so stub it —
// resolveBrand() itself already tolerates a missing/null brand.
vi.mock('$app/stores', () => ({
  page: readable({ data: {} }),
}))
import Step1Health from './Step1Health.svelte'
import Step2Org from './Step2Org.svelte'
import Step3Admins from './Step3Admins.svelte'
import Step4Smtp from './Step4Smtp.svelte'
import Step5Done from './Step5Done.svelte'
import StepBrandLegal from './StepBrandLegal.svelte'

// audit #425 (gremion HIGH): every setup-wizard step PATCHes
// /api/setup/config with a body it builds itself, independent of the kernel
// schema. Step2Org drifted — it sent `calendar: { german_state }`, a slot the
// carved-down governance-only kernel's gremionConfigSchema does not carry — and
// `configUpdateSchema`'s `.strict()` rejected it with a 422, wedging
// first-run provisioning behind an error banner forever. This suite drives
// every step's REAL submit path against a mocked fetch and asserts the
// captured PATCH body parses under the real, imported schema, so a future
// carved-key drift in any step fails a unit test instead of production.

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 422, json: async () => body } as Response
}

/**
 * Stubs global fetch, routing the handful of endpoints the wizard steps call
 * during their submit flow, and records every body PATCHed to
 * /api/setup/config for the caller to assert on.
 */
function mockSetupFetch(): unknown[] {
  const patchBodies: unknown[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/setup/health') {
      return jsonResponse({
        data: {
          services: { postgres: 'healthy', keycloak: 'healthy', redis: 'healthy' },
          can_proceed: true,
        },
      })
    }
    if (url === '/api/setup/admins' && method === 'POST') {
      return jsonResponse({ success: true })
    }
    if (url === '/api/setup/test-smtp' && method === 'POST') {
      return jsonResponse({ success: true })
    }
    if (url === '/api/setup/config' && method === 'PATCH') {
      patchBodies.push(JSON.parse(init!.body as string))
      return jsonResponse({ success: true, data: {} })
    }
    if (url === '/api/setup/config' && method === 'GET') {
      return jsonResponse({
        data: {
          org: { name: '', domain: '', logo_path: null },
          admin_accounts: { it_admin_created: false, council_admin_created: false },
          smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
        },
      })
    }
    throw new Error(`unmocked fetch in wizard-submit-schema.test: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return patchBodies
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('setup wizard steps — advance() PATCH payloads vs the real configUpdateSchema', () => {
  test('Step1Health', async () => {
    const patches = mockSetupFetch()
    const { getByRole } = render(Step1Health)
    const weiter = getByRole('button', { name: 'Weiter' })
    await waitFor(() => expect(weiter).not.toBeDisabled())
    await fireEvent.click(weiter)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
  })

  test('Step2Org — no longer sends the carved-out calendar key', async () => {
    const patches = mockSetupFetch()
    const { getByLabelText, container } = render(Step2Org, {
      props: { org: { name: '', domain: '', logo_path: null }, deploymentMode: 'single' },
    })
    await fireEvent.input(getByLabelText(/Name der Verfassten Studierendenschaft/), {
      target: { value: 'Testrat' },
    })
    await fireEvent.input(getByLabelText(/Kürzel · Domain/), {
      target: { value: 'stura.example.de' },
    })
    await fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).not.toHaveProperty('calendar')
    expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
  })

  test('Step3Admins', async () => {
    const patches = mockSetupFetch()
    const { container } = render(Step3Admins)
    await fireEvent.input(container.querySelector<HTMLInputElement>('#it-email')!, {
      target: { value: 'it@example.de' },
    })
    await fireEvent.input(container.querySelector<HTMLInputElement>('#it-password')!, {
      target: { value: 'password123' },
    })
    await fireEvent.input(container.querySelector<HTMLInputElement>('#council-email')!, {
      target: { value: 'council@example.de' },
    })
    await fireEvent.input(container.querySelector<HTMLInputElement>('#council-password')!, {
      target: { value: 'password123' },
    })
    await fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
  })

  test('Step4Smtp', async () => {
    const patches = mockSetupFetch()
    const { container } = render(Step4Smtp, {
      props: {
        smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
        itAdminEmail: 'it@example.de',
      },
    })
    await fireEvent.input(container.querySelector<HTMLInputElement>('#smtp-host')!, {
      target: { value: 'smtp.example.de' },
    })
    await fireEvent.input(container.querySelector<HTMLInputElement>('#smtp-from')!, {
      target: { value: 'noreply@example.de' },
    })
    await fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
  })

  test('Step5Done', async () => {
    const patches = mockSetupFetch()
    // Step5Done redirects via `window.location.href = '/users'` on success.
    // jsdom does not implement real navigation, so assigning `href` logs a
    // noisy "Not implemented: navigation to another Document" console error.
    // Stub `window.location` with a plain writable object so the assignment
    // is a harmless no-op instead — restored in the finally below regardless
    // of assertion outcome.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    })
    try {
      const { getByRole } = render(Step5Done, { props: { goLiveReady: true } })
      await fireEvent.click(getByRole('button', { name: 'Setup abschliessen' }))
      await waitFor(() => expect(patches).toHaveLength(1))
      expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
      expect(window.location.href).toBe('/users')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
    }
  })

  test('StepBrandLegal', async () => {
    const patches = mockSetupFetch()
    const { getByLabelText, container } = render(StepBrandLegal, {
      props: {
        brand: { product: '', palette: null },
        legal: {
          datenschutz_html: 'Echter Text',
          impressum_html: 'Echter Text',
          barrierefreiheit_html: 'Echter Text',
        },
      },
    })
    await fireEvent.input(getByLabelText(/Produktname/), { target: { value: 'Musterstadt' } })
    await fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(() => configUpdateSchema.parse(patches[0])).not.toThrow()
  })
})
