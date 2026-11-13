// @vitest-environment node
//
// Settings > Profil renders the name form and the account-action buttons in the
// SERVER-rendered HTML (plain form POSTs, no JavaScript needed), never links to the
// Keycloak account console, shows the e-mail button only when the server says the
// action is available, and says plainly what happened when the user comes back
// cancelled from Keycloak.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/profil'), form: null, data: {} }) }
})

const pageState = vi.hoisted(() => ({ page: { url: new URL('https://pilot.test/settings/profil'), form: null as unknown } }))
vi.mock('$app/state', () => pageState)

const base = {
  config: null,
  isAdmin: false,
  isITAdmin: false,
  loeschkonzept: null,
  user: { name: 'Anna Alt', email: 'anna@example.org', groups: [] },
  mfaEnrolled: null,
  stepUpEnforced: false,
  profile: { firstName: 'Anna', lastName: 'Alt', email: 'anna@example.org' },
  emailActionAvailable: false,
  accountActionResult: null,
}

function html(over: Record<string, unknown> = {}, form: unknown = null): string {
  pageState.page.form = form
  return render(SettingsBody, { props: { data: { ...base, ...over } as never } }).body
}

describe('Settings > Profil (server-rendered)', () => {
  test('the name form posts to the profileName action, prefilled from Keycloak', () => {
    const body = html()
    expect(body).toMatch(/<form[^>]*method="POST"[^>]*action="\/settings\?\/profileName"/)
    expect(body).toMatch(/<input[^>]*name="firstName"[^>]*value="Anna"/)
    expect(body).toMatch(/<input[^>]*name="lastName"[^>]*value="Alt"/)
    expect(body).toContain('Namen speichern')
  })

  test('the name form carries no user id field: the target is the session user', () => {
    const body = html()
    expect(body).not.toMatch(/name="(id|userId|sub|email|username|enabled|attributes)"/)
  })

  test('a failed save echoes what was typed and says why', () => {
    const body = html({}, { profileName: { error: 'invalid', errors: { firstName: 'invalid' }, values: { firstName: '', lastName: 'Neu' } } })
    expect(body).toMatch(/<input[^>]*name="lastName"[^>]*value="Neu"/)
    expect(body).toContain('role="alert"')
    expect(body).toContain('1 bis 80 Zeichen')
  })

  test('a name with a character Keycloak refuses says which characters, not "try later"', () => {
    const body = html({}, { profileName: { error: 'invalid', errors: { lastName: 'chars' }, values: { firstName: 'Anna', lastName: 'Alt (Vertretung)' } } })
    expect(body).toContain('Zeichen, die nicht erlaubt sind')
    expect(body).toMatch(/<input[^>]*name="lastName"[^>]*value="Alt \(Vertretung\)"/)
    expect(body).not.toContain('später erneut')
    const fallback = html({}, { profileName: { error: 'chars', values: { firstName: 'Anna', lastName: 'Neu' } } })
    expect(fallback).toContain('Zeichen, die nicht erlaubt sind')
  })

  test('a saved name says honestly when the rest of the app shows it', () => {
    const body = html({}, { profileName: { saved: true } })
    expect(body).toContain('Gespeichert.')
    expect(body).toContain('nach Ihrer nächsten Anmeldung')
  })

  test('shows the name from Keycloak in the card, not the older session name', () => {
    const body = html({ profile: { firstName: 'Anna Maria', lastName: 'Neu', email: 'anna@example.org' } })
    expect(body).toContain('Anna Maria Neu')
  })

  test('password and one-time-code buttons are real submit buttons of the accountAction form', () => {
    const body = html()
    expect(body).toMatch(/<form[^>]*method="POST"[^>]*action="\/settings\?\/accountAction"/)
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*name="action"[^>]*value="password"[^>]*>Passwort ändern/)
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*name="action"[^>]*value="totp"[^>]*>Zwei-Faktor-Code neu einrichten/)
  })

  test('the e-mail button is hidden unless the server says the action is available', () => {
    expect(html({ emailActionAvailable: false })).not.toContain('E-Mail-Adresse ändern')
    expect(html({ emailActionAvailable: undefined })).not.toContain('E-Mail-Adresse ändern')
    const on = html({ emailActionAvailable: true })
    expect(on).toMatch(/<button[^>]*name="action"[^>]*value="email"[^>]*>E-Mail-Adresse ändern/)
  })

  test('no link to the Keycloak account console remains', () => {
    const body = html({ emailActionAvailable: true })
    expect(body).not.toMatch(/href="[^"]*\/account(\/|"|\?)/)
    expect(body).not.toContain('Profil bearbeiten')
  })

  test('the cancelled return is explained and keeps the session', () => {
    const body = html({ accountActionResult: { action: 'UPDATE_PASSWORD', status: 'cancelled' } })
    expect(body).toContain('Das Passwort wurde nicht geändert')
    expect(body).toContain('Ihre Anmeldung bleibt bestehen')
    expect(body).toContain('role="alert"')
  })

  test('the error return is explained', () => {
    const body = html({ accountActionResult: { action: 'CONFIGURE_TOTP', status: 'error' } })
    expect(body).toContain('Der Zwei-Faktor-Code konnte nicht geändert werden')
  })

  test('a success return is a status, not an alert', () => {
    const body = html({ accountActionResult: { action: 'UPDATE_PASSWORD', status: 'success' } })
    expect(body).toContain('Ihr Passwort wurde geändert.')
    expect(body).toMatch(/role="status"[^>]*>[^<]*Ihr Passwort wurde geändert/)
  })

  test('without readable Keycloak data the form is hidden, the buttons stay', () => {
    const body = html({ profile: null })
    expect(body).not.toContain('Namen speichern')
    expect(body).toContain('Passwort ändern')
  })

  test('another section shows none of it', () => {
    pageState.page.form = null
    const body = render(SettingsBody, { props: { data: base as never, activeSection: 'darstellung' } }).body
    expect(body).not.toContain('Namen speichern')
  })
})
