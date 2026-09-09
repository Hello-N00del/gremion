import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'

// The SECOND consumer of /api/setup/test-smtp:
//   gremion-ui/src/routes/setup/steps/Step4Smtp.svelte   (first-run wizard)
//   gremion-ui/src/routes/settings/tabs/TabEmail.svelte  (Settings → E-Mail, this file)
// Shipping the `hint` rendering to the wizard only leaves an operator who
// reaches SMTP through Settings dead-ending on the bare German refusal.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ data: { brand: null } }) }
})

import TabEmail from './TabEmail.svelte'

const SMTP = {
  configured: false,
  host: 'mailpit',
  port: 1025,
  from_address: 'noreply@example.org',
  from_name: 'Gremion',
}

function testButton() {
  return screen.getByRole('button', { name: 'Test-E-Mail senden' })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The "plain text, not markup" pair below is worthless against a fixture that
// CONTAINS NO MARKUP: `{testHint}` and `{@html testHint}` render the same
// single text node for a plain string. The fixture therefore carries markup —
// `textContent` loses the tags and `querySelector('*')` finds an injected
// element the moment the component stops escaping.
const MARKUP_HINT =
  'Für einen internen Relay <b>SMTP_TEST_ALLOW_PRIVATE=1</b> setzen <img src="x">.'

describe('TabEmail.svelte — SMTP test result surface', () => {
  it('renders the operator hint that comes back with a refused target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: 'SMTP-Host ist keine erlaubte externe Adresse',
              hint: MARKUP_HINT,
            }),
            { status: 400 },
          ),
      ),
    )

    render(TabEmail, { props: { smtp: SMTP } })
    await fireEvent.click(testButton())

    expect(await screen.findByText(/keine erlaubte externe Adresse/)).toBeTruthy()
    const hint = await screen.findByTestId('smtp-test-hint')
    // Plain text, not markup: whatever the server put in `hint` is rendered as
    // its own text node, tags and all, so a server string can never inject an
    // element here. Under `{@html}` both assertions below flip.
    expect(hint.textContent).toBe(MARKUP_HINT)
    expect(hint.querySelector('*')).toBeNull()
    // a11y: the hint is the remediation for the refusal, so it must sit inside
    // the same live region the refusal is announced from — an aria-silent hint
    // is invisible to exactly the operator who needs it read out.
    expect(hint.closest('[role="alert"]')).not.toBeNull()
  })

  it('shows no hint when the failure carries none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, data: { success: false, error: 'ECONNREFUSED' } }),
            { status: 200 },
          ),
      ),
    )

    render(TabEmail, { props: { smtp: SMTP } })
    await fireEvent.click(testButton())

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

    render(TabEmail, { props: { smtp: SMTP } })

    await fireEvent.click(testButton())
    expect(await screen.findByTestId('smtp-test-hint')).toBeTruthy()

    await fireEvent.click(testButton())
    expect(await screen.findByText(/erfolgreich gesendet/)).toBeTruthy()
    expect(screen.queryByTestId('smtp-test-hint')).toBeNull()
  })

  it('clears a stale hint when the next click returns on local validation', async () => {
    // With the early `if (!host || !fromAddress)` return never reaching the
    // reset block, a refusal hint from the previous attempt stays on screen
    // next to a completely unrelated "Host … erforderlich" error.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: 'nope', hint: 'SMTP_TEST_ALLOW_PRIVATE=1' }),
            { status: 400 },
          ),
      ),
    )

    render(TabEmail, { props: { smtp: SMTP } })
    await fireEvent.click(testButton())
    expect(await screen.findByTestId('smtp-test-hint')).toBeTruthy()

    await fireEvent.input(screen.getByLabelText('SMTP-Host'), { target: { value: '' } })
    await fireEvent.click(testButton())

    expect(await screen.findByText(/Host und Absender-Adresse sind erforderlich/)).toBeTruthy()
    expect(screen.queryByTestId('smtp-test-hint')).toBeNull()
  })
})
