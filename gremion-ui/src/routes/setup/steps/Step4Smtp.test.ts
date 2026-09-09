import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'

// /api/setup/test-smtp has TWO in-repo consumers in this kernel, not one:
//   gremion-ui/src/routes/setup/steps/Step4Smtp.svelte   (first-run wizard, this file)
//   gremion-ui/src/routes/settings/tabs/TabEmail.svelte  (Settings → E-Mail, TabEmail.test.ts)
// Both must render the guard's 400 `hint`; a Settings-first operator otherwise
// dead-ends on the bare German refusal exactly as the wizard would.
// (`wizard-submit-schema.test.ts` also names the endpoint, but it is a test
// stub, not a UI surface.)
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ data: { brand: null } }) }
})

import Step4Smtp from './Step4Smtp.svelte'

const SMTP = {
  configured: false,
  host: 'mailpit',
  port: 1025,
  from_address: 'noreply@example.org',
  from_name: 'Gremion',
}

function mockTestSmtp(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The "plain text, not markup" pair below is worthless against a fixture that
// CONTAINS NO MARKUP: `{testHint}` and `{@html testHint}` render the same
// single text node for a plain string, so the whole file would pass with the
// component mutated to `{@html}`. The fixture therefore carries markup —
// `textContent` loses the tags and `querySelector('*')` finds an injected
// element the moment the component stops escaping.
const MARKUP_HINT =
  'Für einen internen Relay <b>SMTP_TEST_ALLOW_PRIVATE=1</b> setzen <img src="x">.'

describe('Step4Smtp.svelte — SMTP test result surface', () => {
  it('renders the operator hint that comes back with a refused target', async () => {
    vi.stubGlobal(
      'fetch',
      mockTestSmtp(400, {
        success: false,
        error: 'SMTP-Host ist keine erlaubte externe Adresse',
        hint: MARKUP_HINT,
      }),
    )

    render(Step4Smtp, { props: { smtp: SMTP, itAdminEmail: 'it@example.org' } })
    await fireEvent.click(screen.getByText('Test-E-Mail senden'))

    expect(await screen.findByText(/keine erlaubte externe Adresse/)).toBeTruthy()
    const hint = await screen.findByTestId('smtp-test-hint')
    // Plain text, not markup: the server string becomes one text node, tags
    // and all. Under `{@html}` the tags would vanish from textContent and the
    // <b>/<img> would exist as children.
    expect(hint.textContent).toBe(MARKUP_HINT)
    expect(hint.querySelector('*')).toBeNull()
    // a11y: a hint in a sibling <p> outside the refusal's live region means
    // assistive tech announces the refusal and stays silent about the one
    // sentence that says what to do. It must be inside the alert.
    expect(hint.closest('[role="alert"]')).not.toBeNull()
  })

  it('shows no hint when the failure carries none', async () => {
    vi.stubGlobal(
      'fetch',
      mockTestSmtp(200, { success: false, data: { success: false, error: 'ECONNREFUSED' } }),
    )

    render(Step4Smtp, { props: { smtp: SMTP, itAdminEmail: 'it@example.org' } })
    await fireEvent.click(screen.getByText('Test-E-Mail senden'))

    expect(await screen.findByText('ECONNREFUSED')).toBeTruthy()
    expect(screen.queryByTestId('smtp-test-hint')).toBeNull()
  })

  it('clears a previous hint when a later attempt succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ success: false, error: 'nope', hint: 'SMTP_TEST_ALLOW_PRIVATE=1' }),
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, data: { success: true } }), { status: 200 }),
        ),
    )

    render(Step4Smtp, { props: { smtp: SMTP, itAdminEmail: 'it@example.org' } })
    const button = screen.getByText('Test-E-Mail senden')

    await fireEvent.click(button)
    expect(await screen.findByTestId('smtp-test-hint')).toBeTruthy()

    await fireEvent.click(button)
    expect(await screen.findByText(/Verbindung erfolgreich/)).toBeTruthy()
    expect(screen.queryByTestId('smtp-test-hint')).toBeNull()
  })

  it('clears a stale hint when the next click returns on local validation', async () => {
    // With the early `if (!host || !fromAddress)` return ABOVE the reset block,
    // the previous attempt's refusal hint stays on screen beside a completely
    // unrelated "Host … erforderlich" error.
    vi.stubGlobal(
      'fetch',
      mockTestSmtp(400, { success: false, error: 'nope', hint: 'SMTP_TEST_ALLOW_PRIVATE=1' }),
    )

    render(Step4Smtp, { props: { smtp: SMTP, itAdminEmail: 'it@example.org' } })
    const button = screen.getByText('Test-E-Mail senden')

    await fireEvent.click(button)
    expect(await screen.findByTestId('smtp-test-hint')).toBeTruthy()

    await fireEvent.input(screen.getByLabelText('SMTP-Host *'), { target: { value: '' } })
    await fireEvent.click(button)

    expect(await screen.findByText(/Host und Absender-Adresse sind erforderlich/)).toBeTruthy()
    expect(screen.queryByTestId('smtp-test-hint')).toBeNull()
  })
})
